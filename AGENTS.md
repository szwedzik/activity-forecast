# Working in this repo

This is a take-home: a small Node/GraphQL service that ranks the next 7 days for skiing, surfing and sightseeing (outdoor and indoor) at a given town, using Open-Meteo data that we keep in SQLite. The people reviewing it care more about how the work was done than about the code itself, so the docs and the git history are not extras here. Keep them honest.

## Start here

Read docs/PHASES.md first. It says what to build and in what order. docs/DESIGN.md is the reference it points into (cited as D§n). Decisions, PM questions and the worklog live in docs/ as well; add to them, don't rewrite them.

## Commands

    npm ci                            Node 24 (needs >= 22.13 for node:sqlite)
    npm run check                     typecheck + tests. Run it before every commit.
    npm run dev                       tsx watch, GraphiQL on http://localhost:4000/graphql
    npm run score-fixture -- lisbon   scoring table for a captured fixture
    npm run capture-fixtures          hits the real API. Only when I ask.

## How I want this done

Work one phase at a time, via /phase N. Don't start the next one until the current one is actually done: every DoD box ticked, check green, reviewer passed, worklog entry written, committed.

Don't commit red. There's a pre-commit hook for that; don't --no-verify around it.

Commit when I say so, not before. I want to read the history afterwards. Conventional Commits subject, and a body that says why, with D-xxx / Q-xxx references where they apply.

If the design turns out to be wrong, change it, but write it down: an entry in docs/DECISIONS.md and a line in the worklog. Silent deviations are the only kind I'll be annoyed about.

If something is a product question ("what should happen when..."), pick an answer, put it in docs/QUESTIONS.md with what breaks if it's wrong, and move on. Don't block on it.

Ask me before: adding a dependency (a hook blocks `npm install <pkg>`; deps go into package.json by hand, with a decision entry), changing the GraphQL schema in D§8.1, changing a TTL default, or dropping tests the design asks for.

Tests never hit the network. Fixtures are in test/fixtures/open-meteo.

## Code

- TypeScript strict, ESM, NodeNext. No `any`. Parse unknown input with zod at the edge, use real types inside.
- src/domain is pure. No I/O, no clock, nothing imported from services/ or adapters/. Time comes in as an argument. If you want Date.now() in there, you're in the wrong layer.
- SQL only in src/adapters/db. URLs only in src/adapters/openMeteo.
- Open-Meteo arrays are `number | null`. Inside DayFeatures that becomes `number | undefined`. Skip nulls when aggregating.
- Match weather and marine rows by their `time` string, never by index. The two snapshots can start on different days.
- Dates are 'YYYY-MM-DD' strings in the location's timezone; instants are ISO UTC strings. No date library.
- Every score comes with its factors. That's the product, not a nicety.
- Small pure functions, data tables instead of if-chains, named exports.
- Errors that reach GraphQL are GraphQLError with an extensions.code from D§8.3. Anything else stays masked.
- pino for logs. No console.log in src/.

## Tests

- vitest. test/unit mirrors src. test/integration goes through yoga.fetch with an in-memory db and fake clients built from the fixtures.
- Each row of the freshness table (D§6.1) and each failure mode (D§6.4) gets its own named test.
- Scores are asserted as bands; labels, ranks and policy states exactly.
- A test that can't fail gets deleted.

## Don't build

Front end, auth, an ORM, Redis, queues, docker-compose, plugin systems, stored scores, more activities, coastline orientation, resort or beach databases. Focus is the point of the exercise.

## Logs

docs/DECISIONS.md, docs/QUESTIONS.md, docs/WORKLOG.md. Append only. New entries copy the shape of the previous one.
