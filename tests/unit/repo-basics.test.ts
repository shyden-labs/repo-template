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
    expect(readFileSync('LICENSE', 'utf8')).toContain(
      'Apache License\n                           Version 2.0, January 2004',
    );
  });

  it('names Shyden Labs as the copyright holder', () => {
    expect(readFileSync('LICENSE', 'utf8').split('\n')[0]).toBe(
      'Copyright 2026 Shyden Labs',
    );
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
});
