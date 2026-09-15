# Worklog

What actually happened, in order. Newest at the bottom. Not polished on purpose.

2026-09-10 >> planning session (Claude Fable 5.1)
- read the brief, decided to plan first, on paper, before any code
- live calls to Open-Meteo from this machine: countryCode filters server-side; no `results` key on a miss; the marine API returns HTTP 200 with all nulls inland (London, Paris, Denver, Chamonix, Madrid) and a nearby sea cell on the coast (Lisbon 5 km, Sydney 8 km, Los Angeles 23 km); timezone=auto gives local wall-clock strings; snowfall in cm, snow depth in metres
- node:sqlite works locally (SQLite 3.52)
- wrote PLAN.md (now docs/DESIGN.md)
- least sure about: the scoring thresholds and the indoor model

2026-09-12 >> planning session 2 (Claude Fable 5.1), then my review
- re-read the PDF; regrouped the 11 steps into 8 phases, P1–P3 independent
- version check: vitest 5.0.0 was 11 days old, graphql 17 and TypeScript 7 are latest; pinned vitest 4.1, graphql 16, TypeScript 5.9, Node 24
- SQL and SDL embedded as TypeScript strings (no asset copy step); fixture capture moved into P0
- wrote AGENTS.md, CLAUDE.md, the /phase skill, open-meteo and scoring skills, the phase-reviewer agent, guard and typecheck hooks; tested the guard by hand
- my review: decided to go with a bit more stable versions then using latest, readable history with worklog. Everything in scope. AGENTS.md rewritten, the first draft read like a template
- the sanity checks in first version of decisions.md worried me; worked the numbers: 0.6 m / 7 s surf = 67 GOOD (doc said FAIR), 6 h of rain = 51 FAIR (doc said <= 20). Fixed with gates for the dominant negatives and a hand-built band table; verified the reference scores with a script
- installed skills antfu vitest, mcollina node, apollo graphql-schema
- made a readme draft and added a MIT License.

2026-09-14 >> Phase 0
- scaffold + fixtures, agent typed, I drove
- deps written into package.json by hand, then a bare `npm install`. 93 packages. engine-strict=true went in clean on node 25.8, no EBADENGINE out of any dependency, which I was half expecting
- my own guard hook blocked that install. it splits on `|` and read `2>&1` as a package name. strips redirections before counting now, `npm install zod` still refused. first real use of the thing and it was wrong
- tsconfig: NodeNext, strict, noUncheckedIndexedAccess, verbatimModuleSyntax. the index-access flag already cost a few defaults in the capture script and the smoke test, keeping it
- 11 GETs, no key. chamonix/lisbon/denver geocode then forecast + marine, plus springfield (10 hits, missouri first) and a junk string
- recaptured the API data 4 days after writing D§2 and checked every claim instead of trusting it: 192 hourly rows starting at local midnight, 8 daily, every listed variable present, marine all null for chamonix and denver, 192/192 for lisbon, the junk query comes back with only generationtime_ms and no results key. all of it still true
- chamonix comes back at 1041m, the valley floor the design warns about. lisbon's wave cell sits 5.4km off the town coords, D§2.3 said 5
- window is 2026-09-14 .. 09-21, so every test from here pins the 14th as today
- plan wanted a trivial smoke test, AGENTS says tests must be able to fail. second rule won. it asserts node:sqlite is actually there, which is the floor the whole storage choice rests on
- tried a red commit on purpose. hook exit 1, nothing landed, reverted it
- built and ran it too, not just the check: tsc to dist, `npm start` prints the placeholder line. --env-file-if-exists says "not found, continuing", which is what it should do
- reviewer drove the guard with 24 command shapes including `npm install > /dev/null zod`, still blocked. it also caught two deviations I'd written here but not in decisions (D-013) and that the fixture readme had no base urls in it
- P2: the query params live in the capture script. move them into the client or the fixtures drift from what we actually send

2026-09-14 >> Phase 1
- pure domain: feature extraction, curve, engine, four activity tables, score-fixture script. 121 tests
- every band row in D§7.7 passed first run, so the reference scores worked out on paper in the planning session hold against the code
- the Criterion type in D§7.2 could not express two of surfing own criteria (period falls back swell -> wave, cleanliness is a ratio). widened it to a selector, D-014
- window is half-open: 09:00-16:00 means the seven rows 09..15. chamonix ski day = 7 rows, touring day = 9
- chamonix 16 sep: daily code says Thunderstorm, outdoor still scores 48. storm lands at 18:00, just outside the touring window. the window doing its job but the summary row and the score will look like they disagree
- lisbon 0.5-0.7 m days come out FAIR 45-51, GOOD once the period gets to 6.8 s. the original 10 sep expectation (0.6 m / 7 s around FAIR) holds now that the flat gate is softened
- denver indoor tops out on 19 sep, the only day with 5 h of rain. chamonix the same on the wet day
- outdoor saturates in fine weather: lisbon has three 100s and nothing below 94. not wrong by the bands, but the ranking is then decided by rounding. leaving it, noting it
- D-011 says 19 hand-built cases, the table has 18 rows. wrote tests for all 18 plus a few more (missing snow depth, period fallback, caller-supplied surf note)
- score-fixture, best day per activity (npm run score-fixture -- <city> for the full seven):

      chamonix  ski  UNSUITABLE 0 all week   surf n/a   out 14 sep 100   in  16 sep 78
      lisbon    ski  UNSUITABLE 0 all week   surf 19 sep 79 GOOD   out 15 sep 100   in  14 sep 58
      denver    ski  UNSUITABLE 0 all week   surf n/a   out 20 sep  99   in  19 sep 82

- reviewer recomputed four reference scores by hand off the shipped tables and they match. found five things: travel gate reading undocumented (D-015), D-014 missing two smaller type changes (added), indoor washout band built from a typed-in 20 instead of the real scored day (fixed, the two rows share one fixture now)
- P4 must pass the town name into the surf note. the domain default says "no wave-model coverage nearby", D§7.4 wants "near {name}", and the domain has no business knowing the name
- smoke.test.ts stays. PHASES said P1 would replace it, but since D-013 it asserts node:sqlite exists, which nothing else does and P3 depends on
- not done here: nothing

2026-09-14 >> Phase 2
- three clients, zod schemas, http wrapper with timeout and one retry, haversine. 155 tests
- own test caught a real bug: a 200 with a body that is not JSON was being retried. retryable was only about whether to serve stale, and I was also using it as the retry rule. now not-retryable gates the retry outright
- looseObject not object, so a variable Open-Meteo adds later survives parsing instead of being stripped on the way to storage. there is a test that adds a field and checks it comes out the other end
- two compile-time lines in schemas.ts assert the zod output is assignable to the P1 payload types. no runtime cost, breaks the build if they drift
- capture-fixtures now imports buildGeocodingUrl/buildForecastUrl/buildMarineUrl from the clients, so the fixtures and the live service ask for the same thing. that closes the P1 carry-forward
- URLSearchParams percent-encodes the commas in the variable list and the slash in the timezone, which the old hand-built script did not. checked against the live API, 200 and 192 rows, so a re-capture would produce the same data
- geocoding schema requires id/name/lat/lon/timezone and makes the rest optional. all 21 results across the fixtures have everything, but admin1 and population are not guaranteed for small places and a missing one should not fail the whole search
- zod failures carry the first issue path in the message (hourly.visibility: ...) instead of taking a logger dependency. P5 logs it
- reviewer found two real ones. a timeout that fires mid-body surfaces from json() as an AbortError, and I was calling that a broken payload, so it lost both the retry and the stale fallback. and a payload that keeps its keys but empties its rows parsed fine, which would have been stored and scored as seven days of nothing. both fixed, both now have tests
- also from the review: the deadline test could not fail (the fake was not recording the signal), and the variable-list tests compared the URL against the constants that built it, so they would pass however wrong both were. now literal lists, and toContain is gone since wave_height is a substring of wave_height_max
- P5 picks up logging the upstream error with its zod issue. added a line to its steps so the carry-forward has somewhere to land
- left alone: response.ok is read outside the try in http.ts, so a Response-like object with a throwing getter would be misclassified. not reachable with real fetch, and guarding it costs more than it saves
- not done here: nothing

2026-09-14 >> Phase 3
- sqlite through node:sqlite, migrations tracked in schema_migrations, two repositories, a Clock. 199 tests
- node:sqlite will not bind undefined at all, it throws. every optional column goes through an explicit null on the way in and back to undefined on the way out. found it by probing the API before writing against it, not by debugging later
- upsert with ON CONFLICT ... RETURNING * keeps the row id and created_at while refreshing everything else, so re-resolving a place does not orphan its snapshots
- the LEFT JOIN for a cached query hands back a row of nulls when the query was a remembered miss. typed it as nullable-everything with a guard rather than pretending id is always a number
- prune keeps the newest row per location and source whatever its age. an old snapshot still beats none when Open-Meteo is down, so retention must not be the thing that empties the store
- the rollback test was fake at first: the migration fails on its own first statement, so nothing partial ever existed. gave migrate() an optional migration list and fed it one that creates a table then collides, which actually proves the transaction
- Location went in src/domain, not beside the SQL. the repository stores one, the services resolve one, the API returns one, so an adapter is the wrong home for it
- PRAGMAs live in openDatabase, not the migration: they are connection settings, not schema. WAL is skipped for :memory: since there is no file to write beside
- covered the file path too, not just :memory:. a temp-dir database reports journal_mode wal, and reopening it finds its own migration already applied
- reviewer failed it on two rule breaks, both mine. the in-memory journal test could not fail (sqlite ignores the WAL pragma there either way), so the branch it was guarding was cosmetic. dropped both the branch and the test, kept the file-based one that actually proves WAL
- and ix_locations_requested sat in the migration with nothing explaining it. D-016 now says why
- it also stress-tested prune against a reference implementation over 800 random rows and could not break it, including the case where the newest row of a pair is itself older than the cutoff
- caught a real trap for P5: the SDL Location.id is the GeoNames id, the domain Location.id is our row id. a resolver written as location.id would ship the wrong number. noted on the type and in P5 steps
- dropped HOUR_MS and hoursAgo from clock.ts, no caller yet. toIsoUtc stays, its sort-order property is what the freshness SQL relies on
- went further than noting both traps, since a comment is only a request to remember. the domain field is rowId now, so a P5 resolver reaching for location.id will not compile, and every statement binds through bindable() so undefined cannot reach the driver from anywhere. D-017
- turns out the driver types already reject undefined at the bind site, not just at run time. bindable is what lets a repository hand over a domain object with optional fields without converting each column by hand
- went back and probed every value type the driver accepts, since undefined turned out not to be the only one. it is uneven: undefined, booleans, symbols and oversized bigints throw, but Date, NaN and Infinity are each stored as NULL in silence, and a named parameter you forgot to supply is bound to NULL in silence too
- that last one is the nasty one. rename a field in the params object, keep the SQL, and the column quietly goes null
- so every statement now goes through query(db, sql). one place converts, one place refuses, and it covers positional parameters which the per-field version did not. D-018
- checked it by breaking it on purpose: renamed timezone to timezoen and eight tests went red naming the missing parameter, instead of writing a null
- also ran the whole spine end to end before committing, since nothing had ever been connected: fixture in, schemas, sqlite, read back out, re-validate, score. payload survives the text column byte for byte, inland stores as unavailable, lisbon wave cell measures 5.4 km offshore against the 5 the design recorded
- not done here: nothing

2026-09-14 >> Phase 4
- the refresh policy, which is the bit the brief is actually asking about. freshness, location resolution, ranking. 299 tests
- wrote the state table down in plan mode before touching code, as the plan says. eight rows, eight tests named after them. that was the right order: rows 3 and 5 (recent but no longer covering the window) only exist because writing the table forced the question of whether recent and usable are the same thing
- they are not, and that is the whole of D-019. an old snapshot scored for a week we have moved past gives seven days of insufficient data, which reads like an answer. serving it would be worse than the error
- also decided: serve stale on any upstream failure, not just a retryable one. a schema change and a 500 both mean no new data
- single-flight is one map keyed rowId:source, cleared in finally rather than on success. a failed refresh that kept its promise would have poisoned the location until restart, and there is a test that fails first then succeeds
- the background refresh from the stale path is deliberately not awaited, so it carries its own catch. without it a slow upstream becomes an unhandled rejection at process level rather than a warning
- isServable started as a type guard and had to stop being one. declaring it "snapshot is Snapshot" told the compiler that false means undefined, when it actually means the snapshot exists and is useless
- three files beyond the phase list: freshness.ts (step 2 asks for the pure function but names no file), errors.ts and logger.ts (services have to signal failure and log a caught background rejection without importing GraphQL or pino)
- closed the P3 carry-forward: the surfing note names the town now. no coverage near Denver vs temporarily unavailable, built in the ranking service because the domain has no idea where it is
- caught one of my own weak tests before the reviewer did: asserted calls.length >= 2 where the real behaviour is exactly 2 once the detached refresh lands
- reviewer failed it, and rightly. it probed instead of reading and found the worst bug of the phase: one stored marine payload the schema rejects took the whole response down, all four activities. the parse sat outside the try
- galling because D-019 had argued the exact opposite the hour before. I guarded the fetch path and forgot the read path, and a schema can move between a write and a read just as easily. D-020
- it also caught that the inland-recheck-fails case reads against D§6.4 and had no decision entry, that freshnessOf returned string so a P6 typo would compile, and four assertions of mine that could not fail
- one of those four was interesting: my new test for the marine bug asserted the wrong outcome. the fix was better than I expected, so the corrupt row got refetched instead of degrading. rewrote it to corrupt the row and fail the fetch, which is the case that actually matters
- weather and marine now run in parallel. they were serial with a comment justifying it, but marinePart never rejects, so the justification was wrong and it was costing a round trip on every cold location
- D-021 records which layer owns errors and logging, so P5 does not build a second vocabulary next to this one
- not done here: nothing

2026-09-14 >> Phase 5
- the API and the bootstrap. schema, scalars, errors, resolvers, config, pino, graceful shutdown. 331 tests, and the thing answers over HTTP for the first time
- asked before touching the SDL, per my own rule. six DaySummary fields relaxed to nullable (D-022). the argument that decided it: every parent up the chain is non-null, so one missing temperature on day five would null the entire response, rankings included
- lost the better part of an hour to seven integration failures where every coded error came back as INTERNAL_SERVER_ERROR. the same code returned the right codes under tsx. vitest transforms our source but leaves yoga external, so each side gets its own graphql module and yoga's instanceof check fails
- that one pointed the wrong way: the tests looked broken where production was fine, and the obvious move would have been to change working source to satisfy a broken harness. tried dedupe (nothing) and inlining yoga (20 failures) before deciding not to fight the bundler
- took over the masking policy instead, deciding on extensions.code against an allowlist. better regardless of the bug: the D§8.3 contract is now a list in one file, tested for what it hides as well as what it lets through. D-023
- the DoD wanted the log to prove the second request never left the process, and nothing logged upstream calls yet, so that went in. three calls for two identical Lisbon requests: geocode, weather, marine, then nothing
- live run matched the fixture tables exactly: lisbon surf 19 sep 79 GOOD, outdoor 15 sep 100, indoor 14 sep 58. denver surfing not applicable with the town named, marineCellDistanceKm null. lisbon reports 5.4 km offshore
- trimmed from the live run, port 4010, database empty at start:

      # activityRankings(city: "Lisbon")
      location  {"id":"2267057","name":"Lisbon","countryCode":"PT","timezone":"Europe/Lisbon"}
      forecast  {"source":"open-meteo","stale":false,"marineAvailable":true,
                 "marineCellDistanceKm":5.4,"weatherFetchedAt":"2026-09-14T19:33:27.746Z"}
      SKIING               2026-09-14   0 UNSUITABLE  snowCover 0 cm snow depth
      SURFING              2026-09-19  79 GOOD        waveHeight 0.7 m mean wave height
      OUTDOOR_SIGHTSEEING  2026-09-15 100 EXCELLENT   wind 16 km/h mean wind
      INDOOR_SIGHTSEEING   2026-09-14  58 FAIR        outdoorConditions outdoor score 94

      # activityRankings(city: "Denver")
      marineAvailable false, marineCellDistanceKm null
      SURFING not applicable, all 7 days NOT_APPLICABLE and score 0
      "No wave-model coverage near Denver; Open-Meteo's marine grid returns no data
       for inland locations."

      # two identical Lisbon requests, upstream calls logged
      1. calling Open-Meteo geocoding {"name":"Lisbon"}
      2. calling Open-Meteo {"location":"Lisbon","source":"weather"}
      3. calling Open-Meteo {"location":"Lisbon","source":"marine"}
      (nothing further: the second request never left the process)

- ctrl-c could not be tested on windows at all, which does not deliver POSIX signals. pulled the sequence into shutdown.ts so the order is provable: app, drain the server, then close the db, and a second signal does nothing. the signal wiring itself is one line I have not exercised automatically
- reviewer failed it on a regression I introduced with the masking fix. graphql raises variable errors with no code at all, so the allowlist turned "you forgot $city" into Unexpected error / INTERNAL_SERVER_ERROR. a caller typo reported as a server fault, and a bad limit behaving differently inline than as a variable
- it also found that parse and validation errors never reach maskError at all, so two of my six allowlist entries were inert and one test was covering a path the server never takes
- replaced the allowlist with the name check @envelop uses: GraphQLError whose originalError, if any, is also one. immune to the dual-module problem and it restores the default instead of reinventing it. D-023 rewritten
- and Yoga own logger was off, so a masked error was logged nowhere. HTTP 200, no message, no stack, nothing. the masker takes a logger now
- my masking test was not testing masking: the location service wraps anything the geocoder throws into a coded error, so nothing unexpected could ever escape it. rewrote it around a timezone the runtime cannot resolve, which is genuinely unhandled
- D-022 had no test proving what it bought either. added one with a null daily value, then checked it is not vacuous by restoring the non-null schema: red, then green again
- also from the review: dropped the vitest dedupe entry whose comment claimed a fix D-023 records as not working, and tightened the name check so control characters no longer count as a place name
- left alone: a masked error loses path and locations. harmless to a client and the detail is in the log now
- not done here: nothing

2026-09-14 >> Phase 6
- the background refresher and retention. 365 tests. this is the last piece of D§6 and the smallest
- split runCycle() out as public so the work is testable without timers. which calls a cycle makes has nothing to do with clocks, and threading fake timers through it would only make it harder to read. four small timer tests cover the rest
- the one that would have been easy to get wrong: a marine source sitting at unavailable has to be skipped, not refreshed. treat it as "not fresh" and every cycle re-asks Open-Meteo whether Denver has a coastline, forever. the weekly recheck still happens because classify already turns it back to expired at 168h
- watched it in the real process rather than trusting the unit tests. with a 7-second weather TTL: cycles 1 and 2 skip, cycle 3 refreshes weather once it ages, cycle 4 skips again, marine never refetched because its TTL had not passed
- and with normal TTLs, five cycles in a row found Lisbon active, both sources fresh, and spent nothing. three upstream calls in total, all from the original request
- a cycle that throws mid-location is caught per location, so one town with a timezone the runtime cannot resolve does not take the rest of the cycle with it
- stop() awaits a cycle in flight before returning, because shutdown closes the database next and a cycle is mid-way through writing snapshots
- createApp builds the scheduler but does not start it. index.ts starts it once the server is listening, so a test never gets a timer it did not ask for
- the recording test logger now keeps every level in order, since the DoD wanted the cycle's info line asserted
- reviewer failed it, and on the worst kind of finding: not a wrong answer but a process that will not exit. stop() re-awaited the promise runGuarded already settles, so a cycle that rejected made stop() reject. shutdown.ts had no guard of its own and index.ts calls void shutdown(), so the server stayed bound, the db stayed open, exit(0) never ran, and the second ctrl-c was already swallowed by the stopping flag
- fixed in both places rather than the cheaper one. the scheduler tracks the cycle and swallows its failure when stopping; every teardown step is wrapped so a step that throws is logged and the rest still runs. D-026, and three tests that kill the process if either guard goes
- four of my behaviours had no test that could fail: the overlap guard, stop() actually awaiting, both unref() calls, and the whole app wiring. deleted each one to watch the suite stay green, then wrote the test that goes red. moving start() into createApp broke nothing at all before
- the 48-hour window and the pause between calls were only asserted indirectly, so pruning everything except the newest row would have passed every test in the file. both pinned with their numbers now
- D-025 for skipping unavailable. it was in this log and nowhere else, and it is a deviation from D§6.3's literal "every source that is not fresh", which my own rules say belongs in DECISIONS
- ran the real process once more for the one line no test reaches, index.ts starting the thing. fifteen-second cycles, seven-second TTLs, eighteen-second retention:

      # a cycle at start-up before anyone has asked about anywhere
      refresh cycle {"locations":0,"refreshed":0,"skipped":0,"failed":0,"pruned":0}
      # one request for Lisbon, then the next two cycles
      refresh cycle {"locations":1,"refreshed":2,"skipped":0,"failed":0,"pruned":0}
      refresh cycle {"locations":1,"refreshed":2,"skipped":0,"failed":0,"pruned":2}

- graceful shutdown still cannot be seen on windows: SIGTERM to a child is TerminateProcess, so the handler never runs. the sequence is covered by six unit tests and nothing more
- a comment in config.ts claimed the refresher is off in tests. it is on by default and simply never started, which is not the same thing
- passed on the second pass, and it mutation-tested eleven behaviours itself rather than taking my word for any of them. it also walked the shutdown path looking for a remaining way to leave the process alive and did not find one
- one thing it left me: runCycle() is tracked but not guarded, so two concurrent calls would overwrite each other and stop() would wait on the second. nothing calls it but a test, so it is commented rather than changed
- not done here: no watchdog around the server drain. on this node close() calls back immediately when the keep-alive sockets are idle, so only a request that never ends could park a shutdown. a README line in P7 rather than code now

2026-09-14 >> Phase 7
- shipping. README, Dockerfile, the three reviews, live checks, fresh clone. 378 tests
- README follows D§12 except the four scoring tables, which are sixty lines of breakpoints in a file whose job is ten minutes to first query. one row per activity with criteria, weights and gates instead, read off the rule files so it cannot drift from the code, and a link to D§7 for the curves (D-027)
- live checks: Chamonix, Lisbon, Denver, Sydney, Springfield with and without a country code, an unknown name. every invariant held on every one, and nothing logged a warning
- Springfield with no country code is Missouri, with GB it is a village in Fife with a wave cell 9.7 km away and a flat sea. searchLocations lists five Springfields, all American, which is the honest reason the country code exists
- Reykjavik comes back with no wave coverage. checked it against the marine API directly before believing it: 200 with every hour null, while Porto and Sydney return data. the global wave model has nothing inside Faxaflói, so that is the model's answer and not our bug
- Docker Desktop was not running, so the Dockerfile got built and run rather than written and hoped over. two stages, non-root, 267 MB, and it answered for Porto and Biarritz
- and it finally showed the thing Windows never could: SIGTERM in the container logs shutting down, then stopped, exit 0 in 299 ms. that line has been "not exercised automatically" since P5
- ran three reviews as subagents rather than the slash commands, since those are the owner's to trigger. code, simplification, security. the first two found real bugs, the third found real holes
- the worst one was mine to have caught long ago. D§2.2 said derive liquid rain as precipitation minus snowfall over 7, and 7:1 is right in matching units but precipitation is mm of water and snowfall is cm of snow. off by ten
- so a -6 °C day with 14 cm of new snow on a 1.2 m base came out with 81 mm of rain, the rain-on-snow gate at 0.25, and skiing UNSUITABLE. the gate written for the worst day fired hardest on the best one. D-029
- the test that should have caught it used 1 mm against 7 cm, where both the right answer and the wrong one clamp to zero. it passed for any divisor up to 7. no fixture has snow in it, so nothing else went near the path
- confirmed the ratio against the live API before changing it: at -20 °C on the Greenland ice sheet, 0.1 mm of precipitation comes back as 0.07 cm of snow. then Ushuaia after the fix, where 1.75 cm against 2.5 mm leaves the rain criterion at exactly 1
- second real bug: days with no wave data scored 100 and outranked a 1.4 m at 11 s. wave models run out before weather models do, so the criteria that remained were wind and air temperature, and a day we know nothing about looked perfect
- D§7.2 declared an applicable hook per day and nobody built it. built, and surfing uses it: no wave height means NOT_APPLICABLE with a reason, which the D-012 sort already puts last. D-030
- security: 32 KB body cap, ten root fields per operation, 200 towns per refresh cycle, CORS off, loopback bind. all four were demonstrated first, not guessed at: forty one-megabyte posts took the process from 104 MB to 1.97 GB, and three hundred aliases made nine hundred upstream calls out of a tier of ten thousand a day. D-028
- indoor was publishing the opportunity rather than the desirability, so a day scoring 58 shipped a factor of 0.06. the factors are the product and they did not reconstruct the product. D-031
- and the geocode cache was the only layer with no stale-on-error path: past thirty days with a dead geocoder it said nothing usable was stored, with the town and its forecast both in the database. D-032
- everything above got a test that fails without the fix, checked by putting the bug back
- removed: compareDates and daysBetween, which nothing outside their own test called, and two error factories in the graphql layer with no caller at all, one of them a second copy of a message a client actually sees. an integration test named for masking that asserts an upstream code got renamed to what it holds
- left alone: the severe-weather gate written three times, the two URL builders, the storeOk duplication in forecastService, the Window map keyed by JSON. all trim rather than repair, and the last week of a take-home is the wrong time to move code that works
- also left: one all-null marine response still pins a town for a week, which a second confirming call would fix. hoursInWindow is computed and never read. wetHours counts snow. all three in the README or the next-steps list rather than in the code
- fresh clone from a temp directory: npm ci clean, 0 vulnerabilities, check green, and it served Reykjavik on the first request
- reviewer passed it and then found four things still wrong in the docs. the open-meteo skill still carried the snow formula D-029 had just fixed, and CLAUDE.md says that skill loads by itself, so it is the first thing the next agent would read about units
- two design lines still described the old indoor factor and the old geocode failure, four sections away from the corrections. and the README's outdoor row was missing the fog gate, which is exactly the drift D-027 said could not happen, on the table's first write
- so there is a test on the README now. the table and the rule files have to agree on every weight and every gate, and the documented defaults have to match config. checked it by dropping a gate and by changing a default: both go red
- it also found the configured refresh bound had no test: the repository's own default silently covered for a scheduler that forgot to pass it. one test with more towns than the bound closes that
- not done here: no git remote exists, so push, CI green and making it public are the owner's to do

2026-09-15 >> Phase 7, tail
- read the brief again before pushing, against the finished thing rather than the plan
- the worklog claimed roughly thirteen hours across eight phases and the commits span eighty-four minutes. those hour markers were estimates I never measured, in the one document whose whole value is being accurate. gone rather than replaced with better guesses
- D§7.7 said the invariants run on generated inputs. there are none and no property library here; they run on three fixtures and hand-built sweeps. corrected in place, same as the snow formula, and it is the second time the design claimed something the code never did
- factor effects are rounded where they are published. the first thing anyone sees in a response was 0.9350125 next to an integer score. indoor rounds before it takes its score from the number rather than after, so what it ships is what it used, checked across every outdoor score and gate
- /health, and a container healthcheck that uses it. the container reports healthy
- the README now says which activity is hollow and why. skiing is scored at the town rather than at the lifts, and Queenstown settled that it is not a hemisphere problem: late winter in New Zealand, no snow at 328 m, ski fields above 1600 m. Ushuaia was the only town I found where it comes back alive
- and it says what I did not build. the brief asked for focus over volume, and the list of things I decided against was sitting in AGENTS.md where a reviewer would never look
- replayed all five commits one at a time from a clean HEAD and ran the suite on each: 369, 381, 382, 380, 383. green in isolation, not only at the end
- pushed. the repo had a LICENSE commit from GitHub's own repo creation, so the twenty local commits are rebased onto it rather than forced over it. identical file, only the line endings differed
- CI green on main on both node versions, 19s and 15s. cloned the public repo into a temp directory and ran it there too: 121 files, npm ci clean, 383 tests, and task.pdf correctly absent
- not done here: no snow fixture. the bug D-029 hid in was exactly the case three fixtures cannot reach, and capturing one needs a live call I did not want to make unasked
