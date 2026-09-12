# activity-forecast

A GraphQL service that takes a town and ranks the next 7 days for skiing, surfing, outdoor sightseeing and indoor sightseeing. Weather comes from Open-Meteo, is stored in SQLite and refreshed on a policy rather than on every request. Node.js, TypeScript, GraphQL Yoga, hand-written SQL, no ORM.

## How this was made
- `docs/DESIGN.md` is the output of a planning session with Claude on 2026-09-10. The Open-Meteo facts in it were checked with live calls during that session. I read it, changed what I disagreed with, and the changes are dated inside it.
- `docs/PHASES.md` is the plan the implementing agent (Claude Opus) follows, one phase at a time. 
- `docs/DECISIONS.md` and `docs/QUESTIONS.md` are the calls I made and the questions I would have asked a PM, with the assumption I went with.
- `docs/WORKLOG.md` is what actually happened, in order, including what I got wrong.
- `AGENTS.md` is how I told the agent to work.

## Running it

TBD

## Assumptions

- "Next 7 days" means today plus six, in the town's own timezone.
- Ranking is per activity: the seven days, best first, each with a 0–100 score and the factors behind it.
- Conditions are evaluated at the town's own grid cell. Skiing for Chamonix means the valley floor; surfing needs a wave-model cell nearby, otherwise it is not applicable.
- Indoor sightseeing is weather-proof, so its score mirrors the outdoor one: a bad outdoor day is a good indoor day.

For a bit more detailed version please check [Questions](docs/QUESTIONS.md)

## License
MIT