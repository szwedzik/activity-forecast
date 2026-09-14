/**
 * Wiring for the service tests: a real in-memory database, counting fake clients, a
 * recording logger and a clock the test moves by hand.
 *
 * The database is real rather than mocked because it is cheap here and it exercises the
 * SQL, which is what caught the driver's quirks in phase 3.
 */
import type { Database } from '../../src/adapters/db/database.js';
import { openDatabase } from '../../src/adapters/db/database.js';
import type { LocationRepository } from '../../src/adapters/db/locationRepository.js';
import { createLocationRepository } from '../../src/adapters/db/locationRepository.js';
import type { SnapshotRepository } from '../../src/adapters/db/snapshotRepository.js';
import { createSnapshotRepository } from '../../src/adapters/db/snapshotRepository.js';
import type { ForecastClient } from '../../src/adapters/openMeteo/forecastClient.js';
import type { GeocodingClient, GeocodingResult } from '../../src/adapters/openMeteo/geocodingClient.js';
import type { MarineClient } from '../../src/adapters/openMeteo/marineClient.js';
import type { MarinePayload, WeatherPayload } from '../../src/domain/forecast/types.js';
import type { NewLocation } from '../../src/domain/location.js';
import type { Logger } from '../../src/services/logger.js';
import { loadMarine, loadWeather } from './fixtures.js';

export const T0 = '2026-09-14T09:00:00.000Z';
export const HOUR = 3_600_000;

export const LISBON: NewLocation = {
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

export const DENVER: NewLocation = {
  geonamesId: 5419384,
  name: 'Denver',
  countryCode: 'US',
  country: 'United States',
  admin1: 'Colorado',
  latitude: 39.73915,
  longitude: -104.9847,
  elevationM: 1609,
  timezone: 'America/Denver',
  population: 715522,
};

/** Shaped like the geocoder's own result, which is not shaped like ours. */
export function geocodingResultFor(location: NewLocation): GeocodingResult {
  return {
    id: location.geonamesId,
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
    elevation: location.elevationM ?? null,
    country_code: location.countryCode,
    country: location.country,
    admin1: location.admin1,
    population: location.population,
  };
}

export interface RecordingLogger extends Logger {
  readonly warnings: { fields: Record<string, unknown>; message: string }[];
  readonly errors: { fields: Record<string, unknown>; message: string }[];
}

export function recordingLogger(): RecordingLogger {
  const warnings: RecordingLogger['warnings'] = [];
  const errors: RecordingLogger['errors'] = [];
  return {
    warnings,
    errors,
    info: () => undefined,
    warn: (fields, message) => void warnings.push({ fields, message }),
    error: (fields, message) => void errors.push({ fields, message }),
  };
}

export interface FakeGeocoding extends GeocodingClient {
  readonly calls: { name: string; countryCode?: string | undefined; count?: number | undefined }[];
  /** What the next search returns; a thrown value is rejected instead. */
  results: GeocodingResult[];
  failure?: Error | undefined;
}

export function fakeGeocoding(results: GeocodingResult[] = []): FakeGeocoding {
  const client: FakeGeocoding = {
    calls: [],
    results,
    failure: undefined,
    search(name, options) {
      client.calls.push({ name, countryCode: options?.countryCode, count: options?.count });
      if (client.failure) return Promise.reject(client.failure);
      return Promise.resolve(client.results);
    },
  };
  return client;
}

export interface FakeForecast extends ForecastClient {
  readonly calls: number[];
  payload: WeatherPayload;
  failure?: Error | undefined;
  /** Resolved by the test, so a request can be held open mid-flight. */
  gate?: Promise<void> | undefined;
}

export function fakeForecast(payload: WeatherPayload = loadWeather('lisbon')): FakeForecast {
  const client: FakeForecast = {
    calls: [],
    payload,
    failure: undefined,
    gate: undefined,
    async fetchForecast(latitude) {
      client.calls.push(latitude);
      if (client.gate) await client.gate;
      if (client.failure) throw client.failure;
      return client.payload;
    },
  };
  return client;
}

export interface FakeMarine extends MarineClient {
  readonly calls: number[];
  payload: MarinePayload;
  failure?: Error | undefined;
  gate?: Promise<void> | undefined;
}

export function fakeMarine(payload: MarinePayload = loadMarine('lisbon')): FakeMarine {
  const client: FakeMarine = {
    calls: [],
    payload,
    failure: undefined,
    gate: undefined,
    async fetchMarine(latitude) {
      client.calls.push(latitude);
      if (client.gate) await client.gate;
      if (client.failure) throw client.failure;
      return client.payload;
    },
  };
  return client;
}

export interface Store {
  readonly db: Database;
  readonly locations: LocationRepository;
  readonly snapshots: SnapshotRepository;
}

export function openStore(): Store {
  const db = openDatabase(':memory:', { appliedAt: T0 });
  return {
    db,
    locations: createLocationRepository(db),
    snapshots: createSnapshotRepository(db),
  };
}

/** A promise plus the handle to settle it, for holding a fetch open. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = () => settle();
  });
  return { promise, resolve };
}
