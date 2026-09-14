/**
 * Captures the Open-Meteo responses the test suite runs against, so no test ever
 * touches the network (AGENTS.md). Run it once:
 *
 *   npm run capture-fixtures            refuses to overwrite existing fixtures
 *   npm run capture-fixtures -- --force re-captures; tests pin the captured dates,
 *                                       so expect to fix them up afterwards
 *
 * Endpoints, parameters and units are D§2 of docs/DESIGN.md.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FIXTURE_DIR = path.join(process.cwd(), 'test', 'fixtures', 'open-meteo');
const README_PATH = path.join(process.cwd(), 'test', 'fixtures', 'README.md');

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';

const FORECAST_DAYS = 8;

// D§2.2 and D§2.3, verbatim. Phase 2 moves these into the Open-Meteo clients; this
// script should then import them, so captured fixtures and live requests cannot drift.
const WEATHER_HOURLY =
  'temperature_2m,apparent_temperature,precipitation,precipitation_probability,snowfall,snow_depth,weather_code,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,is_day';
const WEATHER_DAILY =
  'sunrise,sunset,sunshine_duration,daylight_duration,uv_index_max,weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,rain_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,cloud_cover_mean';
const MARINE_HOURLY =
  'wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_period,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature';
const MARINE_DAILY = 'wave_height_max,wave_period_max,swell_wave_height_max,swell_wave_period_max';

interface GeocodingResult {
  readonly id: number;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
  readonly country_code?: string;
  readonly admin1?: string;
}

interface GeocodingResponse {
  readonly results?: readonly GeocodingResult[];
}

interface TimeSeriesResponse {
  readonly daily?: { readonly time?: readonly string[] };
  readonly hourly?: Readonly<Record<string, unknown>>;
}

interface CapturedTown {
  readonly town: string;
  readonly place: GeocodingResult;
  readonly firstDate: string;
  readonly marineIsNull: boolean;
}

/** Towns with forecast and marine fixtures: two inland, one coastal (D§2.3). */
const TOWNS = ['Chamonix', 'Lisbon', 'Denver'] as const;
/** Geocoding-only fixtures: an ambiguous name, and one that matches nothing. */
const AMBIGUOUS = 'Springfield';
const NO_MATCH = 'zzqqxwv-not-a-place';

const log = (message: string): void => void process.stdout.write(`${message}\n`);
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function geocodingQuery(name: string, count: number): string {
  return `${GEOCODING_URL}?name=${encodeURIComponent(name)}&count=${count}&language=en&format=json`;
}

function forecastQuery(place: GeocodingResult): string {
  return (
    `${FORECAST_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&timezone=${encodeURIComponent(place.timezone)}&forecast_days=${FORECAST_DAYS}` +
    `&hourly=${WEATHER_HOURLY}&daily=${WEATHER_DAILY}`
  );
}

function marineQuery(place: GeocodingResult): string {
  return (
    `${MARINE_URL}?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&timezone=${encodeURIComponent(place.timezone)}&forecast_days=${FORECAST_DAYS}` +
    `&hourly=${MARINE_HOURLY}&daily=${MARINE_DAILY}`
  );
}

async function get(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'activity-forecast/1.0 (fixture capture)' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  const body: unknown = await response.json();
  await pause(250); // polite to a free, non-commercial tier
  return body;
}

async function capture(fileName: string, url: string): Promise<unknown> {
  const body = await get(url);
  await writeFile(path.join(FIXTURE_DIR, fileName), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  log(`  wrote ${fileName}`);
  return body;
}

/** Inland towns come back HTTP 200 with every value null; that is the signal (D§2.3). */
function everyWaveHeightIsNull(body: unknown): boolean {
  const heights = (body as TimeSeriesResponse).hourly?.['wave_height'];
  return Array.isArray(heights) && heights.length > 0 && heights.every((value) => value === null);
}

function firstDailyDate(body: unknown): string {
  return (body as TimeSeriesResponse).daily?.time?.[0] ?? 'unknown';
}

function topResult(body: unknown, name: string): GeocodingResult {
  const first = (body as GeocodingResponse).results?.[0];
  if (!first) throw new Error(`geocoding returned no results for ${name}`);
  return first;
}

async function alreadyCaptured(): Promise<boolean> {
  try {
    return (await readdir(FIXTURE_DIR)).some((file) => file.endsWith('.json'));
  } catch {
    return false;
  }
}

function readme(capturedAt: string, rows: readonly CapturedTown[], noMatchHasResults: boolean): string {
  const inland = rows.filter((row) => row.marineIsNull).map((row) => row.town);
  const coastal = rows.filter((row) => !row.marineIsNull).map((row) => row.town);

  const table = rows
    .map(
      (row) =>
        `| ${row.town} | ${row.place.name}, ${row.place.country_code ?? '??'} | ${row.place.latitude}, ${row.place.longitude} | ${row.place.timezone} | \`${row.firstDate}\` | ${row.marineIsNull ? 'all null (inland)' : 'has data (coastal)'} |`,
    )
    .join('\n');

  return `# Open-Meteo fixtures

Captured from the live API on **${capturedAt.slice(0, 10)}** (\`${capturedAt}\`) by
\`npm run capture-fixtures\`. Tests read these files instead of the network (AGENTS.md),
and they pin the dates below, so re-capturing means fixing tests up afterwards.

| Town | Geocoder top hit | Coordinates | Timezone | First \`daily.time\` | Marine |
|---|---|---|---|---|---|
${table}

**Use the first \`daily.time\` as "today" in tests.** The payload covers that date and the
seven after it; the service reports today plus six (Q1), so injecting that date exercises a
full window with a day to spare.

Marine coverage is the "surfing not applicable" signal: an inland town returns HTTP 200 with
every value \`null\` rather than an error (D§2.3). Here ${inland.join(' and ')} are the inland
cases and ${coastal.join(' and ')} the coastal one.

## Geocoding fixtures

| File | Query | Why |
|---|---|---|
| \`geocoding.chamonix.json\` | \`name=Chamonix&count=5\` | alpine town |
| \`geocoding.lisbon.json\` | \`name=Lisbon&count=5\` | coastal city |
| \`geocoding.denver.json\` | \`name=Denver&count=5\` | inland city |
| \`geocoding.springfield.json\` | \`name=Springfield&count=10\` | ambiguous name, for disambiguation |
| \`geocoding.nomatch.json\` | \`name=${NO_MATCH}&count=5\` | no match: \`results\` is ${noMatchHasResults ? 'present' : 'absent, not an empty array'} |

Every geocoding request also carries \`language=en&format=json\`.

## Endpoints

\`\`\`
geocoding: ${GEOCODING_URL}
forecast:  ${FORECAST_URL}
marine:    ${MARINE_URL}
\`\`\`

## Forecast and marine queries

Both take \`latitude\`, \`longitude\`, \`forecast_days=${FORECAST_DAYS}\` and the town's IANA
\`timezone\` passed explicitly rather than \`auto\`, so local dates line up by construction
(D-012).

\`\`\`
forecast hourly: ${WEATHER_HOURLY}
forecast daily:  ${WEATHER_DAILY}
marine hourly:   ${MARINE_HOURLY}
marine daily:    ${MARINE_DAILY}
\`\`\`
`;
}

async function main(): Promise<void> {
  if ((await alreadyCaptured()) && !process.argv.includes('--force')) {
    log('Fixtures already exist, and tests pin the dates inside them, so re-capturing');
    log('breaks those tests. Pass --force if that is really what you want.');
    return;
  }

  await mkdir(FIXTURE_DIR, { recursive: true });
  const capturedAt = new Date().toISOString();
  const rows: CapturedTown[] = [];

  for (const town of TOWNS) {
    log(`${town}:`);
    const geocoding = await capture(`geocoding.${slug(town)}.json`, geocodingQuery(town, 5));
    const place = topResult(geocoding, town);
    log(`  top hit: ${place.name}, ${place.country_code ?? '??'} at ${place.latitude}, ${place.longitude} (${place.timezone})`);

    const forecast = await capture(`forecast.${slug(town)}.json`, forecastQuery(place));
    const marine = await capture(`marine.${slug(town)}.json`, marineQuery(place));

    rows.push({
      town,
      place,
      firstDate: firstDailyDate(forecast),
      marineIsNull: everyWaveHeightIsNull(marine),
    });
  }

  log(`${AMBIGUOUS} (ambiguous name):`);
  await capture(`geocoding.${slug(AMBIGUOUS)}.json`, geocodingQuery(AMBIGUOUS, 10));

  log('no-match query:');
  const noMatch = await capture('geocoding.nomatch.json', geocodingQuery(NO_MATCH, 5));
  const noMatchHasResults = 'results' in (noMatch as Record<string, unknown>);

  await writeFile(README_PATH, readme(capturedAt, rows, noMatchHasResults), 'utf8');
  log(`\nwrote ${path.relative(process.cwd(), README_PATH)}`);
}

await main();
