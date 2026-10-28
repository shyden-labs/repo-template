# Coverage

Every repository made from the template measures every line of its code and
holds what it measured, so no untested line lands and no file slides back
(issue #32). The rules are Shyden's, ruled on 2026-10-21 and 2026-10-22, and
apply to every project.

## What counts as code

Every TypeScript and JavaScript file, tests and tool configs included, and the
workflow files. A line that a comment tells coverage to skip counts as unrun,
so the check refuses any such comment. Workflow lines are measured from a run
on the same commit (issue #35).

## One tool

Vitest with `@vitest/coverage-v8`, pinned to Vitest's exact version (a test
fails if they drift; Dependabot moves them together). Vitest always leaves test
files, setup files and its config out of coverage and does not let a project
change that, so `scripts/coverage-provider.ts` subclasses the V8 provider and
replaces only that exclude list.

Coverage is off in the 1 s unit step (`npm run test:unit`) and runs as its
own command, in CI only: it runs the integration suite too, and the laptop
runs only unit tests, formatters, linters and type checks (Shyden,
2026-10-09). The record workflow records, and the laptop folds its record
into the commit (`docs/measure-then-commit.md`):

```sh
npm run test:coverage                   # CI: writes coverage/lcov.info and coverage/coverage-summary.json
node scripts/coverage-record.ts check   # CI's coverage job
npm run coverage:record                 # the record workflow, on a scratch ref: writes coverage-record.json
node scripts/fold-record.ts <run-id>    # the laptop: folds that run's record into the commit
```

## The record

`coverage-record.json` holds each file's count of **untested** statements and
branch arms. It holds counts, not percentages. With a percentage, deleting
well-tested code would lower the figure, and the PR doing the deleting would
be blocked even though nothing got worse.

- No file's count may rise. A file at zero stays at zero.
- The record must **equal** what was measured, so a gain is recorded in the
  pull request that earns it: record it with the record workflow and fold
  it into the commit with the change.
- The recorder refuses any rise. It runs only in the record workflow, in CI
  on a scratch ref, and hands the file back as an artifact
  (`docs/measure-then-commit.md`); no check run can record.
- The check fails on a code file on disk that no suite measured. It fails
  closed on a missing or malformed report or record.
- Every suite's coverage joins one report (#66). The coverage command is one
  Vitest run with a project per suite (`vitest.coverage.config.ts`): unit and
  integration today, so a file only the integration suite runs is measured.
  `tests/unit/coverage-joins-every-suite.test.ts` holds that run to `SUITES`
  in `scripts/mutate.ts`, where a new suite joins: a suite left out, or a
  project running other files than its suite, fails it. The logs suite is the
  one suite left out, since it never runs on a pull request (operator
  2026-10-16); until #111 joins it, a file under `tests/logs/` reads as
  unmeasured. That is a gap to close, never a file to exclude.
- `coverage:record` refuses anywhere but the record workflow on a scratch
  ref: a laptop's summary cannot hold the CI-only suites the record joins.

Before a repository's first record, start the record workflow more than once
on the same commit and compare the records. A line whose coverage changes from run to run gets
a fixed test, never a looser record.

100% is the goal: every count at zero. A changed line that no test ran fails
its pull request once #36 lands.
