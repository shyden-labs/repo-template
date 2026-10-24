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
5. **Push the branch once**, then delete the scratch ref:

   ```sh
   git push
   git push origin :refs/floors/<branch>/<short-sha>
   ```

## What keeps it this way

`tests/unit/no-push-workflows.test.ts` refuses any workflow that pushes,
commits, amends or asks for a write token, except the deploy and release
workflows. `tests/unit/record-workflow.test.ts` pins `record.yml`'s shape.
`tests/unit/fold-record.test.ts` covers every refusal above.

## Filling it in

The template's `record.yml` records coverage (`docs/coverage.md`). A project
that measures more (floors, visual baselines) adds those steps before
"Gather what to commit", and copies their files into `record/files/` at their
paths in the repository.
