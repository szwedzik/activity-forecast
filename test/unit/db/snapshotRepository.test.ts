import { beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/adapters/db/database.js';
import { openDatabase } from '../../../src/adapters/db/database.js';
import { createLocationRepository } from '../../../src/adapters/db/locationRepository.js';
import type {
  NewSnapshot,
  SnapshotRepository,
  SnapshotSource,
} from '../../../src/adapters/db/snapshotRepository.js';
import { createSnapshotRepository } from '../../../src/adapters/db/snapshotRepository.js';
import type { NewLocation } from '../../../src/domain/location.js';

const PLACE: NewLocation = {
  geonamesId: 1,
  name: 'Lisbon',
  latitude: 38.7,
  longitude: -9.1,
  timezone: 'Europe/Lisbon',
};

describe('the snapshot repository', () => {
  let db: Database;
  let repository: SnapshotRepository;
  let locationId: number;
  let otherId: number;

  const snapshot = (overrides: Partial<NewSnapshot> = {}): NewSnapshot => ({
    locationId,
    source: 'weather',
    status: 'ok',
    fetchedAt: '2026-09-14T09:00:00.000Z',
    firstDate: '2026-09-14',
    lastDate: '2026-09-21',
    gridLatitude: 38.75,
    gridLongitude: -9.125,
    gridElevationM: 54,
    payload: '{"hourly":{}}',
    ...overrides,
  });

  beforeEach(() => {
    db = openDatabase(':memory:');
    const locations = createLocationRepository(db);
    locationId = locations.upsertLocation(PLACE, '2026-09-14T00:00:00.000Z').rowId;
    otherId = locations.upsertLocation({ ...PLACE, geonamesId: 2, name: 'Denver' }, '2026-09-14T00:00:00.000Z').rowId;
    repository = createSnapshotRepository(db);
  });

  it('stores a snapshot and reads it back whole', () => {
    const stored = repository.insert(snapshot());

    expect(stored.id).toBeGreaterThan(0);
    expect(stored).toMatchObject({
      locationId,
      source: 'weather',
      status: 'ok',
      fetchedAt: '2026-09-14T09:00:00.000Z',
      firstDate: '2026-09-14',
      gridLatitude: 38.75,
      payload: '{"hourly":{}}',
    });
  });

  it('stores an unavailable answer, which carries no payload and no dates', () => {
    // Inland, there is no wave model. Remembering that is the point (D§6.1).
    const stored = repository.insert(
      snapshot({
        source: 'marine',
        status: 'unavailable',
        firstDate: undefined,
        lastDate: undefined,
        gridLatitude: undefined,
        gridLongitude: undefined,
        gridElevationM: undefined,
        payload: undefined,
      }),
    );

    expect(stored.status).toBe('unavailable');
    expect(stored.payload).toBeUndefined();
    expect(stored.firstDate).toBeUndefined();
  });

  it('has nothing to return before anything is stored', () => {
    expect(repository.getLatest(locationId, 'weather')).toBeUndefined();
  });

  it('returns the newest snapshot for a location and source', () => {
    repository.insert(snapshot({ fetchedAt: '2026-09-14T06:00:00.000Z' }));
    repository.insert(snapshot({ fetchedAt: '2026-09-14T12:00:00.000Z' }));
    repository.insert(snapshot({ fetchedAt: '2026-09-14T09:00:00.000Z' }));

    expect(repository.getLatest(locationId, 'weather')?.fetchedAt).toBe('2026-09-14T12:00:00.000Z');
  });

  it('keeps weather and marine apart', () => {
    repository.insert(snapshot({ source: 'weather', fetchedAt: '2026-09-14T06:00:00.000Z' }));
    repository.insert(snapshot({ source: 'marine', fetchedAt: '2026-09-14T12:00:00.000Z' }));

    expect(repository.getLatest(locationId, 'weather')?.fetchedAt).toBe('2026-09-14T06:00:00.000Z');
    expect(repository.getLatest(locationId, 'marine')?.fetchedAt).toBe('2026-09-14T12:00:00.000Z');
  });

  it('keeps locations apart', () => {
    repository.insert(snapshot({ locationId, fetchedAt: '2026-09-14T06:00:00.000Z' }));
    repository.insert(snapshot({ locationId: otherId, fetchedAt: '2026-09-14T12:00:00.000Z' }));

    expect(repository.getLatest(locationId, 'weather')?.fetchedAt).toBe('2026-09-14T06:00:00.000Z');
    expect(repository.getLatest(otherId, 'weather')?.fetchedAt).toBe('2026-09-14T12:00:00.000Z');
  });

  it('breaks a tie on insertion order, so the last write wins', () => {
    repository.insert(snapshot({ fetchedAt: '2026-09-14T09:00:00.000Z', payload: 'first' }));
    repository.insert(snapshot({ fetchedAt: '2026-09-14T09:00:00.000Z', payload: 'second' }));

    expect(repository.getLatest(locationId, 'weather')?.payload).toBe('second');
  });
});

describe('pruning', () => {
  let db: Database;
  let repository: SnapshotRepository;
  let locationId: number;
  let otherId: number;

  const store = (id: number, source: SnapshotSource, fetchedAt: string): void => {
    repository.insert({ locationId: id, source, status: 'ok', fetchedAt, payload: fetchedAt });
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    const locations = createLocationRepository(db);
    locationId = locations.upsertLocation(PLACE, '2026-09-14T00:00:00.000Z').rowId;
    otherId = locations.upsertLocation({ ...PLACE, geonamesId: 2 }, '2026-09-14T00:00:00.000Z').rowId;
    repository = createSnapshotRepository(db);
  });

  it('deletes what is older than the cutoff', () => {
    store(locationId, 'weather', '2026-09-10T00:00:00.000Z');
    store(locationId, 'weather', '2026-09-11T00:00:00.000Z');
    store(locationId, 'weather', '2026-09-14T00:00:00.000Z');

    expect(repository.prune('2026-09-12T00:00:00.000Z')).toBe(2);
    expect(repository.getLatest(locationId, 'weather')?.fetchedAt).toBe('2026-09-14T00:00:00.000Z');
  });

  it('never deletes the newest of a pair, however old it is', () => {
    // An old snapshot still beats no snapshot when upstream is down (D§6.1), so
    // retention must not be the thing that empties the store.
    store(locationId, 'weather', '2020-01-01T00:00:00.000Z');

    expect(repository.prune('2026-09-14T00:00:00.000Z')).toBe(0);
    expect(repository.getLatest(locationId, 'weather')).toBeDefined();
  });

  it('keeps the newest of every location and source pair', () => {
    store(locationId, 'weather', '2020-01-01T00:00:00.000Z');
    store(locationId, 'weather', '2020-01-02T00:00:00.000Z');
    store(locationId, 'marine', '2020-01-03T00:00:00.000Z');
    store(otherId, 'weather', '2020-01-04T00:00:00.000Z');

    expect(repository.prune('2026-09-14T00:00:00.000Z')).toBe(1);

    expect(repository.getLatest(locationId, 'weather')?.fetchedAt).toBe('2020-01-02T00:00:00.000Z');
    expect(repository.getLatest(locationId, 'marine')?.fetchedAt).toBe('2020-01-03T00:00:00.000Z');
    expect(repository.getLatest(otherId, 'weather')?.fetchedAt).toBe('2020-01-04T00:00:00.000Z');
  });

  it('does nothing to an empty store', () => {
    expect(repository.prune('2026-09-14T00:00:00.000Z')).toBe(0);
  });
});
