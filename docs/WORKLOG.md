# Worklog

What actually happened, in order. Newest at the bottom. Not polished on purpose.

2026-09-10 · planning session (Claude Fable 5.1)
- read the brief, decided to plan first, on paper, before any code
- live calls to Open-Meteo from this machine: countryCode filters server-side; no `results` key on a miss; the marine API returns HTTP 200 with all nulls inland (London, Paris, Denver, Chamonix, Madrid) and a nearby sea cell on the coast (Lisbon 5 km, Sydney 8 km, Los Angeles 23 km); timezone=auto gives local wall-clock strings; snowfall in cm, snow depth in metres
- node:sqlite works locally (SQLite 3.52)
- wrote PLAN.md (now docs/DESIGN.md)
- least sure about: the scoring thresholds and the indoor model

2026-09-12 · planning session 2 (Claude Fable 5.1), then my review
- re-read the PDF; regrouped the 11 steps into 8 phases, P1–P3 independent
- version check: vitest 5.0.0 was 11 days old, graphql 17 and TypeScript 7 are latest; pinned vitest 4.1, graphql 16, TypeScript 5.9, Node 24
- SQL and SDL embedded as TypeScript strings (no asset copy step); fixture capture moved into P0
- wrote AGENTS.md, CLAUDE.md, the /phase skill, open-meteo and scoring skills, the phase-reviewer agent, guard and typecheck hooks; tested the guard by hand
- my review: decided to go with a bit more stable versions then using latest, readable history with worklog. Everything in scope. AGENTS.md rewritten, the first draft read like a template
- the sanity checks in first version of decisions.md worried me; worked the numbers: 0.6 m / 7 s surf = 67 GOOD (doc said FAIR), 6 h of rain = 51 FAIR (doc said <= 20). Fixed with gates for the dominant negatives and a hand-built band table; verified the reference scores with a script
- installed skills antfu vitest, mcollina node, apollo graphql-schema
- made a readme draft and added a MIT License.