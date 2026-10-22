import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutPinnedShas, withoutYamlComments, withoutYamlQuotes, yamlBlock } from './source-text.ts';

/**
 * The mutations check runs on every pull request, with no label to opt in
 * (issue #21; Shyden 2026-10-16: "it must be run"), as a job named
 * `mutations` so branch rules can require it, and with a timeout.
 */

const workflow = () => withoutPinnedShas(withoutYamlQuotes(withoutYamlComments(readFileSync('.github/workflows/mutations.yml', 'utf8'))));

describe('mutations.yml', () => {
  it('runs on every pull request, with no label or type filter', () => {
    expect(yamlBlock(workflow(), 'on')).toBe('on:\n  pull_request:');
  });

  it('runs no step or job on a condition', () => {
    expect(workflow()).not.toMatch(/^\s+if:/m);
  });

  it('can only read the repository', () => {
    expect(yamlBlock(workflow(), 'permissions')).toBe('permissions:\n  contents: read');
  });

  it('names its job mutations, so branch rules can require it, and stops it within 30 minutes', () => {
    expect(yamlBlock(workflow(), 'jobs').split('\n').slice(0, 4)).toEqual([
      'jobs:',
      '  mutations:',
      '    runs-on: ubuntu-26.04',
      '    timeout-minutes: 30',
    ]);
  });

  it('checks out the whole history, so the pull request can be diffed against its base', () => {
    expect(workflow()).toContain(['      - uses: actions/checkout@<sha>', '        with:', '          fetch-depth: 0'].join('\n'));
  });

  it('judges the changed tests and runs the changed mutation files against the base branch', () => {
    expect(workflow()).toContain(
      [
        '      - run: npm ci',
        '      - name: Judge the changed tests and run the changed mutation files',
        '        env:',
        '          BASE: origin/${{ github.base_ref }}',
        '        run: node scripts/mutate.ts pr $BASE',
      ].join('\n'),
    );
  });
});
