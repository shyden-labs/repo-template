# Workflow lines are code

A workflow's lines count as run only when a run on the same commit took them
(issue #35; Shyden 2026-10-22). This page covers what is built so far: reading
the steps, and tracing what bash runs.

## Reading a workflow (`scripts/workflow-lines.ts`)

- `runSteps` reads every `run:` step: its job, the name GitHub gives it in
  `GITHUB_ACTION` (its `id`, else `__run`, `__run_2`, … over the job's id-less
  run steps), its script and the line where the script starts. It reads the
  block style the template writes, and refuses any other shape a run could
  hide in. A `run:` line it did not read fails the read.
- `executableUnits` finds a script's executable lines with the bash grammar
  (`@vscode/tree-sitter-wasm`).
- `ranLines` decides what ran from traced line numbers. A unit ran if any
  traced line falls in it, and a line ran only if every unit on it ran.
- `lcov` writes the record.

## Tracing what bash runs (`scripts/workflow-trace.ts`)

Every workflow sets `defaults.run.shell` to `TRACE_SHELL`, and no step sets its
own `shell:`. The shell runs each step's script under bash with a DEBUG trap.
Each step writes `$RUNNER_TEMP/workflow-trace/<job>/<GITHUB_ACTION>`, holding:

1. the script's `sha256sum` line,
2. its line count (`grep -c ''`: the runner writes a one-line script with no final newline, which `wc -l` counted as 0),
3. each line number bash was about to run in that script, and no other file's.

The hash and count show whether the script that ran is the one in the workflow
file: a `${{ }}` expression can change it. Each job's last step uploads the
folder as the artifact `workflow-trace-<job>`, under `if: ${{ !cancelled() }}`,
so a failed step still leaves its trace.

### Why the prelude is written the way it is

- **It is inlined in the shell string, not a file.** A step can run before
  checkout: `record.yml` checks its ref first.
- **It holds no brace but `{0}`.** The runner reads the string through .NET
  `string.Format`, where any other brace is a format item and throws. So
  `$BASH_SOURCE` is used, never `${BASH_SOURCE[0]}`.
- **It is one double-quoted argument.** The runner starts bash with .NET's
  argument splitting, never a shell, so `$RUNNER_TEMP` and the rest reach bash
  as written, and bash expands them.

The runner's source settles all three: `ScriptHandler.cs`, `ScriptHandlerHelpers.cs`
and `ProcessInvoker.cs` in `actions/runner`, read 2026-10-22. `runnerArgs` models
the parts this string uses and refuses the rest: a backslash, `""`, an unclosed
quote, or a script path holding a quote.

The script is `source`d, not run as a file, so `$0` inside it is the script's
path, as before. Steps run on Linux runners: `sha256sum` is GNU coreutils.

### Still to come (#35)

- Reading one commit's runs (job and step results plus these traces) into
  lcov for every workflow file.
- Joining that lcov to the code coverage record (blocked by #30).
- A real-bash suite for the trace, which waits for #66: until every suite's
  coverage joins the record, a non-unit test file reads as unmeasured.
