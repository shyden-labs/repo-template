# Workflow lines are code

A workflow's lines count as run only when a run on the same commit took them
(issue #35; Shyden 2026-10-22). This page covers what is built so far: reading
the steps, tracing what bash runs, and judging one commit's runs.

## Reading a workflow (`scripts/workflow-lines.ts`)

- `layout` gives every code line one owner: the workflow (its top settings),
  a job (its own keys) or a step. A line is code unless it is blank or a `#`
  comment; a run block's script lines are left to the trace. It names each
  step as the jobs API does (its `name:`, else `Run <uses>` or
  `Run <first script line>`), and keeps each run step's text exactly as the
  runner writes it: a plain value ends at its comment, `|` keeps one final
  newline, `|-` none. A job with `name:`, `strategy:`, `uses:`, `services:`
  or `container:` fails the read, naming it, because the API then reports
  other job names or steps (Shyden 2026-10-22: fail rather than guess).
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

## Judging one commit's runs (`scripts/workflow-coverage.ts`)

    node scripts/workflow-coverage.ts <commit-sha> <out.lcov>

With `GITHUB_REPOSITORY` and `GITHUB_TOKEN`, it lists every run on the commit,
each run's jobs over every attempt and its artifacts, unzips the trace
artifacts in process (`scripts/zip.ts`), and writes lcov for every file under
`.github/workflows`, printing each file's figure. Shyden's rulings of
2026-10-22:

- The top settings ran when any job of the workflow ran; a job's own lines
  when the job ran; a step's lines when it concluded `success` or `failure`
  in any run or attempt. `skipped` and `cancelled` are unrun, and a
  cancelled step's trace is ignored.
- A shell line ran when its step's trace shows it; a step that ran with no
  trace has every shell line unrun.
- Runs and attempts are joined: a line ran if any of them took it.
- Anything it cannot line up fails closed, naming it: a run, job or step not
  completed; an unmodelled conclusion; a run of a file the commit lacks; an
  API step list other than `Set up job`, the file's steps in order, `Post`
  steps, `Complete job`; a trace of a step that did not run, of no run step,
  or of another script (a `${{ }}` expression may change the script's hash,
  never its line count); a second page of runs, jobs or artifacts; an
  expired trace artifact.

It refuses runs still going, so it cannot run inside the CI run it judges:
whatever runs it waits until every run on the commit has completed.

First figure, dc5302f: 92 of 270 workflow lines ran (ci.yml 50 of 50,
deploy-dev.yml 42 of 43, the four workflows with no run on that commit 0).

The deploy job also runs on every pull request, as a rehearsal in the
`dev-rehearsal` environment, which holds no credential (AC3). The template
rehearses too: its own develop skips the deploy (#43), but its pull requests
run the job, and there the placeholder deploy step passes, since the template
hosts nothing (#121, Shyden 2026-10-28). Until #121, the template skipped the
rehearsal as well, so it never ran there and deploy-dev.yml read as unrun on
both sides of a comparison.

## The required check (`scripts/workflow-coverage-check.ts`)

    node scripts/workflow-coverage-check.ts <head-sha> <base-sha> <base-root>

`.github/workflows/workflow-coverage.yml` runs it on every pull request as the
job `workflow-coverage`; make that a required check on `develop` and `main`
(README step 3). Shyden's rulings of 2026-10-27 (AC5): compare live, and use
a job that waits.

1. It checks out the PR's head, not its merge commit, finds the commit the
   head branched from (`git merge-base` with the base branch) and checks that
   out beside it.
2. It waits for every run on both commits to complete, its own run aside,
   polling every 15 seconds and printing what it waits for. At 40 minutes it
   fails, naming each run still going: that is mutations.yml's 30-minute job
   limit plus ten minutes for a runner (assumed). The job's own limit is 45.
3. It measures both commits as above, prints each workflow file's unrun count
   on each side, and fails, naming the head's unrun lines, when any file
   leaves more lines unrun on the head than on the base. A file the base
   lacks starts from none. Counts are compared, not lines, because a line's
   number moves whenever the file is edited.

Workflow files get no entry in `coverage-record.json`: folding a record
amends the commit, so a recorded figure could never equal the runs on the
commit that carries it. Trace artifacts are kept 90 days, so a base made
up to 90 days before the PR can still be read; an older one fails, naming the
expired artifact.

What follows from comparing with the base:

- **A step that runs only on push** (`if: github.event_name == 'push'`) runs
  on the base, a develop commit, and never on a PR head, so every PR fails
  until the step also runs on PRs. The template has none.
- **The check's own lines** read unrun on both sides: its run is still going
  while it measures, so it skips it. A PR that adds lines to
  workflow-coverage.yml fails (Shyden 2026-10-27, accepted).
- **A run GitHub has not yet listed** when the check first looks reads as
  missing. Missing runs on the head can only add unrun lines, so the check
  fails rather than passes. It is not expected (assumed, not measured):
  GitHub makes every run of an event before any job starts, and the check
  first lists runs after its checkout and `npm ci`. A red check naming a whole
  workflow unrun on the head is the sign: file it with the run ids. The base's
  runs are a merged commit's, long finished.
- **Hand-started workflows run on the PR's own commit** (AC4, part 6):
  every one that ran on the base by hand or by schedule, and every one the PR
  changes, is started on the scratch branch `coverage/<branch>/<short-sha>`
  before the PR is pushed (docs/measure-then-commit.md, step 5). The check
  reads the same plan (`scripts/coverage-dispatch.ts`) and waits until each
  has a run on the head, naming the command that starts it. deploy-dev is
  never started: its PR rehearsal covers it. A hand-started workflow that
  names an environment is refused until it is listed beside deploy-dev, and
  one that needs a dispatch input or has no `workflow_dispatch` is refused,
  naming it.
  A started run gets this repository's secrets, so a fork's pull request
  that would need one fails at once, and a Dependabot commit is started only
  when its workflows change pins alone (Shyden 2026-10-28, "Fence it";
  docs/measure-then-commit.md).
- **A new hand-started workflow** cannot be started before it is on develop
  (measured: GitHub answers 404). One whose only triggers are
  `workflow_dispatch`, `schedule` or `workflow_call` is left out of the
  comparison and printed as not measurable until on develop (Shyden
  2026-10-28, ruling 2). Its lines are first measured when a later PR
  changes it or it runs on a base.
- **The template's logs suite is empty**, so in `shyden-labs/repo-template`
  alone `vitest.logs.config.ts` passes an empty suite; a repository made from
  the template still fails on one (ruling 1).

### Still to come (#35)

- A real-bash suite for the trace, which waits for #66: until every suite's
  coverage joins the record, a non-unit test file reads as unmeasured.
