# Measure, then commit

Some files can only be written by measuring a commit: a coverage record, guard
floors, visual baselines. The commit has to carry what was measured from it,
and nothing in CI pushes (Shyden, 2026-10-20 and 2026-10-21: never force-push,
and no CI bot pushes). So CI measures a commit the session has not pushed yet,
hands the files back, and the session folds them in and pushes once (issue
#30).

## The steps, in the order a session runs them

1. **Commit**, and don't push the branch. The commit must be on no remote
   branch, because folding amends it.
2. **Push it to a scratch ref** named for the branch and the commit:

   ```sh
   git push origin HEAD:refs/floors/<branch>/$(git rev-parse --short HEAD)
   ```

   A scratch ref is not a branch, so it starts no push, pull-request or
   deploy run. Naming it for the commit means a second attempt is a new ref,
   never a force-push over the old one. Use `refs/visual/...` for captures.
3. **Start the record workflow on it** (the workflow file comes from
   `develop`; the commit measured is the scratch ref's):

   ```sh
   gh workflow run record.yml --ref develop -f ref=refs/floors/<branch>/<short-sha>
   ```

   `record.yml` refuses any other ref before checking anything out. It holds
   no token that can write. It ends by uploading a `record` artifact: the
   files to commit, the SHA it measured, and one line for the commit message.
4. **Fold it in**, once the run has succeeded:

   ```sh
   node scripts/fold-record.ts <run-id>
   ```

   It refuses, by name, a tree with uncommitted changes, a HEAD a remote
   branch already holds, a run that is not a successful `record` run, and an
   artifact made from any commit but HEAD. The artifact's SHA is the proof:
   a dispatched run's own head is `develop`, never the scratch ref it
   measured. Otherwise it copies the files in and amends HEAD, adding the
   run's line to its message.
5. **Run the hand-started workflows on the finished commit** (issue #35,
   part 6). A run started by hand is stamped with the commit at the tip of
   the branch it was started on, so push the commit to a scratch branch
   named for it. No workflow runs on a push to `coverage/*`:

   ```sh
   sha=$(git rev-parse HEAD)
   git push origin "HEAD:refs/heads/coverage/<branch>/${sha:0:7}"
   base=$(git merge-base HEAD origin/develop)
   git worktree add --detach ../base-checkout "$base"
   node scripts/coverage-dispatch.ts "$sha" "$base" ../base-checkout <branch>
   ```

   It prints one `gh workflow run <file> --ref coverage/<branch>/<sha7>`
   line for each hand-started workflow the commit must run: every one that
   ran on the base by hand or by schedule, and every one the branch
   changes. deploy-dev is never among them (its pull-request rehearsal
   covers it). Run each line it prints. A hand-started workflow new on the
   branch cannot run before it is on develop, so it is printed as not
   measurable instead (Shyden 2026-10-28). Copy only a commit the section
   below allows: each run gets this repository's secrets.
6. **Push the branch once**, then delete the scratch ref:

   ```sh
   git push
   git push origin :refs/floors/<branch>/<short-sha>
   ```

   The pull request's `workflow-coverage` check waits for the hand-started
   runs on its head and reads them. Delete the coverage branch once that
   check has passed; the runs and their traces stay readable by the commit.

## Whose commits go to a coverage branch, and when the runs are missing

**A run started on a coverage branch runs that commit's own workflow files
with this repository's secrets and whatever token scopes they ask for.** A
`pull_request` run from a fork or from Dependabot gets neither. So only
Shyden's commits, the session's own, or a Dependabot commit that
`coverage-dispatch` accepts ever go to a coverage branch (Shyden
2026-10-28, "Fence it"):

- **A fork's commit never does.** `coverage-dispatch` refuses a commit that
  GitHub lists as the head of a fork's pull request, and `workflow-coverage`
  fails at once on a fork's pull request that would need hand-started runs,
  naming them; Shyden decides.
- **A Dependabot commit** goes there only when each workflow it would start
  differs from the base only in pinned `uses:` lines (the same action, a new
  40-hex SHA and its `# vX.Y.Z`), and reaches no more than a pull_request
  run would: top-level `permissions:` with no write scope, and no secret but
  the run's own token. Its code (`npm ci`, the tests) runs under those
  workflows. Run step 5 with its branch name (`dependabot/...`);
  `coverage-dispatch` refuses anything more, naming the file and line. Its
  new action code then runs during review, not only after merge (accepted).

A pull request nobody ran step 5 for, such as a Dependabot bump of an action
in `record.yml` or `logs.yml`, makes `workflow-coverage` wait, printing the
command for each missing run. Run step 5 for its head (for Dependabot, as
above) and run the commands; the check finds the runs and goes on. If its
40-minute ceiling passed first, start the missing runs and then re-run that
`workflow-coverage` job once: its input changed, so it is not a retry
(Shyden 2026-10-28, ruling 3). This is the only re-run allowed.

The commands are printed for a person to paste, so a branch, workflow file
or commit holding anything but letters, digits and `._/-` (a branch can be
named `x;curl …|sh`) is refused rather than printed; such a pull request's
runs are Shyden's call.

## What keeps it this way

`tests/unit/no-push-workflows.test.ts` refuses any workflow that pushes,
commits, amends or asks for a write token, except the deploy and release
workflows. `tests/unit/record-workflow.test.ts` pins `record.yml`'s shape.
`tests/unit/fold-record.test.ts` covers every refusal above.
`tests/unit/coverage-dispatch.test.ts` covers which workflows step 5 starts,
and `tests/unit/coverage-branches-start-nothing.test.ts` refuses any push
trigger that would run on a `coverage/*` branch.

## Filling it in

The template's `record.yml` records coverage (`docs/coverage.md`). A project
that measures more (floors, visual baselines) adds those steps before
"Gather what to commit", and copies their files into `record/files/` at their
paths in the repository.
