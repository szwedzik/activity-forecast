/**
 * A whole request, assembled. This is the closest thing to the real thing before the
 * GraphQL layer exists, so it is also where the phase 3 carry-forward gets checked: the
 * surfing note has to name the town, which the domain cannot do.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { FixedClock } from '../../../src/services/clock.js';
import { fixedClock } from '../../../src/services/clock.js';
import { createForecastService } from '../../../src/services/forecastService.js';
import { createLocationService } from '../../../src/services/locationService.js';
import type { RankingService } from '../../../src/services/rankingService.js';
import { createRankingService } from '../../../src/services/rankingService.js';
import { loadMarine, loadWeather } from '../../helpers/fixtures.js';
import type { FakeForecast, FakeGeocoding, FakeMarine, Store } from '../../helpers/services.js';
import {
  DENVER,
  fakeForecast,
  fakeGeocoding,
  fakeMarine,
  geocodingResultFor,
  HOUR,
  LISBON,
  openStore,
  T0,
} from '../../helpers/services.js';

describe('ranking a request end to end', () => {
  let store: Store;
  let geocoding: FakeGeocoding;
  let forecast: FakeForecast;
  let marine: FakeMarine;
  let clock: FixedClock;
  let service: RankingService;

  const wire = (): RankingService => {
    const locations = createLocationService({ repository: store.locations, geocoding, clock });
    const forecasts = createForecastService({
      snapshots: store.snapshots,
      forecast,
      marine,
      clock,
    });
    return createRankingService({ locations, forecasts, clock });
  };

  beforeEach(() => {
    store = openStore();
    geocoding = fakeGeocoding([geocodingResultFor(LISBON)]);
    forecast = fakeForecast();
    marine = fakeMarine();
    clock = fixedClock(T0);
    service = wire();
  });

  it('returns the place, the metadata, seven days and four activities', async () => {
    const result = await service.rank('Lisbon');

    expect(result.location.name).toBe('Lisbon');
    expect(result.days).toHaveLength(7);
    expect(result.rankings.map((one) => one.activity)).toEqual([
      'SKIING',
      'SURFING',
      'OUTDOOR_SIGHTSEEING',
      'INDOOR_SIGHTSEEING',
    ]);
  });

  it('gives every activity seven days ranked one to seven', async () => {
    const result = await service.rank('Lisbon');

    for (const ranking of result.rankings) {
      expect(ranking.days, ranking.activity).toHaveLength(7);
      expect([...ranking.days].map((one) => one.rank).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]);
    }
  });

  it('reports where the data came from and when', async () => {
    const result = await service.rank('Lisbon');

    expect(result.forecast).toMatchObject({
      source: 'open-meteo',
      weatherFetchedAt: T0,
      marineFetchedAt: T0,
      stale: false,
      marineAvailable: true,
      timezone: 'Europe/Lisbon',
    });
    expect(result.forecast.marineCellDistanceKm).toBeGreaterThan(1);
  });

  it('only asks for the activities it was given', async () => {
    const result = await service.rank('Lisbon', undefined, ['SURFING']);

    expect(result.rankings).toHaveLength(1);
    expect(result.rankings[0]?.activity).toBe('SURFING');
  });

  it('says a place does not exist rather than inventing one', async () => {
    geocoding.results = [];

    await expect(service.rank('zzqqxwv')).rejects.toMatchObject({ code: 'LOCATION_NOT_FOUND' });
  });

  it('names the town when there is no coastline near it', async () => {
    // The domain cannot write this sentence: it has no idea where it is.
    geocoding.results = [geocodingResultFor(DENVER)];
    marine.payload = loadMarine('denver');

    const result = await service.rank('Denver');
    const surfing = result.rankings.find((one) => one.activity === 'SURFING');

    expect(surfing?.applicable).toBe(false);
    expect(surfing?.note).toContain('near Denver');
    expect(result.forecast.marineAvailable).toBe(false);
    expect(result.forecast.marineCellDistanceKm).toBeUndefined();
  });

  it('says something different when the wave data is merely down', async () => {
    marine.failure = new Error('marine down');

    const result = await service.rank('Lisbon');
    const surfing = result.rankings.find((one) => one.activity === 'SURFING');

    expect(surfing?.applicable).toBe(false);
    expect(surfing?.note).toContain('temporarily unavailable');
    expect(surfing?.note).not.toContain('inland');
  });

  it('leaves the other three activities alone when surfing cannot be judged', async () => {
    marine.failure = new Error('marine down');

    const result = await service.rank('Lisbon');
    const others = result.rankings.filter((one) => one.activity !== 'SURFING');

    expect(others).toHaveLength(3);
    expect(others.every((one) => one.applicable)).toBe(true);
    expect(others.every((one) => one.days.every((day) => day.factors.length > 0))).toBe(true);
  });

  it('marks the answer stale when either snapshot is past its TTL', async () => {
    await service.rank('Lisbon');
    clock.advance(4 * HOUR);

    // Four hours puts weather past its three-hour TTL but leaves marine inside six.
    const result = await service.rank('Lisbon');

    expect(result.forecast.stale).toBe(true);
  });

  it('uses the local date at the town, not the server date', async () => {
    // 23:30 UTC on the 14th is already the 15th in Sydney.
    geocoding.results = [
      { ...geocodingResultFor(LISBON), timezone: 'Australia/Sydney', name: 'Sydney' },
    ];
    clock.set('2026-09-14T23:30:00.000Z');

    const result = await service.rank('Sydney');

    expect(result.days[0]?.date).toBe('2026-09-15');
  });

  it('serves a second request from the store', async () => {
    await service.rank('Lisbon');
    await service.rank('Lisbon');

    expect(geocoding.calls).toHaveLength(1);
    expect(forecast.calls).toHaveLength(1);
    expect(marine.calls).toHaveLength(1);
  });

  it('scores what came out of the database, not what went in', async () => {
    const first = await service.rank('Lisbon');
    clock.advance(1 * HOUR);
    const second = await service.rank('Lisbon');

    // The second answer was rebuilt from the stored payload and must match the first.
    expect(second.rankings).toEqual(first.rankings);
    expect(second.days).toEqual(first.days);
  });

  it('carries the weather summary alongside the rankings', async () => {
    const result = await service.rank('Lisbon');

    expect(result.days[0]).toMatchObject({ date: '2026-09-14', summary: 'Clear sky' });
    expect(result.days[0]?.waveHeightMaxM).toBeGreaterThan(0);
  });

  it('passes an upstream weather failure up as an error', async () => {
    forecast.failure = new Error('upstream down');

    await expect(service.rank('Lisbon')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('agrees with the fixture-driven scoring from the domain tests', async () => {
    const result = await service.rank('Lisbon');
    const surfing = result.rankings.find((one) => one.activity === 'SURFING');
    const skiing = result.rankings.find((one) => one.activity === 'SKIING');

    // Lisbon in September: surfable, and no snow whatsoever.
    expect(surfing?.applicable).toBe(true);
    expect(surfing?.days[0]?.score).toBeGreaterThan(50);
    // The band from D§10, not the domain's exact gate output.
    expect(skiing?.days.every((one) => one.score <= 5)).toBe(true);
  });

  it('is built from the same payloads the fixtures hold', async () => {
    await service.rank('Lisbon');

    expect(JSON.parse(store.snapshots.getLatest(1, 'weather')?.payload ?? '{}')).toEqual(
      loadWeather('lisbon'),
    );
  });
});
