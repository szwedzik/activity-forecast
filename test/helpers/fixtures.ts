import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { MarinePayload, WeatherPayload } from '../../src/domain/forecast/types.js';

const FIXTURE_DIR = path.join(process.cwd(), 'test', 'fixtures', 'open-meteo');

/** Towns captured by `npm run capture-fixtures`; see test/fixtures/README.md. */
export type FixtureCity = 'chamonix' | 'lisbon' | 'denver';

/** The first local date in every captured payload. Tests inject it as "today". */
export const FIXTURE_TODAY = '2026-09-14';

function load(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

export function loadWeather(city: FixtureCity): WeatherPayload {
  return load(`forecast.${city}.json`) as WeatherPayload;
}

/** Inland towns come back with every value null, which is the not-applicable signal (D§2.3). */
export function loadMarine(city: FixtureCity): MarinePayload {
  return load(`marine.${city}.json`) as MarinePayload;
}

export function loadGeocoding(name: string): unknown {
  return load(`geocoding.${name}.json`);
}
