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
replaces only that exclude list. Coverage is off in the 1 s unit step
(`npm run test:unit`) and runs as its own command:

```sh
npm run test:coverage          # writes coverage/lcov.info and coverage/coverage-summary.json
npm run coverage:record        # laptop, or the record workflow: writes coverage-record.json
node scripts/coverage-record.ts check   # CI's coverage job
```

## The record

`coverage-record.json` holds each file's count of **untested** statements and
branch arms. It holds counts, not percentages. With a percentage, deleting
well-tested code would lower the figure, and the PR doing the deleting would
be blocked even though nothing got worse.

- No file's count may rise. A file at zero stays at zero.
- The record must **equal** what was measured, so a gain is recorded in the
  pull request that earns it. Run `npm run coverage:record` and commit the
  file with the change.
- The recorder refuses any rise. In CI it runs only in the record workflow,
  on a scratch ref, and hands the file back as an artifact
  (`docs/measure-then-commit.md`); no check run can record.
- The check fails on a code file on disk that no suite measured. It fails
  closed on a missing or malformed report or record.
- The coverage command runs the unit suite (`vitest.unit.config.ts`). Files a
  project adds under `tests/logs/` run only in the logs suite
  (`docs/logs-suite.md`), so the check names each as unmeasured until that
  suite's coverage is joined into the record. That is a gap to close, never a
  file to exclude.

Before a repository's first record, run the coverage command more than once
and compare the summaries. A line whose coverage changes from run to run gets
a fixed test, never a looser record.

100% is the goal: every count at zero. A changed line that no test ran fails
its pull request once #36 lands.
