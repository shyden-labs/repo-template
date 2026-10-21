# The logs suite

Logging and auditing have a test suite of their own, run in CI as a
prerequisite to a release (operator ruling, 2026-10-16, every Shyden Labs
project; issue #16).

## Why

It was raised in yawelo-idle #84. The checks of that game's event log count
how often they reach rare situations, and some situations were so rare that
the checks needed up to 2,808 times more cases to be judged safely: minutes
more on every pull request. The operator's words, in order:

1. *"for this, i think it should be a different CI job dedicated to that. which we will run only as a pre-requisite to a release"*
2. *"i mean for the log checking and audit checking specifically. This should be a test suite of it's own"*
3. *"by the way. this should be the case for all projects, not just this one. separate test suite for logging and auditing. run in ci as a pre-requisite to a release"*

## What goes in it

The checks of any code that writes, keeps or replays a log or an audit trail:
event logs, audit logs (who did what, when, and why), logging pipelines, and
their heavy checks, such as property tests at their full counts and the
minimums or floors those checks are held to. They live in `tests/logs/`.

The unit suite keeps fast stand-ins of the same logic, so a defect still shows
on the pull request that makes it; the full checks move here rather than
being dropped.

## When it runs

- In CI, on the release head, before production. `.github/workflows/logs.yml`
  is started by hand on the release ref (`workflow_dispatch`) or called by the
  release pipeline (`workflow_call`), and a release does not go ahead until it
  passes.
- Never on every pull request: `ci.yml` runs the unit suite only.
- Until a project has a release pipeline, its release checklist names the
  logs workflow's green run on the release head as a required step.

## How it is set up

| File | Role |
| --- | --- |
| `vitest.unit.config.ts` | Limits unit to `tests/unit/`, so nothing in `tests/logs/` runs with it. |
| `vitest.logs.config.ts` | Collects `tests/logs/` only. It has no `passWithNoTests`: an empty suite fails, so a release gate cannot pass on nothing. |
| `.github/workflows/logs.yml` | Runs `npm run test:logs` in CI, by hand or from a release pipeline. Set its step's time limit from the suite's first measured runs. |
| `tests/unit/logs-suite.test.ts` | Pins all of the above. |

## What a new project does

1. List every log and audit trail the code writes, keeps or replays.
2. File a story for each, to put its checks in `tests/logs/` with stand-ins in
   unit.
3. Before the first release, make the logs workflow a required step of the
   release, and set its measured time limit.
