---
name: phase
description: Execute one implementation phase from docs/PHASES.md end to end (orient, implement with tests, verify the definition of done, run the phase-reviewer, log, prepare the commit). Invoke as /phase N.
disable-model-invocation: true
arguments: [phase]
---

Execute phase $phase of `docs/PHASES.md`.

## 1. Orient, no code yet
- Read `AGENTS.md`, then the "Phase $phase" section of `docs/PHASES.md`, then every design section it cites (D§n in `docs/DESIGN.md`). Skim `docs/DECISIONS.md` and `docs/QUESTIONS.md` for entries that mention this phase.
- Confirm the previous phase is finished: `git log --oneline -5`; `git status --short` is clean; `npm run check` is green; `docs/WORKLOG.md` has its entry. If anything is missing, stop and say what.
- Reply in at most 10 lines: goal, files you will create, tests you will write, what you will not do, open questions. For P4 and P5, call `EnterPlanMode` and write down the state table or the wiring before editing anything.

## 2. Implement
- Tests alongside code, in the order the phase lists them. Small pure functions; data tables over branching.
- Run `npm run check` often. The typecheck hook reports errors after each `.ts` edit; fix them before moving on.
- A deviation from the design gets a `docs/DECISIONS.md` entry and a WORKLOG line, then continue. Product ambiguity gets a `docs/QUESTIONS.md` entry, then continue. A dependency, an SDL change, a TTL change or a dropped test category means stop and ask.

## 3. Verify
- Tick every DoD box for this phase in `docs/PHASES.md` (`- [x]`). Each tick needs evidence you actually observed.
- Run the `phase-reviewer` subagent with "Review P$phase". Resolve FAIL findings. Anything you consciously skip gets a line in WORKLOG saying why.

## 4. Log and hand over
- Append the WORKLOG entry in the same shape as the previous ones: date, phase, what was built, what changed against the plan and why, what was skipped, what surprised you.
- Propose the commit(s): Conventional Commits subject; body with the why and D-/Q- references. Do not commit until the user says so, and never with `--no-verify`.
- Finish with at most 8 lines: what is done, what is not, what the next phase needs.
