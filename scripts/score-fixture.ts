/**
 * Prints the scoring table for one captured fixture:
 *
 *   npm run score-fixture -- lisbon
 *
 * This is a plausibility run, not a gate. It shows one week of whatever weather was
 * captured; tuning curves until it looks nice is fitting noise. The gate is the band
 * table in test/unit/domain/scoring/bands.test.ts, and a number that looks wrong here
 * becomes a new hand-built case there before any curve moves (D-011).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { summariseDays } from '../src/domain/forecast/features.js';
import type { ForecastData, MarinePayload, WeatherPayload } from '../src/domain/forecast/types.js';
import { rankActivities } from '../src/domain/scoring/index.js';

const FIXTURE_DIR = path.join(process.cwd(), 'test', 'fixtures', 'open-meteo');
const CITIES = ['chamonix', 'lisbon', 'denver'] as const;

const log = (line = ''): void => void process.stdout.write(`${line}\n`);

function read(file: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

/** Inland fixtures are all null, which is the same thing as having no marine data (D§2.3). */
function marineIfUseful(city: string): MarinePayload | undefined {
  const marine = read(`marine.${city}.json`) as MarinePayload;
  const usable = marine.hourly.wave_height.some((value) => value !== null);
  return usable ? marine : undefined;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}

function main(): void {
  const requested = process.argv[2];
  if (requested === undefined || !CITIES.includes(requested as (typeof CITIES)[number])) {
    log(`usage: npm run score-fixture -- <${CITIES.join('|')}>`);
    process.exitCode = 1;
    return;
  }
  const city = requested as (typeof CITIES)[number];

  const weather = read(`forecast.${city}.json`) as WeatherPayload;
  const data: ForecastData = { weather, marine: marineIfUseful(city) };
  const todayLocal = weather.daily.time[0];
  if (todayLocal === undefined) throw new Error(`no daily dates in the ${city} fixture`);

  log(`${city} — ${weather.timezone}, grid ${weather.latitude}, ${weather.longitude}, ${weather.elevation ?? '?'} m`);
  log(`today = ${todayLocal} (the first date in the fixture)`);
  log();

  log('weather');
  for (const day of summariseDays(data, todayLocal)) {
    log(
      `  ${day.date}  ${pad(day.summary, 24)} ${String(Math.round(day.tempMinC ?? 0)).padStart(3)}..${String(
        Math.round(day.tempMaxC ?? 0),
      ).padStart(3)} °C  ${String(day.precipitationMm ?? 0).padStart(5)} mm  ${String(
        Math.round(day.windMaxKmh ?? 0),
      ).padStart(3)} km/h${day.waveHeightMaxM === undefined ? '' : `  ${day.waveHeightMaxM.toFixed(1)} m waves`}`,
    );
  }

  for (const ranking of rankActivities(data, todayLocal)) {
    log();
    log(`${ranking.activity}${ranking.applicable ? '' : `  — not applicable: ${ranking.note ?? ''}`}`);
    if (!ranking.applicable) continue;

    for (const day of ranking.days) {
      const top = day.factors[0];
      const reason = top === undefined ? '' : `${top.name} ${top.value}`;
      log(
        `  ${String(day.rank).padStart(2)}. ${day.date}  ${String(day.score).padStart(3)}  ${pad(
          day.suitability,
          14,
        )} conf ${day.confidence.toFixed(2)}  ${reason}`,
      );
    }
  }
}

main();
