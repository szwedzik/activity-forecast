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
