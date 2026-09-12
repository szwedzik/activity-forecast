---
name: scoring
description: Working rules for the activity scoring model (criteria curves, gates, the D§7.7 band table as the definition of correct) and how to change a curve without fitting one week of fixture weather. Use when touching src/domain/scoring, src/domain/forecast/features, or when a threshold or a sanity check is in question.
---

The model and the rule tables are D§7 of `docs/DESIGN.md`; the executable copy is `src/domain/scoring/activities/`. Read D§7.2 for the engine and D§7.7 for what "correct" means. This file is only the working rules.

- Criteria are graded preference inside the normal range. Gates are for the one thing that ruins the day: thunderstorm, no snow, flat sea, rain on snow, whiteout, a washout. A weighted average cannot say "this alone ruins it"; a gate can (D-011).
- Correct means every row of the D§7.7 band table passes as its own test, asserting the band and never the reference number, plus the invariants listed there.
- `npm run score-fixture -- chamonix|lisbon|denver` prints real-data tables. That is for looking, not for passing: it is one week of whatever weather there was.

Changing a curve, a weight or a gate:
1. A real-data number looks wrong: write it down as a new hand-built case with the band you believe is right, and watch it fail.
2. Change the data table for that activity only. No new branches in the engine.
3. Run the whole band table. If another row breaks, that is a trade-off; decide it consciously.
4. Log it in `docs/DECISIONS.md` and put one line in the worklog.
