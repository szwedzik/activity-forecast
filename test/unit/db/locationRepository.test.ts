import { beforeEach, describe, expect, it } from 'vitest';

import type { Database } from '../../../src/adapters/db/database.js';
import { openDatabase } from '../../../src/adapters/db/database.js';
import type { LocationRepository } from '../../../src/adapters/db/locationRepository.js';
import { createLocationRepository, queryKey } from '../../../src/adapters/db/locationRepository.js';
import type { NewLocation } from '../../../src/domain/location.js';

const LISBON: NewLocation = {
  geonamesId: 2267057,
  name: 'Lisbon',
  countryCode: 'PT',
  country: 'Portugal',
  admin1: 'Lisbon',
  latitude: 38.72509,
  longitude: -9.1498,
  elevationM: 54,
  timezone: 'Europe/Lisbon',
  population: 517802,
};

/** A place with no admin region and no population, which the geocoder does return. */
const SPARSE: NewLocation = {
  geonamesId: 111,
  name: 'Nowhere',
  latitude: 0,
  longitude: 0,
  timezone: 'UTC',
};

const T1 = '2026-09-14T09:00:00.000Z';
const T2 = '2026-09-14T12:00:00.000Z';

describe('queryKey', () => {
  it('folds case, trims and collapses whitespace, so one place is one key', () => {
    expect(queryKey('  New   York ')).toBe('new york|');
    expect(queryKey('NEW YORK')).toBe('new york|');
  });

  it('keeps the country code separate and uppercase', () => {
    expect(queryKey('Springfield', 'us')).toBe('springfield|US');
    expect(queryKey('Springfield')).not.toBe(queryKey('Springfield', 'US'));
  });

  it('treats the two spellings of an accented name as the same query', () => {
    // "Zürich" with a precomposed ü and with u + combining diaeresis.
    // Written as escapes on purpose: an editor that normalises this file would
    // otherwise make both sides identical and the test could no longer fail.
    expect(queryKey('Z\u00fcrich')).toBe(queryKey('Zu\u0308rich'));
  });
});

describe('the location repository', () => {
  let db: Database;
  let repository: LocationRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repository = createLocationRepository(db);
  });

  it('stores a location and reads it back whole', () => {
    const stored = repository.upsertLocation(LISBON, T1);

    expect(stored).toMatchObject({ ...LISBON, createdAt: T1 });
    expect(stored.rowId).toBeGreaterThan(0);
    expect(stored.lastRequestedAt).toBeUndefined();
  });

  it('stores a location whose optional fields are simply absent', () => {
    const stored = repository.upsertLocation(SPARSE, T1);

    expect(stored.countryCode).toBeUndefined();
    expect(stored.population).toBeUndefined();
    expect(stored.elevationM).toBeUndefined();
    expect(stored.name).toBe('Nowhere');
  });

  it('updates a place in place, keeping its id and the day we first saw it', () => {
    const first = repository.upsertLocation(LISBON, T1);
    const again = repository.upsertLocation({ ...LISBON, name: 'Lisboa', population: 600000 }, T2);

    expect(again.rowId).toBe(first.rowId);
    expect(again.createdAt).toBe(T1);
    expect(again.name).toBe('Lisboa');
    expect(again.population).toBe(600000);
  });

  it('has never heard of a query it was not told about', () => {
    expect(repository.findByQueryKey(queryKey('Lisbon'))).toBeUndefined();
  });

  it('remembers what a query resolved to', () => {
    const stored = repository.upsertLocation(LISBON, T1);
    repository.cacheQuery(queryKey('lisbon'), stored.rowId, T1);

    const cached = repository.findByQueryKey(queryKey('Lisbon'));

    expect(cached?.resolvedAt).toBe(T1);
    expect(cached?.location?.rowId).toBe(stored.rowId);
    expect(cached?.location?.timezone).toBe('Europe/Lisbon');
  });

  it('remembers a miss as a miss, not as never having asked', () => {
    repository.cacheQuery(queryKey('zzqqxwv'), null, T1);

    const cached = repository.findByQueryKey(queryKey('zzqqxwv'));

    expect(cached).toBeDefined();
    expect(cached?.location).toBeUndefined();
    expect(cached?.resolvedAt).toBe(T1);
  });

  it('lets a remembered miss become a hit later', () => {
    repository.cacheQuery(queryKey('lisbon'), null, T1);
    const stored = repository.upsertLocation(LISBON, T2);
    repository.cacheQuery(queryKey('lisbon'), stored.rowId, T2);

    expect(repository.findByQueryKey(queryKey('lisbon'))?.location?.rowId).toBe(stored.rowId);
  });

  it('records when a place was last asked about', () => {
    const stored = repository.upsertLocation(LISBON, T1);
    repository.touch(stored.rowId, T2);

    repository.cacheQuery(queryKey('lisbon'), stored.rowId, T1);
    expect(repository.findByQueryKey(queryKey('lisbon'))?.location?.lastRequestedAt).toBe(T2);
  });

  it('lists the places asked about since a cutoff, most recent first', () => {
    const lisbon = repository.upsertLocation(LISBON, T1);
    const nowhere = repository.upsertLocation(SPARSE, T1);
    const denver = repository.upsertLocation({ ...SPARSE, geonamesId: 222, name: 'Denver' }, T1);

    repository.touch(lisbon.rowId, '2026-09-14T12:00:00.000Z');
    repository.touch(denver.rowId, '2026-09-14T18:00:00.000Z');
    // `nowhere` is never touched, so it is not active at all.

    const active = repository.recentlyRequested('2026-09-14T00:00:00.000Z');

    expect(active.map((one) => one.name)).toEqual(['Denver', 'Lisbon']);
    expect(active.map((one) => one.rowId)).not.toContain(nowhere.rowId);
  });

  it('leaves out places last asked about before the cutoff', () => {
    const stored = repository.upsertLocation(LISBON, T1);
    repository.touch(stored.rowId, '2026-09-10T00:00:00.000Z');

    expect(repository.recentlyRequested('2026-09-13T00:00:00.000Z')).toEqual([]);
  });
});
