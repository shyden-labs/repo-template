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
      '2. Create `develop` and make it the default branch before Dependabot first runs: `.github/dependabot.yml` targets `develop`, and a repository created from a template copies only the default branch.',
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
    const rules = text.indexOf('3. **Require up-to-date pull requests on `develop` and `main`');
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
      "Name every check the template's CI runs: `build-and-test coverage mutations`. Then read both branches' rules back (`rules/branches/develop` and `rules/branches/main`) and see all three there.",
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
