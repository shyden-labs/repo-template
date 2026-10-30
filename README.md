# Shyden Labs repo template

Start every new Shyden Labs repository from this one. It carries the supply-chain
configuration that is **mandatory in every repo**, and the test that stops it
rotting.

## What is here, and why each piece exists

| File | Why |
| --- | --- |
| `.github/dependabot.yml` | Version updates are **not** inheritable org-wide — only *security* updates are. Every repo needs its own file, covering every ecosystem present **and** `github-actions`. |
| `.github/workflows/ci.yml` | Demonstrates the SHA-pinning convention with real, current pins. |
| `.github/node/Dockerfile` | CI's one exact Node version, in the one file Dependabot's `docker` entry bumps, so Node changes only through a pull request (issue #143). |
| `tests/unit/supply-chain.test.ts` | Asserts the rules below, so a new unpinned action or an undeclared ecosystem fails CI instead of being noticed years later. |
| `tests/unit/install-script-approvals.test.ts` | No workflow approves a dependency's install script past `allowScripts` in `package.json` (issue #78): every route npm reads, in every spelling it accepts, measured on npm itself. |
| `tests/unit/source-text.ts` | Comment stripping. A guard that reads a file as text must never be satisfiable by that file's own documentation. |
| `.npmrc` | `engine-strict=true` turns the `engines` floor from a warning into a hard install failure. |
| `package-lock.json` | `npm ci` refuses to run without it, so CI installs exactly what was tested. |
| `LICENSE` | Apache-2.0, the default for new Shyden Labs code. |
| `.github/ISSUE_TEMPLATE/story.yml`, `scripts/file-story.ts` | Every project files a ticket the same way (issue #20): story line, context, complete acceptance criteria, what it lets us announce, and a definition of done, all required; then on the board an Estimate, a Priority, a Blocked-by link for each blocker and its parent. `file-story.ts` does it and reads every field back. |
| `scripts/board-setup.ts`, `scripts/board-progress.ts`, `docs/project-board.md` | Every board has a Number field `Estimate`. Every close-out reports progress by tickets and by effort, measured from the board. |
| `scripts/branch-rules-setup.ts`, `scripts/release-cut.ts`, `.github/workflows/check-release-cut.yml`, `docs/release-cut.md` | `develop` and `main` each carry a ruleset naming the branch (issue #8). `develop`'s required checks are strict, so two pull requests that pass alone can never land untested together. `main`'s are not, since each release merge never reaches squash-only `develop`; instead `release-cut`, run from the default branch's own copy, proves each pull request into `main` lands exactly a release cut CI tested (issue #86). |
| `scripts/coverage-provider.ts`, `scripts/coverage-record.ts`, `coverage-record.json`, `docs/coverage.md` | Coverage measures every code file, tests included, and the record holds each file's untested statements and branch arms: no count may rise, and the record must equal what was measured (issue #32). |
| `tests/setup/limits.ts`, `tests/setup/refusals.ts`, `vitest.unit.config.ts`, `vitest.integration.config.ts`, `docs/unit-limits.md` | Every unit test runs in under 1 s and 0.1 s of its own CPU, its file loads in 0.1 s of CPU, and it starts no process and opens no connection; every run reports both CPU figures, and a case that cannot fit moves to the integration suite, leaving a stand-in (issue #92). |
| `scripts/cli.ts` | Every script's command-line entry, in one place, so it is tested in-process like the rest. |
| `.github/workflows/sonarcloud.yml`, `scripts/sonar-verdict.ts`, `docs/sonarcloud.md` | SonarCloud scans every pull request and its quality gate blocks it: green only on OK for the analysis that scan made, and no step that skips the scan or swallows a failure (issue #27). |
| `playwright.config.ts`, `tests/unit/device-projects.ts`, `scripts/devices-report.ts`, `docs/devices.md` | Every mobile test is one test, run on Android AND iOS in parallel (issue #26): the phone projects run exactly the same files, no test is named for one platform, and a stand-in input is marked. |
| `.github/workflows/record.yml`, `scripts/fold-record.ts`, `docs/measure-then-commit.md` | Files that only measuring can write (a coverage record, floors, baselines) are measured on a scratch ref and handed back as an artifact; the session folds them into its unpushed commit and pushes once. No workflow but deploy and release writes to the repository (issue #30). |
| `docs/api-docs.md` | Every API a repository builds has a fully capable Swagger interface; a private API's docs are private (operator ruling 2026-10-15). The standard, its four decisions, and what a project does. |
| `docs/logs-suite.md`, `vitest.logs.config.ts`, `vitest.unit.config.ts`, `.github/workflows/logs.yml` | Logging and auditing have a test suite of their own, run in CI as a prerequisite to a release, never on a pull request (issue #16). Unit is limited to `tests/unit/`, and an empty logs suite fails. |
| `docs/logging.md` | Every project's diagnostic logs go to one store, run the same way everywhere, added after each project's release (issue #18): one line format refusing personal data at write time, our own collector writing gzipped batches to Cloudflare R2, our own viewer, and a budget inside Cloudflare's free limits. |
| `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.githooks/pre-push`, `docs/static-checks.md` | Every code file is typechecked under strict settings, linted with typescript-eslint's strict rules and format-checked, in CI and before every push (issue #61). |
| `scripts/workflow-lines.ts`, `scripts/workflow-trace.ts`, `scripts/workflow-coverage.ts`, `scripts/workflow-coverage-check.ts`, `scripts/coverage-dispatch.ts`, `.github/workflows/workflow-coverage.yml`, `scripts/zip.ts`, `docs/workflow-lines.md` | Workflow lines are code: every `run:` step runs under a tracing shell that records the lines bash ran, each job uploads the traces, one commit's runs become lcov for every workflow file, and a required check fails a pull request whose workflow files leave more lines unrun than its base, after the hand-started workflows it changes or its base ran have run on its own commit through a `coverage/<branch>/<sha7>` branch (issue #35). |

## The five rules

1. **Every repo gets Dependabot**, covering every ecosystem present and `github-actions`.
2. **Pin actions to SHAs, never tags.** A tag is mutable and can be repointed by anyone who can push to that action's repo. Keep the trailing `# vX.Y.Z` comment: it is what makes a bump reviewable rather than an opaque hex swap.
3. **Target `develop`, never `main`.** A PR against a protected default branch either cannot merge or bypasses the dev gate.
4. **Group same-repo sub-path actions and pinned pairs, and exclude them from every catch-all.** Dependabot offers a package to every group that can hold it, and a group with no patterns (`patch-updates`) outscores any wildcard, so order decides nothing (Shyden, 2026-10-20). Each group with no patterns lists every pattern group's patterns in `exclude-patterns`, and `tests/unit/supply-chain.test.ts` checks that each pattern group's packages can land in that group alone.
5. **`develop` is the default branch.** GitHub opens Dependabot **security** fixes against the default branch only; `target-branch` steers version updates alone. With `main` as default, every security fix opens where the develop-first flow cannot merge it (ShyTalk #2183 sat there a month). CI's first step fails unless the default branch is `develop`. Before switching an existing repo, turn every scheduled workflow that acts on a live system into a trigger that dispatches the real job with `--ref main`, because GitHub runs scheduled workflows from the default branch.

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
2. Create `develop` and make it the default branch before Dependabot first runs: `.github/dependabot.yml` targets `develop`, security fixes go only to the default branch, and a repository created from a template copies only the default branch. CI fails until this is done (rule 5).
3. **Require up-to-date pull requests on `develop`, and a release cut on `main`, each by its own ruleset.** As the operator (rulesets need admin rights): `node scripts/branch-rules-setup.ts <owner/repo> <required check>...`. Name every check the template's CI runs: `build-and-test coverage mutations workflow-coverage`. Then read both branches' rules back (`rules/branches/develop` and `rules/branches/main`): `develop` requires all four, strict; `main` requires them and `release-cut`, not strict (`docs/release-cut.md`). Each ruleset names its branch and requires pull requests, signed commits and the named checks. On `develop` they run with *require branches to be up to date* (strict), so what lands is exactly what CI tested; on `main`, the `release-cut` status proves the same of each release cut, because each release merge never reaches squash-only `develop`, so a strict `main` would refuse every cut after the first. `release-cut` is posted from the default branch's own copy, so it must be on the default branch before `main` requires it. It refuses a ruleset that targets `~DEFAULT_BRANCH`: that target moves when the default branch changes, which is how ShyTalk's `main` lost its rules (2026-10-13). Once both branches read back as forbidding deletion, it then turns on **Automatically delete head branches** (`delete_branch_on_merge`) and reads it back: a template copies files, not settings, and the order matters, because with that setting on a deletable `develop` would be deleted by the first `develop` → `main` pull request. Last, it gives the `dev` environment, which holds the dev credential, a deployment branch policy naming `develop` alone, and reads it back: without one, a branch's pull request could name `environment: dev` and read its secrets (#117). It never changes a `dev` that has reviewers or a wait timer; set that one's deployment branches to `develop` by hand.
4. Add the ecosystems your repo actually uses to `.github/dependabot.yml`.
5. `npm ci && npm run test:unit` — the supply-chain suite must be green before anything else is written.
6. Enable Dependabot alerts and security updates on the new repo. Org defaults now cover new repositories, but check rather than assume.
7. Set up the project board as `docs/project-board.md` describes: record its node id and title, run `node scripts/board-setup.ts`, give every story an Estimate when it is filed, and run `node scripts/board-orphans.ts` in the required PR checks so no ticket stays In Progress without a branch or pull request.
8. **Fill in `.github/workflows/deploy-dev.yml`.** Every merge into `develop` deploys to dev by this trigger; replace its last step with your own deploy, acting only on the areas in `changed-files.txt`. Every pull request runs the same job as a rehearsal in the `dev-rehearsal` environment, which holds no credential, with `DEPLOY_REHEARSAL` set to `true`: there your deploy checks and builds but deploys nothing. Until then it fails, naming that step. A repository that hosts nothing deletes the workflow and `tests/unit/deploy-dev.test.ts`, and says why in its README.
9. **Every API gets a Swagger interface.** If the repository serves any API (an HTTP route, a function, a webhook), follow `docs/api-docs.md` before its first route ships: a hand-written OpenAPI spec with contract tests, self-hosted Swagger UI, and private docs behind the operator's sign-in.
10. **Keep coverage recorded.** Coverage is measured in CI, never on the laptop: `npm run test:coverage` also runs the integration suite. Push your commit to a scratch ref, start the record workflow (`record.yml`) on it, fold its record into the commit with `node scripts/fold-record.ts <run-id>`, then push once; `docs/measure-then-commit.md` has the steps. CI's `coverage` job fails when any file's untested count rose, when a gain was left unrecorded, when a code file went unmeasured, or when a comment tells coverage to skip a line. Make `coverage` a required check. `docs/coverage.md` explains why.
11. **Before the first release, put the log and audit checks in `tests/logs/`** and make `.github/workflows/logs.yml` a required step of the release (`docs/logs-suite.md`).
12. **Every mobile test is one test, run on Android AND iOS.** Write each device test once in `tests/devices/`; the phone projects in `playwright.config.ts` run exactly the same files in parallel, each saying whether its input is real taps or a marked stand-in, and no test is named for one platform. `tests/unit/device-suite.test.ts` holds the repository to it, and `node scripts/devices-report.ts` checks each run (`docs/devices.md`).
13. **Turn on SonarCloud before the first pull request.** Follow `docs/sonarcloud.md`: create the project, turn Automatic Analysis off, add `SONAR_TOKEN` as an Actions secret and a Dependabot secret, then call `.github/workflows/sonarcloud.yml` from the pull-request workflow and make its job a required check.
14. **Keep the static checks clean.** `npm ci` installs `.githooks/pre-push`, which runs `npm run format:check`, `npm run lint` and `npm run typecheck` before every push; CI runs the same three as named steps of `build-and-test`. Fix each finding in the code, never with a disable comment. The one exemption, granted by the operator for that case alone, is Vitest 5's `({}, suite)` in `tests/setup/limits.ts`; any other needs the operator's ruling first (`docs/static-checks.md`). See `docs/static-checks.md`.
15. **Every app logs, after its release.** When the project's first release has shipped, add its logs as `docs/logging.md` fixes: the line format and its refusals, server apps sending to the collector and device apps keeping their log on the device, and the project's measured lines a day and streams added to the budget. It never makes a release wait.
16. **Keep CI's Node in `.github/node/Dockerfile` alone.** It is one line, `FROM node:<major>.<minor>.<patch>`, and no workflow reads any other Node version. Dependabot's `docker` entry bumps it as a pull request of its own, so a Node release that warns turns only that pull request red, never every open one; merge it once its checks pass, or hold it and read the failure, which names the package that warned. Each job reads the file in a step with `id: node` and gives the version to `actions/setup-node`; `tests/unit/supply-chain.test.ts` refuses any other way of setting Node up, and a new major is your own pull request (#143).
