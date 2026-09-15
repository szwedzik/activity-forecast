# Decisions

Numbered, append-only. Short on purpose: what was decided, what else was on the table, why, what it costs. The longer argument is in the design section each one points to.

D-001 · 2026-09-10 · store raw Open-Meteo JSON per fetch, compute scores on read
- instead of: normalised hourly rows, or a derived daily-features table
- why: the only read is "latest snapshot for this location"; refresh is an insert; scoring rules can change without a refetch; a new variable is a query-string change, not a migration
- cost: no SQL over weather values (nothing needs it; a derived table at ingest is the escape hatch)
- D§5.2

D-002 · 2026-09-10 · SQLite through node:sqlite, SQL by hand, no ORM
- instead of: Postgres (reviewer needs Docker), better-sqlite3 (native build)
- why: zero install friction on Node 22.13+; tens of KB per location; all SQL in one module
- cost: Node 20 (end of life April 2026) cannot run it; README says so; swapping to better-sqlite3 touches one file
- D§3, D§5.4

D-003 · 2026-09-10 · GraphQL Yoga, schema-first
- instead of: Apollo Server, Mercurius, code-first with Pothos
- why: yoga.fetch() gives port-free integration tests; GraphiQL comes free; no codegen
- D§3

D-004 · 2026-09-10 · freshness = TTL + stale-while-revalidate + single-flight; background refresh only for locations used in the last 24 h
- numbers: weather TTL 3 h, marine 6 h, serve stale up to 24 h, inland marine negative-cached for 7 days
- why: Open-Meteo's blend updates about hourly and the models every 3–6 h, so refreshing more often buys nothing; a warm location never waits on upstream; about 12 calls per active location per day against a free tier of roughly 10k
- cost: in-process single-flight is single-instance only (Q7)
- D§6

D-005 · 2026-09-10 · scoring = weighted criteria on piecewise-linear curves, multiplied by gates
- instead of: tiered rules ("if rain then POOR"), a learned model (no labels exist)
- why: the thresholds are opinions, so they are data one table per activity, band-tested, and every score lists its factors
- D§7

D-006 · 2026-09-10 · indoor sightseeing derived from outdoor, floor 55, travel gate
- why: weather does not touch a museum; it changes whether you would rather be outside and whether you can get between venues
- cost: opening hours ignored (Q5)
- D§7.6

D-007 · 2026-09-11, planning pass · dependency pins: graphql ^16.14, typescript ~5.9.3, vitest ^4.1, @types/node ^24, Node 24 in .nvmrc, engines >= 22.13
- context: graphql 17 (June 2026), TypeScript 7 (the native compiler) and vitest 5.0.0 (2026-09-03) are all `latest`
- why: boring versions for a take-home; revisit afterwards

D-008 · 2026-09-11, planning pass · eight phases with a dependency graph and per-phase definitions of done; the agent workflow is versioned in the repo
- why: the brief ranks "how you worked" first; the eleven linear steps had no parallelism and no stopping rules for an agent
- PHASES.md, AGENTS.md, .claude/

D-009 · 2026-09-11, planning pass · SQL migration and GraphQL SDL embedded as TypeScript strings
- why: tsc copies no assets; loading .sql or .graphql files from dist needs a copy step
- D§4.2

D-010 · 2026-09-12, after review · no cut lines, everything is in scope
- why: about 15 h in total; the refresher and searchLocations are the parts that show the refresh policy and the disambiguation actually working

D-011 · 2026-09-12, after review · dominant negatives are gates; the scoring gate is a table of hand-built band tests; fixture runs are for looking only
- evidence: worked the design's own claims against its curves. 0.6 m / 7 s surf = 67 GOOD (doc said FAIR); 6 h of rain outdoors = 51 FAIR (tests said <= 20); 5 mm of rain at +1 °C skiing = 60–74 GOOD; 150 m visibility skiing = 82 EXCELLENT. A weighted average lets comfort criteria pad over the one thing that ruins the day
- change: skiing gains rainOnSnow and whiteout gates, outdoor gains a washout gate, surfing's flat gate is softened to [[0.2,0],[0.4,0.5],[0.7,1]]
- gate: 19 hand-built cases in D§7.7, one test each, asserting bands; the reference scores were verified with a script
- D§7.7

D-012 · 2026-09-12, evening · gap sweep before the first commit
- forecast and marine queries pass the geocoder's IANA timezone explicitly instead of `timezone=auto`, so "today" and the hourly strings agree by construction (D§2.2)
- `stale` is true if either served snapshot is past its TTL (D§8.1)
- `activities: []` is BAD_USER_INPUT; duplicates collapse; `query` follows the same rules as `city` (D§8.3)
- searchLocations: no cache, no touch, a geocoder outage is UPSTREAM_UNAVAILABLE (D§6.4)
- Location.id is the GeoNames id (D§8.1)
- NOT_APPLICABLE days sort last; an inapplicable activity lists its days in date order with ranks by position (D§7.2, D§7.4)
- 429 from Open-Meteo: not retried, but retryable, so stale data is served; User-Agent is a constant (D§6.4)
- no dotenv: `npm start` uses Node's --env-file-if-exists; .npmrc engine-strict; .gitattributes forces LF; CI runs Node 22 and 24 (D§9, P0)
- query key is NFC-normalised (D§5.1)

D-013 · 2026-09-14, P0 · three small deviations while scaffolding
- guard.mjs read shell redirections as package names, so a bare `npm install 2>&1` was blocked; it strips them before counting now, and `npm install zod` is still refused
- the smoke test asserts the runtime has node:sqlite rather than something trivial: PHASES said trivial, AGENTS says a test that cannot fail gets deleted, and the second rule wins
- capture-fixtures refuses to overwrite without --force, because tests pin the dates inside the captured files
- none of these touch the design; they are tooling, and the plan is unchanged

D-014 · 2026-09-14, P1 · a criterion reads its feature through a selector, not a field name
- D§7.2 declared `feature: keyof DayFeatures`, which cannot express two of surfing's own criteria: period falls back from swell to the whole sea state, and cleanliness is wind-wave height over wave height
- changed to `select: (features) => number | undefined`. The three other activities pass a one-line field read and look the same as before
- the alternative was storing both derived values on DayFeatures, which puts scoring policy into the extraction layer
- two smaller departures from the same type sketch: GateResult gained confidenceDelta, which is how the skiing snow-depth gate says -0.2 (D§7.3); and ActivityRules.applicable was dropped, because whether surfing can be judged at all is a property of the week, not of one day, so it lives in rankActivity

D-015 · 2026-09-14, P1 · the indoor travel gate is the worst single condition, not the product of all of them
- D§7.6 lists five (gusts, blizzard, deep cold, extreme heat, thunderstorm) under one name, travelGate, without saying what happens when two fire
- took the worst. a blizzard with 110 km/h gusts is one bad journey between venues, not two, and multiplying would put an indoor museum day below a rained-off outdoor one
- the band row for it assumes the same: outdoor 10 with 20 cm snow and 60 km/h gusts scores 67, which is 0.7 and not 0.7 x anything

D-016 · 2026-09-14, P3 · one index beyond the D§5.1 schema, on locations(last_requested_at)
- the refresher scans for locations asked about since a cutoff, every ten minutes, for as long as the service runs (D§6.3). without an index that is a full table scan each time
- costs one small b-tree and a write on touch(), which happens once per request
- the design listed only ix_snapshots_latest; this is the second index and the only addition to the schema

D-017 · 2026-09-14, P3 · make both storage traps impossible rather than documented
- the domain Location field is rowId, not id. the API exposes the GeoNames id as Location.id (D§8.1), so a resolver reaching for location.id would have published our primary key. there is now no such field, so it does not compile
- node:sqlite refuses undefined twice over: its own types reject it at the bind site, and forced past those it throws at run time. so every statement binds through one place, which turns undefined into null once. without it a repository could not pass a domain object with optional fields at all without hand-converting each one
- both were review findings that a comment would have left live. a comment is a request to remember; a compile error and a single bind path are not
- superseded in part by D-018, which widened that single bind path to cover the rest of the driver's edges

D-018 · 2026-09-14, P3 · every statement binds through one wrapper that normalises values first
- probed the driver instead of assuming. its handling is uneven: undefined, booleans, symbols and oversized bigints throw, but a Date, a NaN and an Infinity are each written as NULL without a word, and a named parameter the params object forgot is bound to NULL silently too
- the loud ones are fine. the silent ones are data loss found weeks later, in a nullable column, indistinguishable from a real absence
- so query(db, sql) wraps prepare. undefined and null become NULL; booleans become 0 and 1; a Date becomes the ISO string we store anyway; NaN, Infinity, objects, arrays and symbols throw with the parameter name in the message; and a params object missing a name the SQL asks for is refused outright
- it covers positional parameters as well, which the per-field approach did not
- checked it by renaming one field to a typo: eight tests went red naming the missing parameter, where before it would have written a NULL

D-019 · 2026-09-14, P4 · a stored snapshot is servable only while it still covers the days being scored
- D§6.1 says an expired weather fetch that fails is UPSTREAM_UNAVAILABLE. D§6.4 says serve stale if one exists. D§8.3 settles the wording: the error is for unreachable and no servable snapshot
- what was left open is what servable means. taken as: status ok, and first_date .. last_date still spans today through today plus six
- an older one would score as seven days of insufficient data, which looks like an answer and is not. an error says the true thing
- retention already keeps the newest row per location and source forever (D§5.3), so in practice the fallback almost always exists; this only governs the case where it has aged out of the window
- also decided here: serve stale on any upstream failure, not only a retryable one. a schema change and a 500 both mean no new data, and keying off UpstreamError.retryable would take the service down over a field rename while a good forecast sat in the database

D-020 · 2026-09-14, P4 after review · a stored row that will not parse is missing, not fatal; and an outage does not unlearn geography
- the reviewer found the worst bug of the phase by probing rather than reading: one stored marine payload the schema rejects took the whole response down, all four activities, because the parse sat outside the try. exactly what D§6.4 forbids, and the opposite of what D-019 argued for
- the guard had been put on the fetch path and not the read path. a schema can move between the write and the read just as easily
- so a payload that will not parse is treated as no snapshot: weather falls through to a fetch and then to UPSTREAM_UNAVAILABLE, marine falls to a fetch and then to outage. it is logged either way
- second, undocumented until now: when the weekly recheck of an inland town fails, the answer stays no-coverage rather than becoming outage. D§6.4 reads the other way, but we already know there is no sea near Denver and an outage is no reason to forget it
- third: a fetch that succeeds but does not reach the end of the window is served, per D§6.1, and now logs a warning. every later request will fetch again, so the loop should be visible rather than silent

D-021 · 2026-09-14, P4 after review · which layer owns errors and logging
- services/errors.ts owns ServiceError and its codes; P5 maps those onto GraphQLError in graphql/errors.ts rather than defining a second vocabulary
- services/logger.ts owns the Logger interface, shaped like pino; P5 creates the pino instance in logger.ts and injects it. nothing below P5 imports pino
- the TTL constants in freshness.ts and locationService.ts are the D§9 defaults written twice. P5 config.ts becomes the single source and passes them in; the constants stay as the defaults a caller gets when it passes nothing

D-022 · 2026-09-14, P5 · six DaySummary fields relaxed from non-null to nullable
- SDL change, so asked first. the six: weatherCode, tempMaxC, tempMinC, precipitationMm, snowfallCm, windMaxKmh
- the domain already types them optional, and D§2.2 says any Open-Meteo value may be null for some models or regions. a schema promising more than the source guarantees is promising what it cannot keep
- the cost of leaving it was disproportionate: every parent up the chain is non-null, so GraphQL null propagation means one missing temperature on day five nulls the whole response, rankings included
- no null in any of the 21 captured fixture days, so this is about the rare case, not the common one

D-023 · 2026-09-14, P5 · the masking policy is ours, decided on the error code, not on instanceof
- Yoga masks anything that is not a GraphQLError, checked with instanceof. that holds only while exactly one copy of the graphql module is in play
- under vitest it was not: our source is transformed, Yoga stays external, each side gets its own class, and every coded error came back as a masked INTERNAL_SERVER_ERROR. the same code returned the right codes under tsx
- the failure was silent and pointed the wrong way: the test looked broken where production was fine, and the obvious next move would have been to change working source to satisfy a broken harness
- tried resolve.dedupe (no effect) and inlining yoga (20 failures) before deciding not to fight the bundler
- first attempt read extensions.code against an allowlist. wrong, and the reviewer proved it: graphql raises variable errors with no code at all, so "you forgot $city" came back as Unexpected error / INTERNAL_SERVER_ERROR. a caller typo reported as a server fault, and a bad limit behaving differently inline than as a variable
- it also turned out that parse and validation errors never reach maskError: they happen before execution, so two of the six allowlist entries were inert and a test was covering a path the server never takes
- now: pass an error whose name is GraphQLError and whose originalError, if any, is also one. that is what @envelop/core does, it is name-based so the dual-module problem cannot touch it, and it restores the default behaviour rather than reinventing it
- and the masker logs what it hid. Yoga's own logger was off, so a masked error was recorded nowhere: HTTP 200, no message, no stack, no line anywhere

D-024 · 2026-09-14, P5 · small modules the phase lists did not name
- freshness.ts, errors.ts and logger.ts in P4, shutdown.ts in P5. same reason each time: the plan named a behaviour without naming a file, and the behaviour needed to be testable on its own
- shutdown is the clearest case. D§4.2 puts it in index.ts, but Windows does not deliver POSIX signals, so a handler written inline there could never be exercised at all. as its own module the order is provable: stop the app, drain the server, then close the database, and a second signal does nothing
- the signal wiring itself stays one line in index.ts and is the part still not covered

D-025 · 2026-09-14, P6 · the cycle skips unavailable, not only fresh
- D§6.3 says refresh every source that is not fresh. read literally that includes unavailable, which is the state a landlocked town's marine source sits in
- so the cycle would ask Open-Meteo every ten minutes whether Denver has grown a coastline, for every inland town anyone has ever looked up. the opposite of what negative caching was for
- unavailable is a stored answer with its own week-long TTL (D§6.1). it ages out on its own and the background cycle has nothing to add
- cost: a town that genuinely gains coverage waits up to a week for the cycle to notice. the request path already behaved this way, so this does not make anything worse, it just declines to make it better

D-026 · 2026-09-14, P6 after review · a failed cycle must not be able to stop a shutdown
- reviewer found it. stop() awaited the same promise runGuarded already handles, so a cycle that rejected made stop() reject
- and from there: shutdown.ts had no guard of its own, index.ts calls void shutdown(signal), so the server stayed bound, the database stayed open, exit(0) was never reached, and the second ctrl-C was already swallowed by the stopping flag. a hang rather than a crash, which is the worse of the two to diagnose
- fixed in both places. the scheduler tracks the cycle and swallows its failure when stopping; every step of the teardown is wrapped so a step that throws is logged and the remaining steps still run
- one of the two would have closed this bug. both, because the teardown should not depend on the manners of whatever it is closing

D-027 · 2026-09-14, P7 · the README summarises the four scoring tables rather than copying them
- D§12 item 4 says copy them from D§7. Copied whole they are about sixty lines of curve breakpoints in a file whose first job is to get somebody running in ten minutes
- so: one row per activity with its criteria, weights and gates, which is the part that says what the model believes, and a link to D§7 for the breakpoints and the reasoning
- the weights and gates come off the rule files rather than the design. that was the whole argument for summarising, and the first draft still dropped a gate, so there is a test on it now: the README row and the shipped table have to agree on every weight and every gate, or the suite goes red

D-028 · 2026-09-14, P7 · four things fixed before this goes public, three of them confirmed by probing
- review found an unauthenticated caller can take the process down: Yoga buffers and parses a body before any check of ours, and caches the source and AST of every distinct query for an hour. forty one-megabyte requests took it from 104 MB to 1.97 GB
- so a 32 KB cap before the handler, and the parse cache off. counting the stream instead of trusting Content-Length would mean consuming it, which leaves Yoga nothing to read, so a body that declares no length gets a 411
- second: aliasing. five hundred aliases of searchLocations was five hundred geocoder calls, and three hundred of activityRankings was nine hundred upstream calls out of a free tier of ten thousand a day. a validation rule now caps an operation at ten root fields, following fragments so a spread cannot walk around it
- third: that same request left three hundred rows the refresher then refetched every ten minutes for a day. one cycle now takes at most two hundred towns, newest first
- fourth: Yoga's default CORS reflects whatever Origin it is handed and allows credentials. off. and the server binds loopback now rather than every interface while the log claimed localhost, with HOST for the container
- not fixed: GraphiQL and introspection stay on, which is the point of a take-home somebody is meant to open. the README says so

D-029 · 2026-09-14, P7 · snow to water was out by a factor of ten, and the design said so first
- D§2.2 wrote `max(0, precipitation − snowfall / 7)` and called it 7:1. that ratio is right in matching units and this is not: precipitation is millimetres of water, snowfall is centimetres of snow
- checked against the live API at −20 °C, where nothing can be falling as rain: 0.1 mm of precipitation comes back as 0.07 cm of snow. so a centimetre of snow is 1/0.7 mm of water, and the divisor is 0.7
- the effect was the opposite of subtle. a −6 °C day with 14 cm of new snow on a 1.2 m base came out with 81 mm of rain, the rain-on-snow gate at 0.25, and skiing UNSUITABLE. the gate written to catch the worst day fired hardest on the best one
- the test that should have caught it used 1 mm against 7 cm, where both the right answer and the wrong one clamp to zero. it passed for any divisor up to 7. no fixture contains snow at all, so nothing else went near the path
- now: a pure-snow case and a mixed case that only agree with one divisor, and a ski day taken from a payload all the way to a band

D-030 · 2026-09-14, P7 · a day with no sea is not a bad surfing day, it is not a surfing day
- wave models run out before weather models do, so a coast can have three days of waves and four days of nothing. renormalising over the criteria that remain scored those four on wind and air temperature, gave them 100, and ranked them above a real 1.4 m at 11 s
- D§7.2 declared an `applicable` hook per day and nobody implemented it. implemented, and surfing uses it: no wave height means NOT_APPLICABLE with a reason, which the D-012 sort already puts after every scored day
- renormalising stays right everywhere else. it is the difference between a gap in a supporting measurement and a gap in the thing being measured
- outdoor sightseeing has the same shape if precipitation goes missing, with seven of fifteen weight. left alone: Open-Meteo returns precipitation for land everywhere I have looked, and a rule per activity beats a rule in the engine I cannot demonstrate

D-031 · 2026-09-14, P7 · indoor now publishes the number its score is made of
- its one factor carried `1 − outdoor/100`, so a day scoring 58 shipped an effect of 0.06. the factors are the product and they did not reconstruct the product
- publishes `0.55 + 0.45 × opportunity` instead, so one criterion times the gates gives the score exactly, the way every other activity already did. the outdoor score it came from stays in the factor's value

D-032 · 2026-09-14, P7 · an expired geocode beats no answer
- every other layer serves what it has when upstream is down. the geocode cache was the exception: past thirty days with a dead geocoder it raised UPSTREAM_UNAVAILABLE saying nothing usable was stored, while the town's row and its forecast were both sitting in the database
- a town does not move. an expired hit is now served with a warning, and the failure only surfaces for a name we have never resolved

D-033 · 2026-09-15, P7 after the push · the health endpoint answers something
- caught by running it and opening the page rather than by a test: 200 with an empty body and no content-type. a white page in a browser, and nothing the open socket had not already proved
- worse, my own test had asserted the status and nothing else, so it passed against Yoga's built-in endpoint and never once exercised the code I had written. Yoga installs /health unconditionally and its plugins run before ours
- so Yoga's is moved to a path of its own and ours owns /health: {"status":"ok","database":true}, or 503 and database false. the SELECT 1 lives in the db adapter, not in app.ts
- the database is the only part that can be false while the process is still listening, which is the only reason the endpoint is worth having
- a liveness probe that fails on a dependency can get a healthy process restarted. accepted here: one process, one SQLite file, and if the file is unreadable this cannot serve anything anyway
