# SonarCloud

Every repository runs SonarCloud on every pull request, and a failed quality
gate blocks it (issue shyden-labs/repo-template#27). Shyden ruled on 2026-10-18 that a scan
that does not run must fail, and that the results must be checked, failing the
workflow when the gate fails. Then, asked how: every project adopts SonarCloud,
blocking.

## What the template gives you

- `.github/workflows/sonarcloud.yml`, a reusable workflow with two jobs, so
  the token never shares a job with a dependency install or the branch's own
  code (issue shyden-labs/repo-template#193):
  - `coverage-report` installs the dependencies and runs the coverage command
    (a failure there fails the check). It holds no secret, and hands on only
    `coverage/lcov.info`.
  - `sonarcloud`, the required check, checks out afresh and runs no npm. It
    reads `SONAR_TOKEN` from the `sonarcloud` environment and fails when the
    token is missing. It scans that coverage against `https://sonarcloud.io`,
    then reads the quality gate of that scan's analysis with
    `scripts/sonar-verdict.ts`, which loads Node's built-ins alone. It is green
    only on `OK`; `ERROR` fails, naming each failed condition with its value
    and threshold.
- The verdict reader sends the token to `https://sonarcloud.io` alone. A
  `report-task.txt` naming any other server fails before the token is sent.
- A branch analysis (a push to `develop`) that indexed no source files fails,
  naming why, even when the gate says `OK`: an empty analysis passes the gate
  on nothing (issue shyden-labs/repo-template#191). A pull request analysis
  counts only the files the pull request changed, so one that changes only
  docs has no `files` measure; it is judged by its gate alone, and the push
  to `develop` after it carries the check. Measured 2026-11-17: `develop`
  indexed 22 files, none of them Markdown; PR 189, which changed one workflow
  and one test, counted 1.
- The scan treats `tests/` as tests, not source, and leaves the config files
  the unit suite does not measure out of coverage (issue shyden-labs/repo-template#164). A project with
  other unmeasured files adds them to `sonar.coverage.exclusions`.
- A verdict it cannot read fails closed, naming why:
  - a missing report (the scan did not run)
  - an API error
  - a task that failed
  - no analysis
  - a task for another pull request
  - still pending after the ceiling (`SONAR_CEILING_SECONDS`, 300 by default)
- The job summary says whether the scan ran, the verdict, and the SonarCloud
  link.
- `tests/unit/workflow-honesty.test.ts` refuses, in every workflow, a swallowed
  failure (`|| true`, `|| exit 0`, `|| :`, `continue-on-error: true`), a step
  gated on the token, and a scan with no verdict step after it.

## One-time setup for a new repository

1. On [sonarcloud.io](https://sonarcloud.io), sign in with GitHub, open the
   `shyden-labs` organisation, choose **Analyze new project**, and pick the
   repository. Note the project key (usually `shyden-labs_<repo>`). If the
   repository isn't listed, follow **GitHub app configuration** on that page
   and add it to the SonarQubeCloud app's repository access.
2. In the project, open **Administration → Analysis Method** and turn
   **Automatic Analysis** off: CI runs the scan.
3. In **Administration → New Code**, set the new-code definition to
   **Previous version**, or to the branch your project diffs against.
4. Under **My Account → Security**, generate a token.
5. In the GitHub repository, open **Settings → Environments**, create
   `sonarcloud` (no reviewers; deployment branches: no restriction), and add
   the token to it as the secret `SONAR_TOKEN`. Keep no repository-level
   `SONAR_TOKEN`: secrets live in environments. Then add it under **Secrets and
   variables → Dependabot** as `SONAR_TOKEN` too: GitHub's docs say a
   Dependabot run receives Dependabot secrets only, and Dependabot pull
   requests are scanned too.
6. Call the workflow from the pull-request workflow, and make its
   `sonarcloud / sonarcloud` job a required check on `develop` and `main`.
   Keep `secrets: inherit`: GitHub resolves an environment secret the caller
   did not pass to an empty string in the called workflow.

   ```yaml
   sonarcloud:
     uses: ./.github/workflows/sonarcloud.yml
     with:
       organization: shyden-labs
       project-key: shyden-labs_<repo>
     secrets: inherit
   ```

## Confirmed by the first real scan

repo-template's PR shyden-labs/repo-template#160 (2026-10-31) confirmed what no document read on
2026-10-22 stated:

- The scan action writes `.scannerwork/report-task.txt` holding `ceTaskId`,
  `serverUrl` and `dashboardUrl`.
- A pull request's analysis task names its `pullRequest`.

Uncovered code planted on that PR failed the gate, as it should:
`new_coverage is 0.0, which fails LT 80`.

SonarCloud's documentation marks `api/qualitygates/project_status`
deprecated (since 2025-09-16). It still answered on 2026-10-31. Move to its
replacement when SonarCloud retires it.
