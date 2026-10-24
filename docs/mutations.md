# Mutations

A test that cannot fail proves nothing. Every repository made from the
template proves its non-unit tests can fail, in a required pull-request
check (issue #21).

Shyden, 2026-10-16, in steadyhand #288, where the first mutations workflow ran
only on a label: *"mutation testing is vital. we need it"*, then *"it must be
run"*. Asked which pull requests must carry and run a mutation file, he chose
*"Changed tests (Recommended)"*; asked whether it is global, *"Every project
(Recommended)"*.

## The check

`.github/workflows/mutations.yml` runs on every pull request, with no label
to opt in, as the job `mutations`. Make it a required check on `develop` and
`main` (README, step 3). It runs `node scripts/mutate.ts pr <base>`, which:

1. **Judges the diff.** A pull request that adds or changes a non-unit test
   file must also add or change a mutation file targeting that test. The check
   names every one that has none. A pull request touching neither passes at
   once, saying how many paths it judged.
2. **Runs every mutation file the pull request adds or changes.** It runs each
   file's targets clean first; a target already red is refused. Then, for each
   row, it plants the mutation (its anchor must appear exactly once), runs the
   targets, judges the result against the row's prediction, and puts the file
   back, even when the run fails. A row not as predicted fails the check, and
   so does a test total that moved.

Unit-test mutations may still run on the laptop:
`node scripts/mutate.ts run mutations/<file>.json`.

Non-unit test files are the ones under a suite listed in `SUITES`
(`scripts/mutate.ts`). Today that is `tests/logs/` (`docs/logs-suite.md`) and
`tests/integration/` (`docs/unit-limits.md`). A
new suite joins that list.

## A mutation file

`mutations/<name>.json`:

```json
{
  "targets": ["tests/logs/writer.test.ts"],
  "suite": "logs",
  "mutations": [
    {
      "name": "drops the timestamp",
      "path": "src/writer.ts",
      "anchor": "at: now()",
      "replacement": "at: 0",
      "predict": { "red": ["stamps each line"] }
    },
    {
      "name": "an equivalent rename",
      "path": "src/writer.ts",
      "anchor": "const line",
      "replacement": "const entry",
      "predict": { "green": true }
    }
  ]
}
```

- `targets`: the non-unit test files this file proves.
- `suite`: the suite that runs them.
- Each row: an exact `anchor` and its `replacement`, and the prediction,
  written BEFORE the run. That's `red` with the tests that must fail (each
  name a substring of a failing test's full name, and no other test may
  fail), or `green` when the mutation should change nothing.

## Reading a misprediction

A row not as predicted is a finding, never something to re-run. Read the whole
result:

- **Predicted red, stayed green.** The test cannot see that change: strengthen
  it, or show the mutation is truly equivalent and predict green.
- **Other tests failed.** The change reaches further than you thought: name
  them, or narrow the mutation.
- **The total moved.** A test was dropped or added: find out why before
  trusting anything else.

Record what you found in the pull request. Changing a prediction to match the
run without saying why is the defect this check exists to stop.
