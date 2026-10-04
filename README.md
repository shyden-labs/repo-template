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
2. Create `develop` and make it the default branch; protect `main`.
3. Add the ecosystems your repo actually uses to `.github/dependabot.yml`.
4. `npm ci && npm run test:unit` — the supply-chain suite must be green before anything else is written.
5. Enable Dependabot alerts and security updates on the new repo. Org defaults now cover new repositories, but check rather than assume.
