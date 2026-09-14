@AGENTS.md

Claude Code notes:

- /phase N is the only way to start a phase. The open-meteo and scoring skills load by themselves when relevant; read them instead of guessing API shapes or thresholds.
- phase-reviewer (.claude/agents) checks a finished phase against the plan, read-only. /phase runs it before proposing a commit.
- Hooks: guard.mjs blocks `npm install <pkg>`, `git commit --no-verify` and force pushes. typecheck.mjs runs tsc after every .ts edit and shows the errors; it stays quiet until P0 has installed TypeScript.
- P4 and P5: go into plan mode first (EnterPlanMode) and write the state table or the wiring down before editing.
- /code-review at the end of each phase, /simplify and /security-review in P7, /fewer-permission-prompts after P1.
- Installed globally and worth using: the vitest skill (antfu) for test setup, the node skill (mcollina) for shutdown and error patterns, graphql-schema (Apollo) when reviewing the SDL in P5.
- Commit messages end with the Co-Authored-By line and nothing else. No Claude-Session trailer.
