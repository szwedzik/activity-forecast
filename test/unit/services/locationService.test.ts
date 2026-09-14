import { beforeEach, describe, expect, it } from 'vitest';

import { queryKey } from '../../../src/adapters/db/locationRepository.js';
import { ServiceError } from '../../../src/services/errors.js';
import type { LocationService } from '../../../src/services/locationService.js';
import { createLocationService, NOT_FOUND } from '../../../src/services/locationService.js';
import type { FixedClock } from '../../../src/services/clock.js';
import { fixedClock } from '../../../src/services/clock.js';
import type { FakeGeocoding, Store } from '../../helpers/services.js';
import { DENVER, fakeGeocoding, geocodingResultFor, HOUR, LISBON, openStore, T0 } from '../../helpers/services.js';

describe('resolving a place', () => {
  let store: Store;
  let geocoding: FakeGeocoding;
  let clock: FixedClock;
  let service: LocationService;

  beforeEach(() => {
    store = openStore();
    geocoding = fakeGeocoding([geocodingResultFor(LISBON)]);
    clock = fixedClock(T0);
    service = createLocationService({ repository: store.locations, geocoding, clock });
  });

  it('geocodes a place it has never seen, and stores it', async () => {
    const found = await service.resolve('Lisbon');

    expect(found).not.toBe(NOT_FOUND);
    expect(found).toMatchObject({ geonamesId: 2267057, name: 'Lisbon', timezone: 'Europe/Lisbon' });
    expect(geocoding.calls).toHaveLength(1);
  });

  it('maps the geocoder field names onto ours', async () => {
    const found = await service.resolve('Lisbon');

    // id → geonamesId, elevation → elevationM, country_code → countryCode.
    expect(found).toMatchObject({ geonamesId: 2267057, elevationM: 54, countryCode: 'PT' });
  });

  it('turns a null elevation into an absent one', async () => {
    geocoding.results = [{ ...geocodingResultFor(LISBON), elevation: null }];

    const found = await service.resolve('Lisbon');

    expect(found).not.toBe(NOT_FOUND);
    expect(found).toMatchObject({ name: 'Lisbon' });
    expect(found === NOT_FOUND ? 'still not found' : found.elevationM).toBeUndefined();
  });

  it('does not call the geocoder a second time for the same place', async () => {
    await service.resolve('Lisbon');
    await service.resolve('Lisbon');
    await service.resolve('  LISBON  ');

    expect(geocoding.calls).toHaveLength(1);
  });

  it('forwards the country code, and treats it as part of the question', async () => {
    await service.resolve('Springfield', 'us');

    expect(geocoding.calls[0]).toMatchObject({ name: 'Springfield', countryCode: 'us' });

    // A different country code is a different query, so it is asked again.
    await service.resolve('Springfield', 'gb');
    expect(geocoding.calls).toHaveLength(2);
  });

  it('asks for only the top match, since the geocoder orders by prominence', async () => {
    await service.resolve('Lisbon');

    expect(geocoding.calls[0]?.count).toBe(1);
  });

  it('remembers that nothing matched, rather than asking again every time', async () => {
    geocoding.results = [];

    expect(await service.resolve('zzqqxwv')).toBe(NOT_FOUND);
    expect(await service.resolve('zzqqxwv')).toBe(NOT_FOUND);

    expect(geocoding.calls).toHaveLength(1);
    expect(store.locations.findByQueryKey(queryKey('zzqqxwv'))?.location).toBeUndefined();
  });

  it('asks again about a miss after a day, in case the geocoder has learned the place', async () => {
    geocoding.results = [];
    expect(await service.resolve('New Town')).toBe(NOT_FOUND);

    clock.advance(25 * HOUR);
    geocoding.results = [geocodingResultFor(LISBON)];

    expect(await service.resolve('New Town')).not.toBe(NOT_FOUND);
    expect(geocoding.calls).toHaveLength(2);
  });

  it('keeps a hit for a month, then checks again', async () => {
    await service.resolve('Lisbon');

    clock.advance(29 * 24 * HOUR);
    await service.resolve('Lisbon');
    expect(geocoding.calls).toHaveLength(1);

    clock.advance(2 * 24 * HOUR);
    await service.resolve('Lisbon');
    expect(geocoding.calls).toHaveLength(2);
  });

  it('updates the place in place when it is geocoded again, keeping its row', async () => {
    const first = await service.resolve('Lisbon');
    clock.advance(31 * 24 * HOUR);
    geocoding.results = [{ ...geocodingResultFor(LISBON), name: 'Lisboa' }];

    const again = await service.resolve('Lisbon');

    expect(again === NOT_FOUND ? undefined : again.rowId).toBe(first === NOT_FOUND ? -1 : first.rowId);
    expect(again === NOT_FOUND ? undefined : again.name).toBe('Lisboa');
  });

  it('records every resolve as a visit, which is what keeps a town warm', async () => {
    await service.resolve('Lisbon');
    expect(store.locations.recentlyRequested(T0)).toHaveLength(1);

    clock.advance(2 * HOUR);
    await service.resolve('Lisbon');

    const [active] = store.locations.recentlyRequested(T0);
    expect(active?.lastRequestedAt).toBe('2026-09-14T11:00:00.000Z');
  });

  it('reports a geocoder outage as an upstream failure', async () => {
    geocoding.failure = new Error('ECONNRESET');

    const error = await service.resolve('Lisbon').catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('does not remember an outage as a miss', async () => {
    geocoding.failure = new Error('ECONNRESET');
    await service.resolve('Lisbon').catch(() => undefined);

    expect(store.locations.findByQueryKey(queryKey('Lisbon'))).toBeUndefined();
  });

  it('keeps two different places apart', async () => {
    await service.resolve('Lisbon');
    geocoding.results = [geocodingResultFor(DENVER)];
    const denver = await service.resolve('Denver');

    expect(denver === NOT_FOUND ? undefined : denver.timezone).toBe('America/Denver');
    expect(store.locations.recentlyRequested(T0)).toHaveLength(2);
  });
});

describe('searching for candidates', () => {
  let store: Store;
  let geocoding: FakeGeocoding;
  let service: LocationService;

  beforeEach(() => {
    store = openStore();
    geocoding = fakeGeocoding([geocodingResultFor(LISBON), geocodingResultFor(DENVER)]);
    service = createLocationService({
      repository: store.locations,
      geocoding,
      clock: fixedClock(T0),
    });
  });

  it('passes straight through to the geocoder', async () => {
    const results = await service.search('Springfield', 'US', 3);

    expect(results).toHaveLength(2);
    expect(geocoding.calls[0]).toMatchObject({ name: 'Springfield', countryCode: 'US', count: 3 });
  });

  it('is not cached: browsing is not the same as asking', async () => {
    await service.search('Springfield');
    await service.search('Springfield');

    expect(geocoding.calls).toHaveLength(2);
    expect(store.locations.findByQueryKey(queryKey('Springfield'))).toBeUndefined();
  });

  it('does not keep anything warm', async () => {
    await service.search('Lisbon');

    expect(store.locations.recentlyRequested(T0)).toEqual([]);
  });

  it('reports a geocoder outage the same way resolve does', async () => {
    geocoding.failure = new Error('down');

    await expect(service.search('Lisbon')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});
