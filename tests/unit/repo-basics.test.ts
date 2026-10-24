import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * What every repository created from this template inherits (Refs #1): an
 * open-source licence naming Shyden Labs, and the instruction to create
 * `develop` before Dependabot first runs, since its config targets `develop`
 * and a repository created from a template copies only the default branch.
 */

const readme = () => readFileSync('README.md', 'utf8');

describe('the licence', () => {
  it('is Apache-2.0', () => {
    expect(readFileSync('LICENSE', 'utf8')).toContain('Apache License\n                           Version 2.0, January 2004');
  });

  it('names Shyden Labs as the copyright holder', () => {
    expect(readFileSync('LICENSE', 'utf8').split('\n')[0]).toBe('Copyright 2026 Shyden Labs');
  });
});

describe('a new repository', () => {
  it('is told to create develop before Dependabot first runs', () => {
    expect(readme()).toContain(
      '2. Create `develop` and make it the default branch before Dependabot first runs: `.github/dependabot.yml` targets `develop`, security fixes go only to the default branch, and a repository created from a template copies only the default branch. CI fails until this is done (rule 5).',
    );
  });

  it('creates develop before it adds its own ecosystems', () => {
    const text = readme();
    const develop = text.indexOf('2. Create `develop`');
    const ecosystems = text.indexOf('4. Add the ecosystems');
    expect(develop).toBeGreaterThan(-1);
    expect(ecosystems).toBeGreaterThan(develop);
  });

  it('sets up the branch rules once develop exists, before its own ecosystems (#8)', () => {
    const text = readme();
    const develop = text.indexOf('2. Create `develop`');
    const rules = text.indexOf(
      '3. **Require up-to-date pull requests on `develop`, and a release cut on `main`, each by its own ruleset.**',
    );
    const ecosystems = text.indexOf('4. Add the ecosystems');
    expect(develop).toBeGreaterThan(-1);
    expect([rules > develop, ecosystems > rules]).toEqual([true, true]);
  });

  it('names the script that sets the branch rules up', () => {
    expect(readme()).toContain('`node scripts/branch-rules-setup.ts <owner/repo> <required check>...`');
  });

  it("names every check the template's CI runs as required, and says to read the rules back (#21)", () => {
    const text = readme();
    const step = text.slice(text.indexOf('3. **Require up-to-date pull requests'), text.indexOf('4. Add the ecosystems'));
    expect(step).toContain(
      "Name every check the template's CI runs: `build-and-test coverage mutations`. Then read both branches' rules back (`rules/branches/develop` and `rules/branches/main`): `develop` requires all three, strict; `main` requires them and `release-cut`, not strict (`docs/release-cut.md`).",
    );
  });

  // A template copies files, not settings, so the setup step carries it (#28).
  it('says the script deletes merged head branches, after develop and main forbid deletion', () => {
    const text = readme();
    const step = text.slice(text.indexOf('3. **Require up-to-date pull requests'), text.indexOf('4. Add the ecosystems'));
    expect(step).toContain('then turns on **Automatically delete head branches** (`delete_branch_on_merge`)');
  });
});

/**
 * Every API a repository builds has a fully capable Swagger interface, public
 * or private (operator ruling 2026-10-15, Refs #14). A new repository learns
 * it here, before its first route ships.
 */
describe('the API documentation standard (#14)', () => {
  const standard = () => readFileSync('docs/api-docs.md', 'utf8');

  it('quotes the ruling', () => {
    expect(standard()).toContain(
      'we must have a fully capable Swagger interface for documenation purposes. this include public and private APIs. but the swagger must be private for a private API, the public cannot be allowed to see it or interact with it, only public is public.',
    );
  });

  it.each([
    [
      'writes are tried on dev only',
      '**Try it out.** Public docs on production document every operation, but "Try it out" works there only for operations that change nothing. Operations that write are tried on the dev site\'s docs.',
    ],
    [
      'private docs sit behind a sign-in',
      "**Private docs.** A private API's spec and its Swagger page are reachable only after the operator signs in",
    ],
    [
      'the spec is written by hand and contract-tested',
      '**One contract.** A hand-written OpenAPI spec per API is the source of truth, and contract tests fail when the real API answers differently from it.',
    ],
    [
      'the library is self-hosted',
      "**Self-hosted.** Swagger UI comes from the `swagger-ui-dist` npm package (Apache-2.0, the swagger-api project), served from the project's own origin, never a CDN.",
    ],
  ])('states that %s', (_what, sentence) => {
    expect(standard()).toContain(sentence);
  });

  it('is named in the file table', () => {
    expect(readme()).toContain('| `docs/api-docs.md` |');
  });

  it('is a setup step, after the project board and the dev deploy', () => {
    const text = readme();
    const board = text.indexOf('7. Set up the project board');
    const deploy = text.indexOf('8. **Fill in `.github/workflows/deploy-dev.yml`.**');
    const api = text.indexOf('9. **Every API gets a Swagger interface.**');
    expect(board).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(board);
    expect(api).toBeGreaterThan(deploy);
  });
});

/**
 * Every project's diagnostic logs go to one store, run the same way
 * everywhere (operator ruling 2026-10-16, Refs #18). The module (#19), the
 * viewer (#22) and the collector (#23) build what this design fixes, so each
 * rule they build against is pinned here, with Shyden's choices in his words.
 */
describe('the diagnostic logging design (#18)', () => {
  const design = () => readFileSync('docs/logging.md', 'utf8');

  it.each([
    [
      'the privacy ruling',
      "we must make sure there's no private information logged that can be leaked. and nothing that is personally identifiable",
    ],
    ['the store choice', 'Shyden chose by AskUserQuestion *"Build our own on R2 (Recommended)"*'],
    ['the collector placement', 'Shyden chose by AskUserQuestion *"Same account (Recommended)"*'],
    ['the one account', 'he answered *"All in one account"*'],
    ['the error-burst rule', 'Shyden chose by AskUserQuestion *"Fold repeats (Recommended)"*'],
  ])('records %s in his words', (_what, words) => {
    expect(design()).toContain(words);
  });

  const header =
    '| Criterion | Our own on Cloudflare R2 (chosen) | Axiom Personal | Grafana Cloud Free | New Relic Free | VictoriaLogs, self-hosted |';

  /** The comparison table's rows, from its header to the first line that is not a row. */
  const comparison = () => {
    const lines = design().split('\n');
    const start = lines.indexOf(header);
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((line, i) => i > start && !line.startsWith('|'));
    expect(end).toBeGreaterThan(start);
    return lines.slice(start + 2, end);
  };

  it('compares at least four stores, on every criterion the story names', () => {
    expect(design()).toContain(header);
  });

  it.each([
    'Licence',
    'Cost now',
    'Cost at 10x volume',
    'Retention and deletion',
    'Keeping projects apart',
    'How each sender ships',
    'arm64',
    'Resources needed',
    'Backup',
    'Upkeep',
  ])('has a %s row in the comparison, filled for all five stores', (criterion) => {
    const rows = comparison().filter((line) => line.startsWith(`| ${criterion} |`));
    expect(rows).toHaveLength(1);
    // Exactly one row, asserted above, so joining the rows gives that row.
    const cells = rows.join('').split(' | ').slice(1);
    expect(cells.map((cell) => cell.replace(/\s*\|$/, '').trim().length > 0)).toEqual([true, true, true, true, true]);
  });

  it.each([
    [
      'one line format',
      'Every line is one JSON object on one line, with these five fields first, in this order: `ts`, `lvl`, `app`, `env`, `code`.',
    ],
    [
      'the closed set of field types',
      'Every other field has one of seven types, and only these: a code from a closed list, a count, a duration in milliseconds, a boolean, a status number, a content id, or a commit.',
    ],
    [
      'refusal at write time',
      'Free text, error messages, and request or response bodies are refused when the line is written, never redacted afterwards.',
    ],
    ['an error by name and code', "An `error` line carries the error's name and a code, never its message."],
    [
      'personal data refused by default',
      'A project may log a personal field only by declaring it with a pointer to the privacy-policy section that says why it is needed, what is done with it and when, and how long it is kept.',
    ],
    [
      'device apps keep their own logs',
      "An app on a user's device keeps its log on the device, where the user can read and copy it through the same allow-list check, and sends nothing.",
    ],
    [
      'one bucket per environment',
      'There is one bucket per environment, `shyden-logs-prod` and `shyden-logs-dev`, each created with the `apac` location hint.',
    ],
    ['the best-effort hint', '"Location Hints are a best effort and not a guarantee"'],
    [
      'the object key layout',
      'Each flushed batch is one gzipped NDJSON object at `<project>/<app>/<YYYY-MM-DD>/<HH>/<HHmmssSSS>-<8 hex>.ndjson.gz`, all in UTC.',
    ],
    ['writes only by the collector', 'Only the collector writes, through its R2 binding; no app has a binding to a log bucket.'],
    [
      'reads only by the viewer, behind a sign-in',
      'Only the viewer reads, through a read-only binding, behind Cloudflare Access with one allowed identity: Shyden.',
    ],
    ['the shared request allowance', '"Accounts on the Workers Free plan have a daily request limit of 100,000 requests"'],
    ['the Service Binding cost', '"do not incur additional request fees"'],
    ['a row per batch', 'Each batch the collector receives is one Durable Object row, never one row per line.'],
    [
      'a ratio measured per batch',
      'A batch is compressed on its own, so the budget uses the ratio measured at its size, not one over a whole day.',
    ],
    [
      'the drop order',
      'Over budget, the collector drops `debug` lines first, then routine summaries, never an error or a warning, and counts every drop in the next summary.',
    ],
  ])('fixes %s', (_what, sentence) => {
    expect(design()).toContain(sentence);
  });

  it('is named in the file table', () => {
    expect(readme()).toContain('| `docs/logging.md` |');
  });

  it('is a setup step, after the static checks', () => {
    const text = readme();
    const checks = text.indexOf('14. **Keep the static checks clean.**');
    const logs = text.indexOf('15. **Every app logs, after its release.**');
    expect(checks).toBeGreaterThan(-1);
    expect(logs).toBeGreaterThan(checks);
  });
});
