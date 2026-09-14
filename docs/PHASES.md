# Implementation phases

This is the order of work for the implementing agent and the person driving it. The *what and why* is in [DESIGN.md](DESIGN.md); sections there are cited as D§n. This file says *when*, *in what order*, and *what "done" means*. It regroups the 11 linear steps of D§11 (2026-09-10) into eight phases with a dependency graph, per-phase definitions of done and stop-and-ask points (D-008, 2026-09-12). All eight phases are in scope; cut lines were considered and dropped (D-010).

## Working agreement (short form; the full rules are in [../AGENTS.md](../AGENTS.md))

- One phase at a time, started with `/phase N`. A phase is finished when every DoD box is ticked, `npm run check` is green, the `phase-reviewer` agent passes, WORKLOG.md has an entry, and the work is committed.
- Read the cited design sections before writing code. Do not re-derive what they settle.
- Deviating from the design is allowed when the code proves the plan wrong. Log it (DECISIONS.md entry, one WORKLOG.md line) and continue.
- Product ambiguity: add a QUESTIONS.md entry with the assumption you chose, then continue.
- Stop and ask the user before: adding a dependency; changing the SDL in D§8.1; changing a TTL default in D§9; dropping a test category from D§10; building anything on the "do not" lists in D§1 and D§3.

## Dependency graph

```
P0 foundation
 │
 ├── P1 domain (pure)  ─┐
 ├── P2 adapters        ├── P4 services ── P5 GraphQL + bootstrap ── P6 refresher ── P7 ship
 └── P3 storage        ─┘
```

P1, P2 and P3 share no code. In a single session do them in that order: P1 fixes the payload types that P2's schemas must produce. With parallel agents, give each its own git worktree and merge all three before P4.

## Scope

Everything below is in scope. Cut lines (dropping the refresher, `confidence`, `searchLocations` or the Dockerfile) were considered and rejected on 2026-09-12 (D-010): the whole plan is about 15 hours, and the refresher and `searchLocations` are the parts that show the refresh policy and the disambiguation actually working. If time runs out anyway, the worklog says what was dropped and why.

## Effort and risk

| Phase | Estimate | Main risk |
|---|---|---|
| P0 foundation | 1 h | none |
| P1 domain | 3 h | a band test exposing a curve problem; day-boundary bugs |
| P2 adapters | 1.5 h | none, fixtures are captured |
| P3 storage | 1.5 h | `node:sqlite` API differs from better-sqlite3 in small ways |
| P4 services | 3 h | freshness state machine and failure matrix; single-flight races |
| P5 API + bootstrap | 2 h | wiring; first live-run surprises |
| P6 refresher | 1 h | timer tests |
| P7 ship | 2 h | README honesty; fresh-clone run |

About 15 h of focused work. Estimates are for a person driving an agent, not for the agent alone.

---

## Phase 0 — Foundation

**Goal.** A repo where `npm run check` is green, CI runs the same command, a pre-commit hook refuses red commits, and Open-Meteo fixtures exist so no later phase touches the network from a test.

**Read.** D§3 (stack), D§2 (what to capture), D§9 (env).

**Files.**
```
package.json  package-lock.json  tsconfig.json  tsconfig.build.json  vitest.config.ts
.nvmrc  .npmrc  .gitattributes  .editorconfig  .env.example
.githooks/pre-commit
.github/workflows/ci.yml
src/index.ts                          placeholder: logs "not implemented yet", exits 0
test/unit/smoke.test.ts
scripts/capture-fixtures.ts
test/fixtures/open-meteo/*.json       + test/fixtures/README.md
```

**Steps.**

1. `package.json`. Declare dependencies by hand with the pins from D-007, then run a bare `npm install` (the guard hook blocks `npm install <pkg>` on purpose; see AGENTS.md).
   ```json
   {
     "name": "activity-forecast",
     "private": true,
     "license": "MIT",
     "type": "module",
     "engines": { "node": ">=22.13" },
     "scripts": {
       "dev": "tsx watch src/index.ts",
       "build": "tsc -p tsconfig.build.json",
       "start": "node --env-file-if-exists=.env dist/index.js",
       "typecheck": "tsc -p tsconfig.json --noEmit",
       "test": "vitest run",
       "test:watch": "vitest",
       "check": "npm run typecheck && npm run test",
       "capture-fixtures": "tsx scripts/capture-fixtures.ts",
       "score-fixture": "tsx scripts/score-fixture.ts",
       "prepare": "git config core.hooksPath .githooks || exit 0"
     },
     "dependencies": { "graphql": "^16.14.0", "graphql-yoga": "^5.23.0", "pino": "^10.3.0", "zod": "^4.6.0" },
     "devDependencies": { "@types/node": "^24.13.0", "tsx": "^4.23.0", "typescript": "~5.9.3", "vitest": "^4.1.0" }
   }
   ```
2. `tsconfig.json`: `module` and `moduleResolution` `NodeNext`, `target` `ES2022`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `types: ["node"]`, `include: ["src", "test", "scripts"]`. `tsconfig.build.json` extends it with `include: ["src"]`, `rootDir: "src"`, `outDir: "dist"`, `noEmit: false`.
3. `vitest.config.ts`: `test.include = ['test/**/*.test.ts']`, `environment: 'node'`, `restoreMocks: true`.
4. `.nvmrc` = `24`. `.npmrc`: `engine-strict=true`, so `npm ci` fails at once on an unsupported Node. `.gitattributes`: `* text=auto eol=lf`, so a Windows checkout never commits CRLF (the pre-commit script must be LF to run on Linux). `.editorconfig`: 2 spaces, LF, UTF-8, final newline. `.env.example`: every D§9 variable with its default; no dotenv, `.env` is optional and read by `npm start` through Node's `--env-file-if-exists` (D-012).
5. `.githooks/pre-commit` (`#!/bin/sh`, `npm run check`), made executable in git: `git update-index --chmod=+x .githooks/pre-commit`. `npm install` wires it via `prepare`.
6. `.github/workflows/ci.yml`:
   ```yaml
   name: ci
   on: { push: { branches: [main] }, pull_request: {} }
   jobs:
     check:
       runs-on: ubuntu-latest
       strategy: { matrix: { node: [22, 24] } }
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: "${{ matrix.node }}", cache: npm }
         - run: npm ci
         - run: npm run check
   ```
7. `scripts/capture-fixtures.ts`: for Chamonix, Lisbon and Denver fetch geocoding (`count=5`), then forecast and marine with the exact D§2.2 and D§2.3 variable lists and `timezone=<the geocoded IANA zone>` rather than `auto` (D-012). Also fetch geocoding for `Springfield` (`count=10`, ambiguous) and for a nonsense string (no `results` key). Write pretty JSON to `test/fixtures/open-meteo/<kind>.<city>.json`. Write `test/fixtures/README.md` with: capture date, the exact query strings, each forecast fixture's first `daily.time` value (tests inject that date as "today"), and which marine files are the all-null inland case (Chamonix, Denver). Lisbon is the coastal case.
8. Run `npm run capture-fixtures` once. Never re-run it casually: tests depend on the captured dates.

**Tests.** `smoke.test.ts` asserts something trivial; P1 replaces it.

**DoD.**
- [x] `npm run check` green after a clean `npm ci`.
- [x] a commit with a failing test is rejected by the pre-commit hook (try once, revert).
- [x] fixtures: 5 geocoding, 3 forecast, 3 marine files; README records date, first daily date per fixture, and the all-null marine files.
- [x] CI workflow present with the Node 22 and 24 matrix (its first green run is confirmed in P7 after the push).

**Commits.** `chore: scaffold TypeScript/Node 24 project with vitest, CI and pre-commit check` · `test: capture Open-Meteo fixtures for Chamonix, Lisbon and Denver`.

---

## Phase 1 — Domain: features and scoring (pure)

**Goal.** Given parsed weather and marine payloads and a local "today", produce seven `DayFeatures` per activity window and four ranked activity results with factors. No I/O, no clock, no imports from `services/` or `adapters/`.

**Read.** D§2.2–2.4 (time format, units, null policy, WMO codes), D§7 in full, D§10 bullets 1–3.

**Files.**
```
src/domain/forecast/types.ts           WeatherPayload, MarinePayload (parsed Open-Meteo shapes; P2's zod output must be assignable to these), HourlyRow, DayFeatures, DaySummary, Activity
src/domain/forecast/weatherCodes.ts    WMO table, severity order, human summaries
src/domain/forecast/localDate.ts       addDays('YYYY-MM-DD', n), compare — via Date.UTC, no library
src/domain/forecast/features.ts        extractDayFeatures(bundle, todayLocal, window) → DayFeatures[7]; summariseDays(bundle, todayLocal) → DaySummary[7]
src/domain/scoring/curve.ts            piecewise-linear desirability
src/domain/scoring/engine.ts           scoreDay, rankDays, label, confidence, factor ordering
src/domain/scoring/activities/{skiing,surfing,outdoorSightseeing,indoorSightseeing,index}.ts
scripts/score-fixture.ts               prints the D§7.7 table for one fixture city
test/unit/domain/**
```

**Steps.**
1. Types first. `WeatherPayload` and `MarinePayload` mirror D§2.2 and D§2.3 with every array element `number | null`. `Activity` is the string union `'SKIING' | 'SURFING' | 'OUTDOOR_SIGHTSEEING' | 'INDOOR_SIGHTSEEING'`, identical to the GraphQL enum so P5 needs no mapping.
2. `weatherCodes.ts` and `localDate.ts`, with tests.
3. `features.ts`: select hourly rows by `time` prefix and local hour; join marine rows by the `time` string (D§2.3); aggregation skips nulls; a field is `undefined` only when every input was null; `is_day` window with the 06–18 fallback; `sunshineFraction` from the daily block; liquid rain per D§2.2. Fixture tests: window sizes for Chamonix, null tolerance, Sydney at 23:30 UTC (small synthetic payload), weather and marine starting on different dates.
4. `curve.ts` and `engine.ts` per D§7.2, tests first: interpolation, clamping, weight renormalisation, gates multiply, labels at 79/80, tie-breaks, factor order.
5. The four activities per D§7.3–7.6 as data (curves, weights, gates, including the D-011 gates: `rainOnSnow` and `whiteout` for skiing, `washout` for outdoor, the softened `flat` for surfing) and a registry keyed by `Activity`.
6. `scripts/score-fixture.ts`: reads a fixture from disk (scripts may do I/O; domain may not), sets `todayLocal` to the fixture's first daily date, prints per activity: date, score, label, top factor. This is a plausibility run, not a gate. Run it for all three cities, paste the trimmed tables into WORKLOG.md, and note anything that looks off. A number that looks wrong becomes a new hand-built case in the band tests before any curve is touched.

**Tests.** D§10 bullets 1–3; the D§7.7 band table, one test per row asserting the band and never the reference number; the D§7.7 invariants.

**DoD.**
- [x] D§10 bullets 1–3 implemented and green; every row of the D§7.7 band table is a test.
- [x] `npm run score-fixture -- chamonix`, `lisbon`, `denver` print tables; they are in WORKLOG.md with a line on anything that looked off.
- [x] `grep -rn "services/\|adapters/\|Date.now\|new Date()" src/domain` finds nothing.

**Stop-and-ask.** If a band test fails, the fix is either the curve or the band; say which and why in DECISIONS.md. Never move a curve to make a fixture look better.

**Commits.** `feat(domain): forecast feature extraction with fixture tests` · `feat(domain): scoring engine and the four activity rule sets`.

---

## Phase 2 — Open-Meteo adapters

**Goal.** Typed, validated clients for the three endpoints with timeout, one retry and a typed `UpstreamError`. `fetch` is injected; tests never touch the network.

**Read.** D§2 in full, D§6.4.

**Files.**
```
src/adapters/openMeteo/http.ts               getJson(url, { fetch, timeoutMs, userAgent }) → unknown; retry policy; UpstreamError
src/adapters/openMeteo/schemas.ts            zod schemas for the three responses, typed to the P1 payload types
src/adapters/openMeteo/geocodingClient.ts    search(name, { countryCode?, count? }) → GeoResult[]   (absent `results` → [])
src/adapters/openMeteo/forecastClient.ts     fetchForecast(lat, lon, timezone) → WeatherPayload
src/adapters/openMeteo/marineClient.ts       fetchMarine(lat, lon, timezone) → MarinePayload
src/domain/geo.ts                            haversineKm (pure)
test/unit/adapters/**
```

**Steps.**
1. `http.ts`: `AbortSignal.timeout`, one retry after 500 ms on network error or 5xx, never on 4xx; `User-Agent: activity-forecast/<version>`; a zod failure becomes `UpstreamError { retryable: false }` logged with its first issue.
2. Schemas: `z.array(z.number().nullable())` for every series; do not reject unknown keys, so Open-Meteo additions cannot break parsing.
3. Clients build the exact D§2.2 and D§2.3 query strings with the location's IANA timezone passed explicitly (D-012); export the variable lists as constants so the fixture script and the README quote the same thing.
4. Export the `GeocodingClient`, `ForecastClient`, `MarineClient` interfaces for P4's fakes.

**Tests.** D§10 adapters bullet: every fixture parses, including the all-null marine ones; absent `results` → `[]`; 500 → one retry then `UpstreamError`; 400 → no retry; timeout → retryable error; `countryCode` appears in the query; a type-level check that the schema output is assignable to `WeatherPayload` / `MarinePayload`.

**DoD.**
- [x] tests green with an injected fake `fetch` only.
- [x] no `axios`, no date library (D§3).

**Commit.** `feat(adapters): Open-Meteo geocoding, forecast and marine clients with validation and retry`.

---

## Phase 3 — Storage

**Goal.** SQLite through `node:sqlite` with tracked migrations and two repositories; the only module that contains SQL.

**Read.** D§5 in full, D§6.3 (prune), D§4.2.

**Files.**
```
src/adapters/db/database.ts                openDatabase(path) → PRAGMAs, migrations tracked in schema_migrations
src/adapters/db/migrations/001_init.ts     export const sql = `…D§5.1 DDL…`   (embedded, D-009)
src/adapters/db/locationRepository.ts
src/adapters/db/snapshotRepository.ts
src/services/clock.ts                      Clock { now(): Date }; systemClock; fixedClock(iso) for tests
test/unit/db/**
```

**Steps.**
1. `database.ts`: `new DatabaseSync(path)`; `journal_mode = WAL` (skip for `:memory:`), `foreign_keys = ON`; migrations run inside a transaction and are idempotent. On Node 22 `node:sqlite` may print an `ExperimentalWarning`; harmless, mention it in the README.
2. Repositories with the D§5.4 method set. Timestamps are ISO-8601 UTC strings passed in by callers; repositories never read the clock.
3. `prune(olderThanIso)` deletes old rows except the newest per (location, source) in one `DELETE` with a correlated subquery.

**Tests.** insert / getLatest / prune keeps newest / upsertLocation updates fields and keeps the id / cacheQuery hit, miss and negative (`NULL location_id`) / touch / recentlyRequested(since) / migrations run twice without error.

**DoD.**
- [x] tests green on `:memory:`.
- [x] `grep -rl "sqlite" src | grep -v adapters/db` finds nothing.

**Commit.** `feat(db): SQLite storage with migrations, location and snapshot repositories`.

---

## Phase 4 — Services: location resolution, freshness policy, ranking

**Goal.** The behaviour of D§6: resolve a place once, serve fresh, serve stale while refreshing, fetch inline when expired, single-flight per (location, source), marine-unavailable as a valid answer, and a failure matrix that degrades surfing before anything else.

**Read.** D§1 (today in the location's timezone), D§4.1, D§6 in full, D§10 bullets 4–5.

**Files.**
```
src/services/localDate.ts          todayIn(now, timeZone) via Intl.DateTimeFormat('en-CA', …)
src/services/locationService.ts    resolve(city, countryCode?) → Location | 'not-found'; search(query, countryCode?, limit)
src/services/forecastService.ts    getBundle(location) → ForecastBundle; refresh(location, source) with single-flight
src/services/rankingService.ts     rank(city, countryCode?, activities?) → RankingResult
test/unit/services/**
```

**Steps.**
1. Define `ForecastBundle` first: weather `{ snapshot, stale }`; marine `{ kind: 'ok', snapshot, stale } | { kind: 'unavailable', reason: 'no-coverage' | 'outage' }`; fetched-at instants; `cellDistanceKm` when marine data exists. This is the contract P5 maps to `ForecastMeta`.
2. Freshness as a pure function `classify(snapshot | undefined, now, ttl, maxStale, todayLocal) → 'fresh' | 'stale' | 'expired' | 'unavailable'`, unit-tested on its own before any wiring. Request plan mode and write the state table down before editing.
3. `refresh()`: single-flight map keyed `locationId:source`; on success insert the snapshot; on failure rethrow and let `getBundle()` decide. An all-null marine response is stored as `status = 'unavailable'`.
4. `getBundle()`: per source, classify then act per the D§6.1 table; background refresh promises are caught and logged, never an unhandled rejection.
5. `LocationService`: key normalisation (D§5.1), cache hit, miss and negative with the D§6.4 TTLs; `touch()` on every resolve; `search()` passes through to the geocoder without caching and without touching `last_requested_at`.
6. `RankingService`: resolve → bundle → `todayLocal` → features → scores for the requested activities → assemble.

**Tests.** D§10 bullets 4–5 in full, with a fixed clock, real `:memory:` SQLite (cheap, and it exercises the SQL) and fake clients.

**DoD.**
- [x] each row of the D§6.1 table and each bullet of D§6.4 has a test named after it.
- [x] ten concurrent `getBundle()` calls for a cold location cause exactly one fetch per source.
- [x] a rejected background refresh is logged, not thrown.

**Stop-and-ask.** Any change to the TTL defaults or to the state table.

**Commits.** `feat(services): location resolution with query cache` · `feat(services): forecast freshness policy with stale-while-revalidate and single-flight` · `feat(services): ranking service`.

---

## Phase 5 — GraphQL API and bootstrap

**Goal.** The D§8 API on GraphQL Yoga, config from env, structured logs, graceful shutdown, and the first live run.

**Read.** D§8, D§9, D§4.2, D§10 integration bullet.

**Files.**
```
src/config.ts                  zod-validated env (D§9); loadConfig(env)
src/logger.ts                  pino
src/graphql/schema.ts          export const typeDefs = /* GraphQL */ `…D§8.1 verbatim…`   (embedded, D-009)
src/graphql/scalars.ts         Date, DateTime
src/graphql/errors.ts          badUserInput(), locationNotFound(), upstreamUnavailable()
src/graphql/resolvers.ts
src/app.ts                     createApp({ config, clock, db, clients, logger }) → { yoga, services, close() }
src/index.ts                   bootstrap; SIGINT/SIGTERM → stop scheduler (P6), close server, close db
test/integration/**
```

**Steps.**
1. `config.ts` first; `.env.example` lists every D§9 variable.
2. SDL exactly as D§8.1. Because the domain `Activity` union equals the enum values, no mapping layer.
3. Log upstream failures, which is where the logger finally exists: an `UpstreamError` carries the first zod issue in its message (P2) and D§6.4 asks for it to be logged. Resolvers validate input per D§8.3 (including the empty `activities` list and duplicate collapsing), call `RankingService`, map `ForecastBundle` to `ForecastMeta`; everything unexpected stays masked (Yoga's default).
4. `createApp()` exists so integration tests call `yoga.fetch('/graphql', …)` with `:memory:` SQLite and fixture-backed fake clients: no port, no network.
5. `index.ts` wires the real clients and the file database at `DB_PATH` (create the directory), and passes `appliedAt` to `openDatabase` from the clock rather than letting it default (D§4.2). Request plan mode for the wiring before editing.
6. Two traps from P3. The SDL's `Location.id` is the GeoNames id (D§8.1, D-012), while the domain `Location.id` is our row id, so the resolver maps `id: location.geonamesId`. And `DaySummary`'s numbers are optional in the domain but non-null in the SDL; decide per field whether the resolver errors or the SDL relaxes, and log it.

**Tests.** D§10 integration bullet: full shape (7 days × N activities, unique ranks, chronological `days`), Denver surfing `applicable: false`, `LOCATION_NOT_FOUND`, `UPSTREAM_UNAVAILABLE`, `BAD_USER_INPUT` for an empty city, the `activities` filter respected, `searchLocations` returns candidates.

**DoD.**
- [x] `npm run dev`, then the D§8.2 query for Lisbon returns four rankings; Denver returns surfing `NOT_APPLICABLE`.
- [x] a second identical request is served from SQLite (the log shows no upstream call).
- [x] Ctrl-C exits cleanly — *partly*: the sequence (stop the app, drain the server, close the db) and its idempotence are unit-tested in `test/unit/shutdown.test.ts`, but Windows does not deliver POSIX signals, so the `process.on` wiring itself was not exercised automatically (P5 worklog).
- [x] WORKLOG entry with trimmed real responses.

**Commits.** `feat(api): GraphQL schema, resolvers and error codes` · `feat: application bootstrap with config, logging and graceful shutdown`.

---

## Phase 6 — Background refresher and retention

**Goal.** D§6.3: recently requested locations are refreshed before they go stale; old snapshots are pruned.

**Read.** D§6.3, D§5.3.

**Files.** `src/services/refreshScheduler.ts`; wiring in `app.ts` and `index.ts`; `test/unit/services/refreshScheduler.test.ts`.

**Steps.** `start()` runs one cycle shortly after start-up, then every `REFRESH_INTERVAL_MINUTES`; the timer is `unref()`'d; locations are refreshed sequentially with a short pause; prune runs after each cycle; `stop()` clears the timer and awaits an in-progress cycle; `REFRESH_ENABLED=false` makes it a no-op.

**Tests.** Fake timers: one refresh per non-fresh (location, source) and none for fresh ones; prune keeps the newest row; a failing refresh does not stop the cycle; `stop()` is safe to call twice.

**DoD.**
- [x] tests green.
- [x] one log line per cycle with counts (refreshed, skipped, pruned).

**Commit.** `feat(services): background refresh of active locations and snapshot retention`.

---

## Phase 7 — Ship

**Goal.** A stranger can clone, run, and understand the trade-offs in ten minutes.

**Read.** D§12, D§13, D§7.7, QUESTIONS.md, DECISIONS.md, WORKLOG.md.

**Steps.**
1. README per D§12. Short; link to `docs/` for depth. The assumptions section is copied from QUESTIONS.md, not paraphrased.
2. Live checks: Chamonix, Lisbon, Denver, Sydney, `Springfield` with and without `countryCode`, and an unknown name. Compare with D§7.7; record in WORKLOG.
3. `/code-review` on the whole tree, then `/simplify`, then `/security-review`. Fix what is real; log what is skipped and why.
4. Fresh-clone test in a temporary directory: `git clone … && npm ci && npm run check && npm run dev`.
5. Final WORKLOG entry: what was cut and why; what I would do next (D§12 item 6).
6. `Dockerfile` on `node:24-alpine` (`npm ci --ignore-scripts`, `npm run build`, `CMD ["node", "dist/index.js"]`).
7. Push, confirm CI is green, make the repo public, send the "finished" note.

**DoD.**
- [ ] README answers: what, how to run, assumptions, limitations, next steps.
- [ ] CI green on `main`.
- [ ] fresh clone runs.
- [ ] WORKLOG has the final entry.

**Commits.** `docs: README with run instructions, assumptions and limitations` · fix-ups as needed.
