# Shyden Labs repo template

Start every new Shyden Labs repository from this one. It carries the supply-chain
configuration that is **mandatory in every repo**, and the test that stops it
rotting.

## What is here, and why each piece exists

| File | Why |
| --- | --- |
| `.github/dependabot.yml` | Version updates are **not** inheritable org-wide — only *security* updates are. Every repo needs its own file, covering every ecosystem present **and** `github-actions`. |
| `.github/workflows/ci.yml` | Demonstrates the SHA-pinning convention with real, current pins. |
| `tests/unit/supply-chain.test.ts` | Asserts the rules below, so a new unpinned action or an undeclared ecosystem fails CI instead of being noticed years later. |
| `tests/unit/source-text.ts` | Comment stripping. A guard that reads a file as text must never be satisfiable by that file's own documentation. |
| `.npmrc` | `engine-strict=true` turns the `engines` floor from a warning into a hard install failure. |
| `package-lock.json` | `npm ci` refuses to run without it, so CI installs exactly what was tested. |
| `LICENSE` | Apache-2.0, the default for new Shyden Labs code. |
| `.github/ISSUE_TEMPLATE/story.yml` | A story is fully defined at filing: story line, context, complete acceptance criteria, and an Estimate on the board. |
| `scripts/board-setup.ts`, `scripts/board-progress.ts`, `docs/project-board.md` | Every board has a Number field `Estimate`. Every close-out reports progress by tickets and by effort, measured from the board. |
| `scripts/branch-rules-setup.ts` | `develop` and `main` each carry a ruleset naming the branch, with strict required checks, so two pull requests that pass alone can never land untested together (issue #8). |
| `scripts/coverage-provider.ts`, `scripts/coverage-record.ts`, `coverage-record.json`, `docs/coverage.md` | Coverage measures every code file, tests included, and the record holds each file's untested statements and branch arms: no count may rise, and the record must equal what was measured (issue #32). |
| `scripts/cli.ts` | Every script's command-line entry, in one place, so it is tested in-process like the rest. |
| `docs/api-docs.md` | Every API a repository builds has a fully capable Swagger interface; a private API's docs are private (operator ruling 2026-10-15). The standard, its four decisions, and what a project does. |

## The four rules

1. **Every repo gets Dependabot**, covering every ecosystem present and `github-actions`.
2. **Pin actions to SHAs, never tags.** A tag is mutable and can be repointed by anyone who can push to that action's repo. Keep the trailing `# vX.Y.Z` comment: it is what makes a bump reviewable rather than an opaque hex swap.
3. **Target `develop`, never `main`.** A PR against a protected default branch either cannot merge or bypasses the dev gate.
4. **Group same-repo sub-path actions, above the catch-all.** Dependabot assigns to the **first** matching group and stops, so a group declared below `patch-updates` never runs.

## The rule behind the rules

**Test the invariant, don't trust the config.** Each rule above is asserted by
`tests/unit/supply-chain.test.ts` — and every one of those assertions has been
mutation-verified: break the thing it protects, watch it fail, restore it, watch
it pass.

That is not ceremony. `shyden.co.uk` shipped a guard asserting `dependabot.yml`
contained `"actions/cache*"`, and the file's own explanatory **note** spelled
that pattern out verbatim. The check passed with **no group configured at all**
(issue #23). Three more of the same shape have been found since. The vacuity is
invisible until you break something and watch.

So: **strip comments before asserting**, assert **order** where order carries
meaning, prefer an exact set to a substring test, and never trust a guard you
have not watched fail. Note that this repo's `dependabot.yml` *configures* the
sub-path group rather than describing it in a comment — that distinction is the
whole lesson.

## Using it

1. **Use this template** on GitHub, or `gh repo create <name> --public --template shyden-labs/repo-template`. New repos are public and open source: `LICENSE` is Apache-2.0, and a repo carrying game, art or learning content adds its own content licence on top.
2. Create `develop` and make it the default branch before Dependabot first runs: `.github/dependabot.yml` targets `develop`, and a repository created from a template copies only the default branch.
3. **Require up-to-date pull requests on `develop` and `main`, each by its own ruleset.** As the operator (rulesets need admin rights): `node scripts/branch-rules-setup.ts <owner/repo> <required check>...`. Each ruleset names its branch, requires pull requests, signed commits and the named checks with *require branches to be up to date* (strict), so what lands is exactly what CI tested. It refuses a ruleset that targets `~DEFAULT_BRANCH`: that target moves when the default branch changes, which is how ShyTalk's `main` lost its rules (2026-10-13).
4. Add the ecosystems your repo actually uses to `.github/dependabot.yml`.
5. `npm ci && npm run test:unit` — the supply-chain suite must be green before anything else is written.
6. Enable Dependabot alerts and security updates on the new repo. Org defaults now cover new repositories, but check rather than assume.
7. Set up the project board as `docs/project-board.md` describes: record its node id and title, run `node scripts/board-setup.ts`, give every story an Estimate when it is filed, and run `node scripts/board-orphans.ts` in the required PR checks so no ticket stays In Progress without a branch or pull request.
8. **Fill in `.github/workflows/deploy-dev.yml`.** Every merge into `develop` deploys to dev by this trigger; replace its last step with your own deploy, acting only on the areas in `changed-files.txt`. Until then it fails, naming that step. A repository that hosts nothing deletes the workflow and `tests/unit/deploy-dev.test.ts`, and says why in its README.
9. **Every API gets a Swagger interface.** If the repository serves any API (an HTTP route, a function, a webhook), follow `docs/api-docs.md` before its first route ships: a hand-written OpenAPI spec with contract tests, self-hosted Swagger UI, and private docs behind the operator's sign-in.
10. **Keep coverage recorded.** `npm run test:coverage`, then `npm run coverage:record`, and commit `coverage-record.json` with the change that moved it. CI's `coverage` job fails when any file's untested count rose, when a gain was left unrecorded, when a code file went unmeasured, or when a comment tells coverage to skip a line. Make `coverage` a required check. `docs/coverage.md` explains why.
