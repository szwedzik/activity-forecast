# activity-forecast

A GraphQL service that takes a town and ranks the next 7 days for skiing, surfing, outdoor sightseeing and indoor sightseeing. Weather comes from Open-Meteo, is stored in SQLite and refreshed on a policy rather than on every request. Node.js, TypeScript, GraphQL Yoga, hand-written SQL, no ORM.

Ask about a place:

```graphql
{
  activityRankings(city: "Lisbon", activities: [SURFING]) {
    location { name country timezone }
    forecast { weatherFetchedAt stale marineAvailable marineCellDistanceKm }
    rankings {
      activity
      applicable
      days { date rank score suitability confidence factors { name kind value effect weight } }
    }
  }
}
```

and it answers with seven days, best first, each carrying the reasons behind its number:

```json
{
  "location": { "name": "Lisbon", "country": "Portugal", "timezone": "Europe/Lisbon" },
  "forecast": {
    "weatherFetchedAt": "2026-09-14T20:06:26.231Z",
    "stale": false,
    "marineAvailable": true,
    "marineCellDistanceKm": 5.4
  },
  "rankings": [
    {
      "activity": "SURFING",
      "applicable": true,
      "days": [
        {
          "date": "2026-09-19",
          "rank": 1,
          "score": 79,
          "suitability": "GOOD",
          "confidence": 0.5,
          "factors": [
            { "name": "waveHeight", "kind": "CRITERION", "value": "0.7 m mean wave height", "effect": 0.637, "weight": 4 },
            { "name": "period", "kind": "CRITERION", "value": "7.7 s mean period", "effect": 0.5481, "weight": 3 },
            { "name": "wind", "kind": "CRITERION", "value": "7 km/h mean wind", "effect": 1, "weight": 3 }
          ]
        }
      ]
    }
  ]
}
```

Factors are the point. "Saturday, 79, good" is not worth much on its own; "0.7 m at 7.7 s, no wind" is something you can disagree with.

## How this was made
- `docs/DESIGN.md` is the output of a planning session with Claude on 2026-09-10. The Open-Meteo facts in it were checked with live calls during that session. I read it, changed what I disagreed with, and the changes are dated inside it.
- `docs/PHASES.md` is the plan the implementing agent (Claude Opus) follows, one phase at a time. 
- `docs/DECISIONS.md` and `docs/QUESTIONS.md` are the calls I made and the questions I would have asked a PM, with the assumption I went with.
- `docs/WORKLOG.md` is what actually happened, in order, including what I got wrong.
- `AGENTS.md` is how I told the agent to work.

If you only have ten minutes: this file, then `docs/WORKLOG.md` from the bottom, then any entry in `docs/DECISIONS.md` that looks contentious.

## Running it

Node 22.13 or newer, because storage uses the built-in `node:sqlite` and that is the version it arrived in. `.nvmrc` pins 24, and CI runs both.

```
npm ci
npm run dev        GraphiQL on http://localhost:4000/graphql
npm run check      typecheck and the full test suite
```

No API key and no account: Open-Meteo's non-commercial tier needs neither, and there is nothing else to configure. The database is created on first run at `./data/app.db`. `GET /health` returns `{"status":"ok","database":true}`, or a 503 if the database stops answering, which is the only part that can fail while the process is still listening.

In Docker:

```
docker build -t activity-forecast .
docker run -p 4000:4000 -v activity-forecast-data:/app/data activity-forecast
```

Everything is optional and has a default. The ones worth knowing, with the rest in [DESIGN §9](docs/DESIGN.md):

| Variable | Default | |
|---|---|---|
| `PORT` | `4000` | |
| `DB_PATH` | `./data/app.db` | `:memory:` works, and forgets everything on exit |
| `WEATHER_TTL_HOURS` | `3` | how long a weather snapshot is served without refetching |
| `MARINE_TTL_HOURS` | `6` | wave models update less often than weather |
| `MAX_STALE_HOURS` | `24` | past this, a request waits for a fresh fetch instead |
| `REFRESH_ENABLED` | `true` | background refresh of towns asked about in the last day |
| `REFRESH_INTERVAL_MINUTES` | `10` | |
| `HOST` | `127.0.0.1` | loopback; the container sets `0.0.0.0` |

## The API

Two queries. `activityRankings(city, countryCode, activities)` is the one that matters. `searchLocations(query, countryCode, limit)` is there to settle which Springfield you meant before you commit to one.

Errors carry a machine-readable code:

| `extensions.code` | when |
|---|---|
| `BAD_USER_INPUT` | empty city, a country code that is not two letters, a limit outside 1 to 10 |
| `LOCATION_NOT_FOUND` | the geocoder has no match for the name |
| `UPSTREAM_UNAVAILABLE` | Open-Meteo is unreachable and nothing stored is fresh enough to serve |

Anything else is masked to `Unexpected error.` and logged, so an internal message never reaches a client.

Two limits apply to every request, both there to keep one caller from spending the whole Open-Meteo budget or the whole heap. A request body is capped at 32 KB, and an operation may ask for at most ten root fields, fragments included. Ten aliased cities in one query is fine; five hundred is refused before a single resolver runs.

## How it works

```
activityRankings(city, countryCode?, activities?)
  └─ resolve the location      geocoder, cached by (name, countryCode) for 30 days
     ├─ weather snapshot       freshness policy below, single-flight per location and source
     ├─ marine snapshot        same, and "no coverage here" is itself a stored answer
     ├─ extract day features   pure: 7 local dates, hourly rows aggregated inside each activity's window
     └─ score and rank         pure: criteria and gates, best day first
```

Raw Open-Meteo responses are stored as immutable JSON snapshots, one row per fetch, newest served. Nothing derived is persisted: scores are cheap and recomputing them from a stored snapshot means a curve can change without a migration or a stale cache. Old rows are pruned after 48 hours, and the newest row for a location and source is never pruned.

Freshness is decided per snapshot at read time, where `age = now - fetchedAt` and *covers* means the snapshot spans today through today plus six in the town's timezone:

| State | Condition | What happens |
|---|---|---|
| fresh | `age < TTL` and covers | served |
| stale | `TTL <= age < MAX_STALE` and covers | served with `stale: true`, refresh starts in the background |
| expired or missing | anything else | fetched inline, and `UPSTREAM_UNAVAILABLE` if that fetch fails |
| unavailable | marine only, no coverage at this location | surfing is not applicable, rechecked weekly |

Concurrent requests for the same location and source share one upstream call, so a cold cache under load makes one request to Open-Meteo rather than ten. A marine outage degrades surfing only: the other three activities answer normally.

Dates are `YYYY-MM-DD` strings in the town's own timezone and instants are ISO UTC strings, with no date library between them. Weather and marine hourly rows are matched by their `time` string and never by index, because the two snapshots can be fetched on different days.

More depth in [DESIGN §4](docs/DESIGN.md) for the flow, §5 for the schema and §6 for the policy.

## Scoring

Each activity is a table of weighted criteria and a set of gates. A criterion maps one feature onto a 0 to 1 desirability through a piecewise-linear curve, and the weighted average of them is the day's base score. A gate multiplies that average, which is how one thing that ruins a day gets to ruin it: a weighted average cannot say "no snow, so it does not matter how pleasant the afternoon is", and a gate can.

| Activity | Window | Criteria, by weight | Gates |
|---|---|---|---|
| Skiing | 09:00 to 16:00 | temperature 3, wind 2, visibility 2, rain 2, fresh snow 1, sky 1 | snow cover, lift wind, thunderstorm or freezing rain, rain on snow, whiteout |
| Surfing | daylight hours | wave height 4, period 3, wind 3, cleanliness 1, water temperature 1, air comfort 1, rain 0.5 | flat, dangerous size, storm gusts, thunderstorm |
| Outdoor sightseeing | 09:00 to 18:00 | hours of rain 4, temperature 3, chance of rain 2, wind 2, sky 2, rainfall 1, snow 1 | thunderstorm or freezing rain, dangerous wind, extreme heat, fog, washout |
| Indoor sightseeing | same as outdoor | derived from the outdoor score | travel conditions |

Indoor is deliberately the inverse of outdoor rather than an independent model. Weather barely touches a museum, so the only honest signal is opportunity cost: a washout makes an indoor day attractive, a perfect day makes it a waste. It sits between 55 and 100 for that reason, and a blizzard still pulls it down through the travel gate, because getting between venues in one is not fun.

A day the model cannot speak to is not scored at all. Wave forecasts run out sooner than weather forecasts, so a coast can have three days of swell and four days of nothing; those four come back `NOT_APPLICABLE` with a reason rather than scored on the breeze, and they sort after every day with real data.

Reading a response: `score` is 0 to 100 and `suitability` is the band it falls in. `factors` is ordered so the first one is the biggest reason the score is not 100, gates before criteria. `effect` is that factor's desirability or multiplier, and `weight` is how much a criterion counted. `confidence` decays with lead time and drops when a criterion had no data. It is a stated heuristic, not a measurement, and it is reported next to the score rather than folded into it.

The curves, the exact breakpoints and the reasoning behind each threshold are in [DESIGN §7](docs/DESIGN.md). They are opinions, which is why they are data in one file per activity and why every response shows its work.

## Assumptions

These are the questions I would have asked a PM, and what I did instead. The full list with the design references is in [QUESTIONS.md](docs/QUESTIONS.md).

- **Q1 · does "the next 7 days" include today, and whose today?** Assumed today plus six, in the town's own timezone. Switching to tomorrow-plus-six is one line; we fetch 8 days so both readings are covered.
- **Q2 · rank the days within an activity, or the activities within a day?** Assumed days within an activity, best first, each with an absolute 0–100 score. The other view can be derived from the same response.
- **Q3 · which "Paris"?** Assumed the geocoder's top hit; it orders by prominence, so Paris, France before Paris, Texas. An optional country code narrows it, and `searchLocations` lists candidates.
- **Q4 · the town itself, or the nearest resort or beach?** Assumed the town's own grid cell. Skiing for Chamonix means the valley floor; surfing needs a wave-model cell nearby, otherwise it is "not applicable".
- **Q5 · how does weather affect indoor sightseeing at all?** Assumed it does not, except that a bad outdoor day makes an indoor day more attractive, and a storm makes getting between venues harder. Opening days and hours are ignored.
- **Q6 · are scores comparable across towns?** Assumed yes: the same curves everywhere, and the rank is only a sort within one request.
- **Q7 · what scale, what deployment?** Assumed one instance at evaluation scale on Open-Meteo's non-commercial tier.
- **Q8 · omit surfing inland, or return it?** Assumed return it, with `applicable: false`, a reason, and seven `NOT_APPLICABLE` days, so the shape is stable for clients.
- **Q9 · is serving slightly stale data acceptable, and should the client know?** Assumed yes, up to 24 h while a refresh runs, and the response says `stale: true` plus when the data was fetched.
- **Q10 · does "persist it" mean keep history?** Assumed no: the newest snapshot per location and source, older ones pruned after 48 h.

## Limitations

- Skiing is scored at the town, not at the lifts, and towns sit in valleys. In September that means UNSUITABLE almost everywhere, and not only in the northern hemisphere: Queenstown in New Zealand is in late winter and still has no snow at 328 m while its ski fields start above 1600 m. Ushuaia is the one town I tried where skiing comes back alive. Combined with surfing being not applicable inland, ask about Denver today and two of the four activities are honest but empty. A resort and beach lookup is the single biggest thing that would change, which is why it is first on the next-steps list.
- Conditions are the town's own grid cell. Chamonix skiing is the valley floor at 1060 m, which reads UNSUITABLE all summer and is correct for the question asked, but is not what a skier means by Chamonix. Same for surfing: the town's nearest wave cell, with no idea which way the shore faces or whether that swell direction works there.
- A coastal town can still report no wave coverage. Open-Meteo's global wave model has no data inside sheltered bays, so Reykjavik comes back as not applicable while Porto and Sydney do not. That is the model's answer and the service passes it on rather than guessing.
- Confidence is a heuristic from lead time and missing data, not a measurement. Real uncertainty would come from Open-Meteo's Ensemble API.
- Venue opening hours, seasons and closures are ignored, so indoor sightseeing is about the weather and nothing else.
- The scheduler runs in the process. Two instances would refresh the same towns twice, so this is single-instance by design.
- There is no auth and no rate limiting, so it is not production-hardened. What it does have is a body cap, a root-field cap, and a default bind to loopback rather than every interface. GraphiQL and introspection are on in every environment, which is deliberate for something meant to be opened and poked at.
- Graceful shutdown drains in-flight requests with no watchdog, so a request that never ends would hold the process open. The sequence is unit-tested and was watched for real in the container, where `docker stop` exits 0 in under half a second. On Windows it cannot be exercised at all, because the platform does not deliver POSIX signals.
- One geocoder hit per name, cached for 30 days. A town that gains wave-model coverage keeps its "no coverage" answer for up to a week.

## What I didn't build

Deciding what to leave out was the harder half of this, so the list is part of the answer:

- No front end. The brief rules it out, and GraphiQL is enough to try the thing.
- No auth, no rate limiting, no multi-tenancy. One instance at evaluation scale, which is the assumption in Q7 and the reason the scheduler can live in the process.
- No ORM, no Redis, no queue, no compose file. SQLite and hand-written SQL are enough for one process, and they keep the storage decisions visible instead of behind a library.
- No stored scores. They are cheap to recompute, and persisting them means a migration every time a curve moves and a cache that can disagree with the data it came from.
- No extra activities, no coastline orientation, no resort or beach lookup. Each is a separate data source, and none of them changes the shape of the answer.
- No second opinion on a marine outage. One all-null response still marks a town as having no wave coverage for a week, and confirming it with a second call would be right. It is in the log as a known gap rather than half-built.

## What I would do next

- The Ensemble API for real confidence, replacing the lead-time heuristic with member spread.
- A resort and beach lookup, so skiing can use a lift-served elevation and surfing a shore-aware break rather than the town's own cell.
- Postgres and a jobs table if this ever needs more than one instance, which is the only reason the scheduler is where it is.
- A derived feature table, if anyone ever wants to query across towns or over time. Today nothing derived is stored on purpose.

## License
MIT
