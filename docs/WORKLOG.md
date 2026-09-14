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

2026-09-14 >> Phase 0, ~1h
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

2026-09-14 >> Phase 1, ~2h
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

2026-09-14 >> Phase 2, ~1h
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
