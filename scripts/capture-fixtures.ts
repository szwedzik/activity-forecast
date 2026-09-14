/**
 * Captures the Open-Meteo responses the test suite runs against, so no test ever
 * touches the network (AGENTS.md). Run it once:
 *
 *   npm run capture-fixtures            refuses to overwrite existing fixtures
 *   npm run capture-fixtures -- --force re-captures; tests pin the captured dates,
 *                                       so expect to fix them up afterwards
 *
 * URLs come from the clients in src/adapters/openMeteo, so what the fixtures were
 * recorded against and what the running service asks for cannot drift apart. The bodies
 * are written exactly as they arrive, without going through the schemas: a fixture is
 * meant to be what Open-Meteo said, not what we were willing to accept.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildForecastUrl,
  FORECAST_DAILY_VARIABLES,
  FORECAST_DAYS,
  FORECAST_HOURLY_VARIABLES,
} from '../src/adapters/openMeteo/forecastClient.js';
import { buildGeocodingUrl } from '../src/adapters/openMeteo/geocodingClient.js';
import {
  buildMarineUrl,
  MARINE_DAILY_VARIABLES,
  MARINE_HOURLY_VARIABLES,
} from '../src/adapters/openMeteo/marineClient.js';
import { DEFAULT_USER_AGENT } from '../src/adapters/openMeteo/http.js';

const FIXTURE_DIR = path.join(process.cwd(), 'test', 'fixtures', 'open-meteo');
const README_PATH = path.join(process.cwd(), 'test', 'fixtures', 'README.md');

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';

interface GeocodingResult {
  readonly id: number;
  readonly name: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: string;
  readonly country_code?: string;
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

const log = (message = ''): void => void process.stdout.write(`${message}\n`);
const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'User-Agent': `${DEFAULT_USER_AGENT} (fixture capture)` },
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
(D-012). The lists below are the exported constants the clients use, so these fixtures and
the running service ask for the same thing.

\`\`\`
forecast hourly: ${FORECAST_HOURLY_VARIABLES.join(',')}
forecast daily:  ${FORECAST_DAILY_VARIABLES.join(',')}
marine hourly:   ${MARINE_HOURLY_VARIABLES.join(',')}
marine daily:    ${MARINE_DAILY_VARIABLES.join(',')}
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
    const geocoding = await capture(
      `geocoding.${slug(town)}.json`,
      buildGeocodingUrl(GEOCODING_URL, town, { count: 5 }),
    );
    const place = topResult(geocoding, town);
    log(`  top hit: ${place.name}, ${place.country_code ?? '??'} at ${place.latitude}, ${place.longitude} (${place.timezone})`);

    const forecast = await capture(
      `forecast.${slug(town)}.json`,
      buildForecastUrl(FORECAST_URL, place.latitude, place.longitude, place.timezone),
    );
    const marine = await capture(
      `marine.${slug(town)}.json`,
      buildMarineUrl(MARINE_URL, place.latitude, place.longitude, place.timezone),
    );

    rows.push({
      town,
      place,
      firstDate: firstDailyDate(forecast),
      marineIsNull: everyWaveHeightIsNull(marine),
    });
  }

  log(`${AMBIGUOUS} (ambiguous name):`);
  await capture(
    `geocoding.${slug(AMBIGUOUS)}.json`,
    buildGeocodingUrl(GEOCODING_URL, AMBIGUOUS, { count: 10 }),
  );

  log('no-match query:');
  const noMatch = await capture(
    'geocoding.nomatch.json',
    buildGeocodingUrl(GEOCODING_URL, NO_MATCH, { count: 5 }),
  );
  const noMatchHasResults = 'results' in (noMatch as Record<string, unknown>);

  await writeFile(README_PATH, readme(capturedAt, rows, noMatchHasResults), 'utf8');
  log(`\nwrote ${path.relative(process.cwd(), README_PATH)}`);
}

await main();
