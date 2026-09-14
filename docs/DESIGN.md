# Activity Forecast Service — Design

Design reference for the implementation. The order of work and the definitions of done are in [PHASES.md](PHASES.md); the paper trail is in [DECISIONS.md](DECISIONS.md), [QUESTIONS.md](QUESTIONS.md) and [WORKLOG.md](WORKLOG.md). Written 2026-09-10; light updates on 2026-09-12 are marked *(2026-09-12)*. Facts marked **verified** were checked with live calls to the Open-Meteo APIs from this machine on 2026-09-10; everything else is a design decision with its reasoning attached.

The brief, verbatim: *Build a backend service that takes a city or town and ranks how good the next 7 days will be for skiing, surfing, outdoor sightseeing and indoor sightseeing. Open-Meteo provides the weather data. Persist it rather than calling the API on every request; how you model, store, and refresh it is part of the problem. Node.js and GraphQL; storage is your call. No front end. A focused submission that reasons well beats an exhaustive one.*

**At a glance**

- **Stack:** Node ≥ 22.13, TypeScript 5.9, GraphQL Yoga (schema-first), SQLite via the built-in `node:sqlite`, zod, pino, Vitest. About five runtime dependencies.
- **Storage:** `locations`, a geocode query cache that also remembers misses, and immutable raw `forecast_snapshots` per (location, source). Scores are computed on read, never stored.
- **Refresh:** TTL freshness (weather 3 h, marine 6 h), stale-while-revalidate up to 24 h, single-flight per location, background refresh of recently used locations, weekly negative cache for inland marine.
- **Scoring:** per activity, weighted criteria with piecewise-linear desirability curves over *daytime* features, multiplied by safety and feasibility gates. Every score ships with its factors and a lead-time confidence.
- **API:** `activityRankings(city, countryCode?, activities?)` returns the 7 days ranked per activity; `searchLocations` disambiguates names.
- **Delivery:** eight phases in [PHASES.md](PHASES.md) *(2026-09-12: regrouped from the 11 steps that were in §11)*; README outline in §12.

---

## 1. The problem, stated precisely

Given a free-text place name, return — for each of four activities — the next 7 days ranked best-first, each day with an absolute score, a label, a confidence, and the factors that produced the score. Weather comes from Open-Meteo, is stored locally, and is refreshed on a policy rather than per request.

Interpretation decisions. Each is an assumption the README must state.

| Question | Decision | Why |
|---|---|---|
| What is "the next 7 days"? | Today plus the following 6 days, where "today" is the calendar date in the **location's** timezone. | Someone in Sydney asking at 09:00 local means Sydney's today, not the server's. We fetch 8 days, so switching to "tomorrow + 6" is a one-line change. |
| What does "rank" mean? | Per activity: the 7 days sorted best-first, each with a 0–100 score, rank 1–7, a label, and factors. | The score is absolute (comparable across days and places); the rank answers "which day should I pick". |
| Which place is "Paris"? | The geocoder's top match (it orders by prominence: Paris FR before Paris TX). Callers may pass an ISO country code; a `searchLocations` query exposes candidates. | Right answer in the common case with no extra round-trip; a clean escape hatch for the rest. |
| Where are conditions evaluated? | At the town's own forecast grid cell. Surfing uses the nearest sea cell when the wave model has one; otherwise the activity is *not applicable*. | Honest and simple. Skiing for "Chamonix" reflects the valley floor (~1,040 m), not the pistes at 2,500 m. Documented limitation; users should query the resort town, not the nearest city. |
| How does weather affect *indoor* sightseeing? | It is weather-proof, so its floor is high. Day-to-day differences reflect opportunity cost (bad outdoor weather → indoor day), minus a small penalty when getting around is genuinely hard (blizzard, storm). | See §7.6. Venue opening days (museums shut on Mondays) matter more than weather and are explicitly out of scope. |

Out of scope, deliberately: front end, auth, multi-instance deployment, resort/beach databases, coastline orientation (wind direction relative to shore), crowd/holiday effects. The brief rewards focus; do not add these.

---

## 2. Verified facts about Open-Meteo (2026-09-10)

No API key. Free tier is non-commercial, roughly 10,000 calls/day.

### 2.1 Geocoding — `GET https://geocoding-api.open-meteo.com/v1/search`

- Params: `name` (required), `count` (default 10), `language=en`, `format=json`, `countryCode` (ISO 3166-1 alpha-2). **Verified:** `countryCode` filters server-side (`name=Paris&countryCode=US` returns only US results). `name=Paris, US` also works. `name=Paris TX` and `name=paris texas` return nothing — admin regions are not searchable. Pass the user's text through after trimming; do not try to be clever.
- Response: `{ results?: Result[], generationtime_ms }`. **When nothing matches, `results` is absent — not an empty array.**
- `Result` fields we use: `id` (GeoNames id; stable, use as the natural key), `name`, `latitude`, `longitude`, `elevation` (m), `feature_code`, `country_code`, `country`, `admin1`, `timezone` (IANA), `population`.
- Ordering is by prominence: Lisbon PT before Lisbon OH; London GB before London ON; "New York" → New York NY first.

### 2.2 Weather forecast — `GET https://api.open-meteo.com/v1/forecast`

Query (every variable **verified** present and non-null for Chamonix, Lisbon, Denver):

```
latitude=..&longitude=..&timezone=auto&forecast_days=8
&hourly=temperature_2m,apparent_temperature,precipitation,precipitation_probability,snowfall,snow_depth,weather_code,cloud_cover,visibility,wind_speed_10m,wind_gusts_10m,is_day
&daily=sunrise,sunset,sunshine_duration,daylight_duration,uv_index_max,weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,rain_sum,snowfall_sum,precipitation_hours,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,cloud_cover_mean
```

- Response: `latitude`, `longitude` (the grid cell actually used; differs slightly from the request), `elevation` (grid-cell elevation), `timezone`, `utc_offset_seconds`, `hourly_units`, `hourly: { time: string[], <var>: (number|null)[] }`, `daily_units`, `daily: { … }`.
- With `timezone=auto`, `hourly.time` entries are local wall-clock strings with no offset, e.g. `2026-09-10T13:00`; `daily.time` is `2026-09-10`. 8 days → 192 hourly rows starting at local midnight. Local hour is `Number(t.slice(11, 13))`, local date is `t.slice(0, 10)`. No date library needed. *(2026-09-12, D-012: the service passes the geocoder's IANA zone explicitly, e.g. `timezone=Europe/Lisbon`, instead of `auto`, so "today" and these strings agree by construction; the response format is identical.)*
- Units: °C; `precipitation` mm; `snowfall` **cm**; `snow_depth` **metres**; `visibility` metres; wind km/h; `sunshine_duration` and `daylight_duration` seconds; `is_day` 0/1; `weather_code` WMO.
- Payload ≈ 17 KB per location for 8 days.
- Any array element may be `null` for some models/regions. Type everything as `number | null` and aggregate defensively.
- Liquid precipitation: the hourly `rain` variable excludes showers, so derive liquid as `max(0, precipitation − snowfall / 7)` per hour (Open-Meteo converts snow to water-equivalent at 7:1).

### 2.3 Marine forecast — `GET https://marine-api.open-meteo.com/v1/marine`

```
latitude=..&longitude=..&timezone=auto&forecast_days=8
&hourly=wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_period,swell_wave_height,swell_wave_period,swell_wave_direction,sea_surface_temperature
&daily=wave_height_max,wave_period_max,swell_wave_height_max,swell_wave_period_max
```

- Same response shape and time format as the weather API. Units: m, s, °, °C. ≈ 13 KB per location.
- **Inland behaviour (verified):** London, Paris, Denver, Chamonix and Madrid all return HTTP 200 with every value `null`. Coastal cities get data from a nearby sea cell: Lisbon 5 km away, Sydney 8 km, Barcelona 12 km, downtown Los Angeles 23 km. There is no error to catch and no distance threshold to tune. **"Every `wave_height` value is null" is the not-applicable signal.** Compute the haversine distance between requested and returned coordinates purely to report in the response.
- Weather and marine snapshots may be fetched on different days (they have different TTLs), so their hourly arrays may start on different dates. **Join hourly rows by the `time` string, never by array index.**

### 2.4 WMO weather codes

0 clear · 1–3 mainly clear / partly cloudy / overcast · 45, 48 fog · 51, 53, 55 drizzle · 56, 57 freezing drizzle · 61, 63, 65 rain · 66, 67 freezing rain · 71, 73, 75 snow · 77 snow grains · 80–82 rain showers · 85, 86 snow showers · 95 thunderstorm · 96, 99 thunderstorm with hail.

Severity order for "worst code in window": thunderstorm > freezing precipitation > heavy snow/rain > moderate > light/showers/drizzle > fog > cloud > clear.

---

## 3. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node ≥ 22.13 (LTS), TypeScript **5.9**, ESM, `strict` | Native `fetch`, native `node:sqlite`, `Intl` timezones. Pin in `engines` (≥ 22.13) and `.nvmrc` (24, the active LTS) *(2026-09-12, D-007)*. TS 7.0 just shipped; stay on 5.9 to avoid tooling surprises. |
| GraphQL | `graphql-yoga` 5 with `graphql` 16, schema-first SDL | Small, spec-compliant, ships GraphiQL, and `yoga.fetch()` makes integration tests trivial without opening a port. Yoga's peer range is graphql 15–17; 16 is the most exercised *(2026-09-12: graphql 17.0 has been out since June; staying on 16, D-007)*. (Apollo Server would be equally fine; do not use both.) |
| Storage | SQLite via the built-in `node:sqlite` (`DatabaseSync`) | No native build step, one file, transactional, WAL. **Verified** working here (SQLite 3.52). Data volume is tens of KB per location. A Postgres port touches only the repository module (§5.4). |
| Validation | `zod` 4 | Parse Open-Meteo responses and env at the boundary; typed everywhere inside. |
| Logging | `pino` | One structured line per upstream call and refresher cycle. |
| Tests | `vitest` 4.1 *(2026-09-12: 5.0.0 shipped 2026-09-03, too fresh for a take-home; D-007)* | Fast, TypeScript-native, fake timers. |
| Dev | `tsx` for `npm run dev`; `tsc --noEmit` for typecheck | Minimal toolchain. |

Do **not** add: an ORM, Redis, a queue, Docker Compose with Postgres, `axios`, a date library, DataLoader, a plugin system, persisted scores. Runtime dependencies should stay around five.

---

## 4. Architecture

### 4.1 Request flow

```
activityRankings(city, countryCode?, activities?)
   │
   ▼
RankingService.rank()
   ├─► LocationService.resolve(city, countryCode)
   │      location_queries cache ──miss──► geocoding API ──► upsert locations ──► cache (hit or miss)
   ├─► ForecastService.getBundle(location)                 one call per source: weather, marine
   │      latest forecast_snapshots ──► freshness policy (§6) ──► serve | serve-stale + background refresh | fetch inline
   │      single-flight per (location, source); negative cache for inland marine
   ├─► extractDayFeatures(bundle, todayLocal)   → DayFeatures[7]        pure
   ├─► score(activity, features)               → ActivityDayScore[7]   pure
   └─► rank, build response
```

In the background, `RefreshScheduler` re-fetches non-fresh snapshots for locations requested in the last 24 h and prunes old rows.

### 4.2 Module layout

```
src/
  index.ts                       bootstrap: config → db → services → yoga → http server → scheduler; graceful shutdown
  config.ts                      zod-validated env (§9)
  logger.ts
  graphql/
    schema.graphql               SDL — single source of truth for the API (§8)
    resolvers.ts
    scalars.ts                   Date (YYYY-MM-DD), DateTime (ISO-8601 UTC)
    errors.ts                    GraphQLError factories with extensions.code
  domain/                        pure: no I/O, no Date.now(); fully unit-tested
    forecast/
      types.ts                   WeatherSnapshot, MarineSnapshot, HourlyRow, DayFeatures, DaySummary
      features.ts                extractDayFeatures(): windows, aggregation, null handling
      weatherCodes.ts            WMO table, severity order, human summaries
    scoring/
      curve.ts                   piecewise-linear desirability
      engine.ts                  criteria + gates → score, factors, label, confidence; rank()
      activities/
        skiing.ts  surfing.ts  outdoorSightseeing.ts  indoorSightseeing.ts  index.ts (registry)
  services/
    clock.ts                     Clock { now(): Date } — injected everywhere time matters
    locationService.ts
    forecastService.ts           freshness policy, single-flight, stale-while-revalidate
    rankingService.ts
    refreshScheduler.ts
  adapters/
    openMeteo/
      http.ts                    fetch wrapper: timeout, retry-once, User-Agent, typed UpstreamError
      schemas.ts                 zod schemas for the three responses
      geocodingClient.ts  forecastClient.ts  marineClient.ts
    db/
      database.ts                open, PRAGMAs, migrate() over migrations/*.sql
      migrations/001_init.sql
      locationRepository.ts  snapshotRepository.ts
test/
  fixtures/open-meteo/           captured JSON (see step 0)
  unit/  integration/
scripts/
  capture-fixtures.ts            hits the live API for the fixture cities, writes test/fixtures
  score-fixture.ts               prints a score table for a fixture — for eyeballing the curves
```

*(2026-09-12)* The SDL and the migration are embedded as TypeScript string modules — `graphql/schema.ts` and `adapters/db/migrations/001_init.ts` — so `tsc` output needs no asset-copy step (D-009). The tree above keeps the original names for the record.

Dependency rule: `domain` imports nothing from `services` or `adapters`. Services depend on interfaces (`ForecastClient`, `MarineClient`, `GeocodingClient`, `SnapshotRepository`, `LocationRepository`, `Clock`) so tests inject fakes. `fetch` is injected into the HTTP wrapper.

---

## 5. Data model and storage

### 5.1 Schema — `001_init.sql`

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE locations (
  id                INTEGER PRIMARY KEY,
  geonames_id       INTEGER NOT NULL UNIQUE,    -- Open-Meteo geocoding `id`; natural key
  name              TEXT    NOT NULL,
  country_code      TEXT,
  country           TEXT,
  admin1            TEXT,
  latitude          REAL    NOT NULL,
  longitude         REAL    NOT NULL,
  elevation_m       REAL,
  timezone          TEXT    NOT NULL,           -- IANA; defines "today" and the daytime windows
  population        INTEGER,
  created_at        TEXT    NOT NULL,           -- ISO-8601 UTC
  last_requested_at TEXT                        -- drives the background refresher
);

-- User query → location, including misses, so "paris" is geocoded once.
CREATE TABLE location_queries (
  query_key   TEXT PRIMARY KEY,                 -- normalize(name) + '|' + (countryCode ?? '')
  location_id INTEGER REFERENCES locations(id), -- NULL = negative cache ("not found")
  resolved_at TEXT NOT NULL
);

-- Immutable: "what Open-Meteo said about location L at instant T". Inserted, never updated; superseded by newer rows.
CREATE TABLE forecast_snapshots (
  id               INTEGER PRIMARY KEY,
  location_id      INTEGER NOT NULL REFERENCES locations(id),
  source           TEXT    NOT NULL CHECK (source IN ('weather', 'marine')),
  status           TEXT    NOT NULL CHECK (status IN ('ok', 'unavailable')),  -- 'unavailable' = inland marine
  fetched_at       TEXT    NOT NULL,            -- ISO-8601 UTC
  first_date       TEXT,                        -- local dates covered (YYYY-MM-DD); NULL when unavailable
  last_date        TEXT,
  grid_latitude    REAL,
  grid_longitude   REAL,
  grid_elevation_m REAL,                        -- the cell the model actually used
  payload          TEXT                         -- raw JSON body; NULL when unavailable
);
CREATE INDEX ix_snapshots_latest ON forecast_snapshots (location_id, source, fetched_at DESC);

CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
```

Query-key normalisation: `name.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ')` + `'|'` + `(countryCode ?? '').toUpperCase()` *(NFC added 2026-09-12, D-012)*.

### 5.2 Why raw JSON snapshots rather than normalised hourly rows

- The only read is "load the latest snapshot for one location"; nothing needs SQL across individual weather values.
- Immutable snapshots make refresh an insert, never an update, and are auditable ("what did we know at 09:00?").
- Scoring rules and windows will change while tuning. They recompute from stored raw data with no refetch. Persisting derived features or scores would freeze today's rules into the store.
- Adding a variable is a query-string change, not a migration.
- Size is trivial: ~30 KB per location per refresh, and retention keeps only a few rows.
- Accepted trade-off: no ad-hoc SQL analytics over weather values. If that were ever needed, add a derived `daily_features` table populated at ingest; the snapshot remains the source of truth.

### 5.3 Retention

The refresher deletes snapshots older than `SNAPSHOT_RETENTION_HOURS` (48) except the newest row per (location, source). Size stays bounded at roughly `locations × 2 × (48 h / TTL)` rows.

### 5.4 Portability

Repositories expose `getLatest(locationId, source)`, `insert(snapshot)`, `prune(olderThan)`, `findByQueryKey`, `upsertLocation`, `cacheQuery`, `touch(locationId)`, `recentlyRequested(since)`. Only `adapters/db` contains SQL. A Postgres port keeps the DDL with `JSONB` and `TIMESTAMPTZ` and adds `FOR UPDATE SKIP LOCKED` in the refresher.

---

## 6. Refresh policy

### 6.1 Freshness states, evaluated per snapshot at read time

Let `age = now − fetched_at`, `todayLocal` = the date of `now` in `location.timezone` (via `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })`), and `covers = first_date ≤ todayLocal ∧ last_date ≥ todayLocal + 6 days`.

| State | Condition | Behaviour |
|---|---|---|
| **fresh** | `age < TTL` and `covers` | Serve. |
| **stale** | `TTL ≤ age < MAX_STALE` and `covers` | Serve now with `stale: true`; start a background refresh (single-flight). |
| **expired / missing** | anything else | Fetch inline and serve the new snapshot. If the fetch fails → `UPSTREAM_UNAVAILABLE`. |
| **unavailable** (marine only) | `status = 'unavailable'` and `age < MARINE_UNAVAILABLE_TTL` | A valid answer: surfing not applicable. Re-checked weekly in case coverage changes. |

Defaults: `WEATHER_TTL_HOURS=3`, `MARINE_TTL_HOURS=6`, `MARINE_UNAVAILABLE_TTL_HOURS=168`, `MAX_STALE_HOURS=24`.

Why these numbers: Open-Meteo's blended forecast updates about hourly and the underlying models every 3–6 h, so refreshing more often than every 3 h spends calls without gaining information; wave models update less often. 24 h is where the 7-day window itself has moved, so nothing older is served.

Because we fetch 8 days, a snapshot taken at any time on local day D covers D+1 … D+7, so `covers` only fails when refresh has been impossible for a whole day. The stale state fills the gap between TTL expiry and the next refresh, so users never wait on Open-Meteo once a location is warm.

### 6.2 Single-flight

`ForecastService` keeps `inflight: Map<"locationId:source", Promise<Snapshot>>`. Every refresh, inline or background, goes through `refresh()`, which returns the pending promise if one exists and deletes the entry on settle. Ten simultaneous first requests for "Berlin" cause one geocoding call and one call per source. In-process only; a multi-instance deployment would use a jobs table with claim timestamps (out of scope, stated in README).

### 6.3 Background refresher

Every `REFRESH_INTERVAL_MINUTES` (10): load locations with `last_requested_at` within `REFRESH_ACTIVE_WINDOW_HOURS` (24); for each source that is not fresh, call `refresh()` sequentially with a short pause (polite to the free tier); then prune. Runs once shortly after start-up. `setInterval(...).unref()` so it never blocks shutdown; `REFRESH_ENABLED=false` in tests. Budget: 200 active locations × (8 weather + 4 marine calls/day) = 2,400 calls/day, well inside the free tier.

### 6.4 Failure handling

- HTTP: `AbortSignal.timeout(HTTP_TIMEOUT_MS)`, one retry after 500 ms on network errors and 5xx, no retry on 4xx. *(2026-09-12, D-012)* 429 is not retried either, since a second call within the same second cannot help, but it is `retryable: true` so a stale snapshot gets served. `User-Agent` is the constant `activity-forecast/1.0`. Errors are `UpstreamError { status?, retryable }`. A zod parse failure is treated as an upstream error and logged with its first issue.
- Weather fetch fails: serve stale if one exists (`stale: true`), else `UPSTREAM_UNAVAILABLE`.
- Marine fetch fails: serve stale marine if it exists; otherwise return the response with surfing `applicable: false` and note "wave data temporarily unavailable". A marine outage must not take down the other three activities. This is distinct from the stored `unavailable` snapshot (inland), whose note says there is no wave-model coverage.
- Geocoding fails: `UPSTREAM_UNAVAILABLE`. Misses are cached for `GEOCODE_MISS_TTL_HOURS` (24); hits for `GEOCODE_TTL_DAYS` (30). *(2026-09-12, D-012)* `searchLocations` is a pass-through with no cache and does not touch `last_requested_at`; a geocoder outage is `UPSTREAM_UNAVAILABLE` there too.
- Background refresh rejections are caught and logged; never an unhandled rejection.

---

## 7. From raw forecast to scores

### 7.1 Feature extraction — `domain/forecast/features.ts` (pure)

For each of the 7 target dates, take the hourly rows whose `time` starts with that date and whose local hour is inside the activity's window, then aggregate.

| Activity | Window (local) | Reason |
|---|---|---|
| Skiing | 09:00–16:00 | Lift hours. |
| Surfing | hours with `is_day = 1` (from the weather series; marine rows joined by `time`) | Daylight, which varies a lot by latitude and season. Fallback 06:00–18:00 if no daylight hours (polar night). |
| Outdoor sightseeing | 09:00–18:00 | A touring day. Rain at 03:00 should not count. |
| Indoor sightseeing | same as outdoor | Derived from the outdoor result. |

`DayFeatures` (every field `number | undefined`; aggregation skips nulls; a field is `undefined` when every input is null):

```
tempMeanC  apparentMeanC  apparentMaxC
precipMm  precipHours (hours with ≥ 0.1 mm)  rainMm (liquid, §2.2)  snowfallCm (window)  snowfallDayCm (daily snowfall_sum)
precipProbMean  precipProbMax
cloudMeanPct  sunshineFraction (daily sunshine_duration / daylight_duration)
windMeanKmh  windMaxKmh  gustMaxKmh  visibilityMinM  snowDepthMaxM
weatherCodes (set in window)  worstWeatherCode
waveHeightMeanM  waveHeightMaxM  swellPeriodMeanS  wavePeriodMeanS  windWaveHeightMeanM  seaSurfaceTempC
```

Also build a chronological `DaySummary` per date from the daily block (for the `days` field). DST days have 23 or 25 rows; prefix-matching on the date string handles that with no special case. Date arithmetic (`todayLocal + 6`) is done on `YYYY-MM-DD` strings via `Date.UTC`, which is safe for date-only values.

### 7.2 Scoring engine — `domain/scoring/engine.ts`

```ts
type Curve = ReadonlyArray<readonly [x: number, y: number]>;   // sorted by x; linear between points; clamped outside
type Criterion = { name: string; weight: number; feature: keyof DayFeatures; curve: Curve; format: (v: number) => string };
type Gate = { name: string; apply: (f: DayFeatures) => { effect: number; value?: string; note?: string } | undefined };
type ActivityRules = { window: Window; criteria: Criterion[]; gates: Gate[]; applicable?: (f: DayFeatures) => string | undefined };
```

- **Criterion** contributes `weight × desirability(feature)`; desirability is the curve value in [0, 1].
- **Gate** returns a multiplier in [0, 1], normally 1. Gates model "unsafe or impossible" (thunderstorm, no snow, flat sea), which a weighted average would wrongly dilute. *(2026-09-12, D-011: also anything that dominates the day regardless of the rest, such as rain on snow, a whiteout or a washout. Working the numbers showed the weighted average padding those cases into GOOD and EXCELLENT.)*
- **Score** `= round(100 × Σ(wᵢ·dᵢ) / Σwᵢ × Π gates)`, sums over criteria whose feature is present. Missing data renormalises the weights (it neither counts as 0 nor 1) and lowers confidence. If no criterion has data, the day is `NOT_APPLICABLE` with note "insufficient data".
- **Label**: ≥ 80 EXCELLENT · ≥ 60 GOOD · ≥ 40 FAIR · ≥ 20 POOR · else UNSUITABLE; `NOT_APPLICABLE` when the activity cannot be assessed.
- **Confidence** (reported, never folded into the score): by lead time `[0.95, 0.90, 0.80, 0.70, 0.60, 0.50, 0.45]` for day 0…6, minus 0.1 if any criterion was skipped for missing data, floored at 0.2. A stated heuristic; the honest upgrade is Open-Meteo's Ensemble API (member spread). Snapshot age is not folded in either; it is exposed as `weatherFetchedAt`, `marineFetchedAt` and `stale` *(2026-09-12, D-012)*.
- **Ranking**: score desc, then confidence desc, then date asc; rank 1…7. Days that are `NOT_APPLICABLE` for lack of data sort after every scored day, by date *(2026-09-12, D-012)*.
- **Factors**: every criterion (`effect` = desirability, `weight`) and every gate with `effect < 1`. Gates first, then criteria by `weight × (1 − effect)` descending, so the first factor is always the biggest reason the score is not 100. `value` is a formatted string with unit and statistic, e.g. `"-4.2 °C daytime mean"`.

### 7.3 Skiing — window 09:00–16:00

Gates

| Gate | Feature | Rule |
|---|---|---|
| snowCover | `snowDepthMaxM` | `[[0.02, 0], [0.10, 0.5], [0.30, 1]]`. If undefined → 0.5, note "snow depth not provided by model", confidence −0.2. |
| liftWind | `gustMaxKmh` | `[[50, 1], [80, 0.2], [100, 0]]` |
| severe | codes | thunderstorm (95, 96, 99) → 0.1; freezing rain/drizzle (56, 57, 66, 67) → 0.3 |
| rainOnSnow *(2026-09-12, D-011)* | `rainMm` | `[[0.5, 1], [3, 0.5], [8, 0.25]]`. Rain ruins the surface no matter how good the rest is; as a criterion alone, a 5 mm day at +1 °C still scored GOOD (60 under grey skies, 74 with everything else ideal). |
| whiteout *(2026-09-12, D-011)* | `visibilityMinM` | `[[100, 0.2], [500, 0.6], [1000, 1]]`. A 150 m day scored 82 when visibility was only a criterion. |

Criteria

| Criterion | w | Feature | Curve | Rationale |
|---|---|---|---|---|
| temperature | 3 | `tempMeanC` | `[[-25,0],[-15,0.7],[-10,1],[-2,1],[2,0.6],[6,0.2],[10,0]]` | Dry, firm snow between −10 and −2 °C; slush above +2; dangerous cold below −20. |
| freshSnow | 1 | `snowfallDayCm` | `[[0,0.5],[3,0.7],[10,1],[25,0.8],[40,0.4]]` | New snow is a bonus; 40 cm means closures and whiteout. |
| wind | 2 | `windMeanKmh` | `[[0,1],[15,1],[30,0.6],[45,0.25],[60,0]]` | Wind chill and lift holds. |
| visibility | 2 | `visibilityMinM` | `[[100,0],[500,0.3],[1000,0.5],[3000,0.8],[8000,1]]` | Fog, whiteout. |
| sky | 1 | `cloudMeanPct` | `[[0,1],[40,0.9],[80,0.6],[100,0.4]]` | Flat light under overcast. |
| rain | 2 | `rainMm` | `[[0,1],[0.5,0.7],[2,0.3],[5,0]]` | Rain on snow ruins the surface. |

### 7.4 Surfing — window: daylight hours

Applicable iff the marine snapshot has `status = 'ok'`. Otherwise `applicable: false` with note "No wave-model coverage near {name}; Open-Meteo's marine grid returns no data for inland locations." Days are still listed, in date order with ranks 1–7 by position, score 0 and `NOT_APPLICABLE`, so the response shape is uniform *(ordering made explicit 2026-09-12, D-012)*.

Gates

| Gate | Feature | Rule |
|---|---|---|
| flat | `waveHeightMeanM` | `[[0.2, 0], [0.4, 0.5], [0.7, 1]]` *(2026-09-12, D-011: was `[[0.2, 0], [0.3, 0.3], [0.4, 1]]`. With the old gate a 0.6 m / 7 s day scored 67 GOOD because the comfort criteria padded it; small waves now cap the day.)* |
| dangerous | `waveHeightMaxM` | `[[3.5, 1], [5, 0.3], [6, 0]]` |
| storm | `gustMaxKmh` | `[[60, 1], [90, 0]]` |
| severe | codes | thunderstorm → 0.05 (lightning on open water) |

Criteria

| Criterion | w | Feature | Curve | Rationale |
|---|---|---|---|---|
| waveHeight | 4 | `waveHeightMeanM` | `[[0.3,0.2],[0.6,0.5],[1.0,0.9],[1.5,1],[2.5,1],[3.0,0.7],[4.0,0.3]]` | 1–2.5 m suits most surfers. |
| period | 3 | `swellPeriodMeanS`, fallback `wavePeriodMeanS` | `[[4,0],[6,0.3],[8,0.6],[10,0.85],[12,1],[16,1],[20,0.9]]` | Long-period groundswell is clean and powerful; short period is wind chop. |
| wind | 3 | `windMeanKmh` | `[[0,1],[10,1],[20,0.7],[30,0.4],[45,0.1],[60,0]]` | Light wind is glassy. Direction relative to shore is unknown (no coastline model), so speed only. Stated limitation. |
| cleanliness | 1 | `windWaveHeightMeanM / waveHeightMeanM` | `[[0.2,1],[0.5,0.7],[0.8,0.4],[1,0.2]]` | Share of the sea state that is local chop. |
| waterTemp | 1 | `seaSurfaceTempC` | `[[6,0.2],[12,0.6],[16,0.85],[20,1],[30,1]]` | Comfort only; wetsuits exist. |
| airComfort | 1 | `apparentMeanC` | `[[0,0.2],[10,0.6],[18,1],[32,1],[38,0.6]]` | |
| rain | 0.5 | `precipHours` | `[[0,1],[3,0.8],[8,0.5]]` | You are wet anyway. |

### 7.5 Outdoor sightseeing — window 09:00–18:00

Gates

| Gate | Feature | Rule |
|---|---|---|
| severe | codes | thunderstorm → 0.15; freezing rain → 0.3 |
| dangerousWind | `gustMaxKmh` | `[[70, 1], [90, 0.4], [110, 0.1]]` |
| extremeHeat | `apparentMaxC` | `[[38, 1], [42, 0.5], [46, 0.2]]` |
| fog | `visibilityMinM` | `[[200, 0.6], [1000, 1]]` (views obscured) |
| washout *(2026-09-12, D-011)* | `precipHours` | `[[2, 1], [4, 0.7], [6, 0.4], [9, 0.2]]`. Hours of rain dominate a touring day; as a criterion alone, 6 h of rain still scored 51 because temperature, wind and sky were fine. |

Criteria

| Criterion | w | Feature | Curve | Rationale |
|---|---|---|---|---|
| rainHours | 4 | `precipHours` | `[[0,1],[1,0.8],[2,0.6],[4,0.3],[6,0.1],[9,0]]` | Hours of rain during the touring day is the strongest single driver. |
| rainAmount | 1 | `precipMm` | `[[0,1],[1,0.9],[5,0.6],[15,0.2],[30,0]]` | Separates drizzle from downpour. |
| rainRisk | 2 | `precipProbMean` | `[[0,1],[20,0.9],[40,0.7],[60,0.4],[80,0.15],[100,0]]` | Forecast uncertainty: a 70 % chance matters even when the deterministic run is dry. |
| temperature | 3 | `apparentMeanC` | `[[-10,0],[0,0.3],[8,0.6],[14,0.9],[18,1],[26,1],[30,0.75],[34,0.4],[38,0.1]]` | Feels-like folds in wind and humidity. |
| wind | 2 | `windMeanKmh` | `[[0,1],[15,1],[25,0.8],[35,0.5],[50,0.2],[65,0]]` | |
| sky | 2 | `sunshineFraction` | `[[0,0.5],[0.3,0.7],[0.6,0.9],[1,1]]` | Sun is nice, but overcast is still a fine sightseeing day. Mild. |
| snow | 1 | `snowfallCm` | `[[0,1],[2,0.7],[8,0.3],[20,0]]` | Walking in falling snow. |

### 7.6 Indoor sightseeing — derived

`indoor = round(100 × (0.55 + 0.45 × (1 − outdoor / 100)) × travelGate)`

- Floor of 55 (FAIR) on a perfect day: museums are always an option, but you would be missing the weather. Ceiling 100 when outdoors is hopeless. Indoor and outdoor rankings are therefore near mirror images, which is exactly the planning signal ("do the galleries on Tuesday when it rains").
- `travelGate`: gusts ≥ 100 km/h → 0.6; blizzard (`snowfallDayCm ≥ 15` with `gustMaxKmh ≥ 50`, or codes 75/86 with gusts ≥ 50) → 0.7; apparent mean ≤ −25 °C → 0.75; apparent max ≥ 42 °C → 0.85; thunderstorm → 0.9. Moving between venues is the only way weather hurts an indoor day.
- Factors: `outdoorConditions` (effect `= 1 − outdoor/100`, note e.g. "outdoor score 23: strong case for an indoor day") plus any travel gate.
- README must say plainly: venue opening days and hours dominate real indoor planning and are out of scope.

### 7.7 Sanity checks

*(2026-09-12, D-011)* The original list at the end of this section was a poor gate: two of its claims do not follow from the curves (a 0.6 m / 7 s surf day scores 67 GOOD, not FAIR; an outdoor day with 6 h of rain scores 51 FAIR, not ≤ 20), and the rest depend on whatever weather the fixtures happened to capture. The gate is now the table below: one hand-built `DayFeatures` per row, one unit test per row, asserting the band. The reference score was computed from the §7.3–7.6 curves with the D-011 gates on 2026-09-12; assert the band, not the number.

| Activity | Hand-built `DayFeatures` | Band | Ref |
|---|---|---|---|
| Skiing | ideal: −6 °C mean, snow depth 0.5 m, 10 cm fresh, wind 8, gusts 20, visibility 10 km, cloud 20 %, rain 0, code 0 | ≥ 85, EXCELLENT | 100 |
| Skiing | no snow: ideal with snow depth 0 | ≤ 5, UNSUITABLE; first factor is `snowCover` | 0 |
| Skiing | rain on snow: +1 °C, rain 5 mm, depth 0.5 m, cloud 100 %, visibility 3 km, wind 15, gusts 25, fresh 0, code 61 | ≤ 30 | 24 |
| Skiing | whiteout: ideal with visibility 150 m | ≤ 25 | 21 |
| Skiing | thunderstorm: ideal with code 95 | ≤ 10 | 10 |
| Surfing | ideal: 1.5 m mean / 1.8 m max, 12 s swell, wind 8, gusts 15, wind-wave 0.3 m, SST 20, apparent 22, 0 rain h, code 1 | ≥ 85 | 100 |
| Surfing | small and weak: 0.6 m / 0.8 m max, 7 s, wind 15, gusts 25, wind-wave 0.3 m, SST 18, apparent 20, code 1 | 40–65, FAIR or low GOOD | 56 |
| Surfing | flat: ideal with 0.3 m / 0.4 m max, 10 s, wind 5 | ≤ 20 | 17 |
| Surfing | thunderstorm: ideal with code 95 | ≤ 5 | 5 |
| Surfing | no marine data | `applicable: false`; every day NOT_APPLICABLE with score 0 | — |
| Outdoor | ideal: apparent mean 24 °C / max 28, 0 rain h, 0 mm, prob 5 %, wind 10, gusts 20, sunshine 0.9, visibility 20 km, snow 0, code 0 | ≥ 85 | 99 |
| Outdoor | showers: ideal with 2 rain h, 3 mm, prob 50 %, apparent 18 / 21, wind 12, sunshine 0.4, code 80 | 60–85 | 79 |
| Outdoor | washout: ideal with 6 rain h, 12 mm, prob 85 %, apparent 14 / 16, wind 20, gusts 35, sunshine 0.1, code 63 | ≤ 25 | 20 |
| Outdoor | thunderstorm: ideal with code 95 | ≤ 20 | 15 |
| Indoor | from outdoor 100, no travel gate | exactly 55, FAIR | 55 |
| Indoor | from outdoor 0 | 100 | 100 |
| Indoor | from the washout day | ≥ 85 | 91 |
| Indoor | blizzard: outdoor 10, snowfall 20 cm, gusts 60 (travel gate 0.7) | ≤ 75 | 67 |

Invariants, tested on the fixtures and on generated inputs: every score within [0, 100]; 7 days per activity; ranks 1–7 unique; factors ordered by influence; gates multiply; with every travel gate at 1 the indoor order is the reverse of the outdoor order.

Plausibility run, after the bands pass: `npm run score-fixture -- chamonix|lisbon|denver`. Paste the tables into the worklog and note anything that looks wrong. A wrong-looking number becomes a new row above (a failing test) before any curve moves.

The original 2026-09-10 list (Chamonix skiing UNSUITABLE in September, a Lisbon 0.6 m / 7 s day "around FAIR", Denver indoor best on the wettest day) was fixture-dependent and partly wrong; see D-011.

---

## 8. GraphQL API

### 8.1 SDL — `src/graphql/schema.graphql`

```graphql
"""Calendar date in the location's local timezone, YYYY-MM-DD."""
scalar Date
"""ISO-8601 instant in UTC."""
scalar DateTime

enum Activity { SKIING SURFING OUTDOOR_SIGHTSEEING INDOOR_SIGHTSEEING }
enum Suitability { EXCELLENT GOOD FAIR POOR UNSUITABLE NOT_APPLICABLE }
enum FactorKind { CRITERION GATE }

type Query {
  """Rank the next 7 days (today + 6, local time) for each activity at a city or town."""
  activityRankings(
    city: String!
    "ISO 3166-1 alpha-2 (e.g. \"US\") to disambiguate names like Paris or Springfield."
    countryCode: String
    "Defaults to all four."
    activities: [Activity!]
  ): ActivityRankings!

  """Candidate places for a name, in the geocoder's relevance order. Use to disambiguate."""
  searchLocations(query: String!, countryCode: String, limit: Int = 5): [Location!]!
}

type ActivityRankings {
  location: Location!
  forecast: ForecastMeta!
  "Chronological weather summary for the 7 days."
  days: [DaySummary!]!
  "One entry per requested activity."
  rankings: [ActivityRanking!]!
}

type Location {
  "GeoNames id from the geocoder; stable across databases."
  id: ID!
  name: String!
  country: String
  countryCode: String
  admin1: String
  latitude: Float!
  longitude: Float!
  elevationM: Float
  timezone: String!
}

type ForecastMeta {
  "Always \"open-meteo\"."
  source: String!
  weatherFetchedAt: DateTime!
  marineFetchedAt: DateTime
  "True when either served snapshot is past its freshness TTL (a refresh is in progress, or upstream was unavailable)."
  stale: Boolean!
  marineAvailable: Boolean!
  "Distance from the town to the wave-model cell used, when marine data exists."
  marineCellDistanceKm: Float
  timezone: String!
}

"""Every measurement is nullable *(2026-09-14, D-022)*: Open-Meteo may omit any value, and one gap should cost that value rather than the whole response."""
type DaySummary {
  date: Date!
  weatherCode: Int
  "Human summary of the WMO code, e.g. \"Light rain\"."
  summary: String!
  tempMaxC: Float
  tempMinC: Float
  precipitationMm: Float
  precipitationProbabilityMax: Int
  snowfallCm: Float
  windMaxKmh: Float
  sunshineHours: Float
  waveHeightMaxM: Float
}

type ActivityRanking {
  activity: Activity!
  applicable: Boolean!
  "Why the activity cannot be assessed here, or a general caveat."
  note: String
  "Best day first."
  days: [ActivityDayScore!]!
}

type ActivityDayScore {
  date: Date!
  rank: Int!
  "0–100."
  score: Int!
  suitability: Suitability!
  "0–1; decays with forecast lead time and missing data."
  confidence: Float!
  "Most influential first."
  factors: [ScoreFactor!]!
}

type ScoreFactor {
  name: String!
  kind: FactorKind!
  "Human-readable value with units, e.g. \"1.4 m mean wave height\"."
  value: String!
  "Criterion desirability or gate multiplier, 0–1."
  effect: Float!
  weight: Float
  note: String
}
```

### 8.2 Example query

```graphql
query {
  activityRankings(city: "Lisbon") {
    location { name countryCode timezone }
    forecast { stale weatherFetchedAt marineAvailable marineCellDistanceKm }
    rankings {
      activity applicable note
      days { rank date score suitability confidence factors { name kind value effect } }
    }
  }
}
```

### 8.3 Errors — `GraphQLError` with `extensions.code`

| Code | When |
|---|---|
| `BAD_USER_INPUT` | `city` or `query` empty or over 100 chars after trimming, country code not two letters, `limit` outside 1–10, an empty `activities` list (duplicates are collapsed, order kept) *(activities and query rules added 2026-09-12, D-012)* |
| `LOCATION_NOT_FOUND` | geocoder returns nothing (negative-cached) |
| `UPSTREAM_UNAVAILABLE` | Open-Meteo unreachable and no servable snapshot |

Yoga masks unexpected errors by default. Keep that; throw `GraphQLError` only for the cases above.

---

## 9. Configuration — `config.ts`, zod-validated, `.env.example` committed

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | |
| `DB_PATH` | `./data/app.db` | `:memory:` in tests |
| `OPEN_METEO_GEOCODING_URL` | `https://geocoding-api.open-meteo.com/v1/search` | |
| `OPEN_METEO_FORECAST_URL` | `https://api.open-meteo.com/v1/forecast` | |
| `OPEN_METEO_MARINE_URL` | `https://marine-api.open-meteo.com/v1/marine` | |
| `HTTP_TIMEOUT_MS` | `5000` | |
| `WEATHER_TTL_HOURS` / `MARINE_TTL_HOURS` | `3` / `6` | fresh window |
| `MARINE_UNAVAILABLE_TTL_HOURS` | `168` | negative cache for inland locations |
| `MAX_STALE_HOURS` | `24` | beyond this, refresh inline |
| `GEOCODE_TTL_DAYS` / `GEOCODE_MISS_TTL_HOURS` | `30` / `24` | |
| `REFRESH_ENABLED` / `REFRESH_INTERVAL_MINUTES` / `REFRESH_ACTIVE_WINDOW_HOURS` | `true` / `10` / `24` | |
| `SNAPSHOT_RETENTION_HOURS` | `48` | |
| `LOG_LEVEL` | `info` | |

*(2026-09-12, D-012)* No dotenv. `npm start` runs `node --env-file-if-exists=.env dist/index.js` (Node ≥ 22.9); `npm run dev` uses the defaults or exported variables. `.npmrc` sets `engine-strict=true` so `npm ci` on an unsupported Node fails immediately instead of failing later on `node:sqlite`.

---

## 10. Testing strategy — Vitest, no network in tests

- **Curve and engine**: interpolation at, between, below and above points; weight renormalisation when a feature is missing; gates multiply; labels at boundaries (79 vs 80); ranking tie-breaks; factor ordering.
- **Each activity**: three hand-built `DayFeatures` — ideal, marginal, gated — with asserted score bands (skiing ideal ≥ 85, no snow ≤ 5; surfing thunderstorm ≤ 5; outdoor with 6 h of rain ≤ 20). Indoor is the inverse of outdoor across a sweep. All scores within [0, 100].
- **Feature extraction** from the Chamonix fixture: correct hours per window; `is_day` fallback; null tolerance; 8-day payload → 7 days from an injected "today"; a date-boundary case in a non-UTC zone (Sydney at 23:30 UTC); weather/marine join by `time` when the snapshots start on different dates.
- **ForecastService** with fake clock, repo and clients: fresh → no fetch; stale → served and background fetch called once; expired → inline fetch; upstream failure with stale → served `stale: true`; without → `UPSTREAM_UNAVAILABLE`; ten concurrent calls → one fetch; inland marine → `unavailable` stored and not refetched within TTL; marine outage → surfing not applicable, other activities fine.
- **LocationService**: cache hit skips the geocoder; miss is negative-cached; `countryCode` forwarded; key normalisation.
- **Adapters**: zod schemas accept every fixture, including the all-null marine one; absent `results` → `[]`; 500 → retried once, then `UpstreamError`; 400 → not retried.
- **Integration**: `yoga.fetch('/graphql', …)` end-to-end with in-memory SQLite and stub clients backed by fixtures; assert shape (7 days × 4 activities, unique ranks), one `LOCATION_NOT_FOUND`, one `UPSTREAM_UNAVAILABLE`.

---

## 11. Implementation steps — in order, each with a definition of done

Superseded on 2026-09-12 by [PHASES.md](PHASES.md), which regroups the original eleven linear steps into eight phases with a dependency graph and per-phase definitions of done (D-008). The steps are not repeated here.

---

## 12. README outline — what the submission must explain

1. What it does, in one paragraph; the example query and a trimmed response.
2. Run it: `npm i`, `npm run dev`, GraphiQL URL; `npm test`. Node 22.13+ requirement and why.
3. Design: the §4.1 flow; why SQLite with immutable raw snapshots; the §6.1 policy table; single-flight; failure modes.
4. Scoring: the criteria-and-gates model in one paragraph, the four activity tables (copy from §7), the indoor rationale, and how to read `factors`.
5. Assumptions and limitations: §1 decisions, plus no coastline orientation, valley-floor skiing, heuristic confidence, venue hours ignored, in-process scheduler is single-instance.
6. What I would do next: Ensemble API for real confidence; resort/beach lookup for elevation-aware skiing and shore-aware surfing; Postgres plus a jobs table for multi-instance; derived feature table if analytics are ever needed.

---

## 13. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Ambiguous place names | Geocoder prominence order, `countryCode`, `searchLocations`. |
| Open-Meteo down or slow | Timeout, one retry, stale-while-revalidate, serve stale up to 24 h; a marine outage degrades only surfing. |
| Thundering herd on a cold cache | Single-flight per (location, source). |
| Free-tier rate limit | TTLs; background refresh only for recently used locations; budget in §6.3. |
| Scoring thresholds are opinions | They are data (one curve table per activity), unit-tested with bands, explained in the README, and every response lists its factors so a reviewer can see *why*. |
| Reviewer's Node lacks `node:sqlite` | `engines`, `.nvmrc`, README note. If someone is stuck on Node 20, the repository module is the only thing to swap for `better-sqlite3`. |
| Timezone bugs | "Today" and windows are computed in the location's IANA zone via `Intl.DateTimeFormat`; tests include the Sydney-at-UTC-midnight case. |
| Weather/marine snapshots fetched on different days | Hourly rows are joined by `time` string, never by index (§2.3). |
