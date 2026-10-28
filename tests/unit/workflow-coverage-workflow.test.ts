import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PATIENCE } from '../../scripts/workflow-coverage-check.ts';
import { withoutPinnedShas, withoutYamlComments, withoutYamlQuotes, yamlBlock } from './source-text.ts';

/**
 * The workflow-coverage check runs on every pull request as a job named
 * `workflow-coverage`, so branch rules can require it (issue #35, AC5;
 * Shyden 2026-10-27, "a job that waits"). It reads runs and checks out code,
 * nothing more, and its time limit outlasts the wait's ceiling.
 */

const source = () => withoutPinnedShas(withoutYamlComments(readFileSync('.github/workflows/workflow-coverage.yml', 'utf8')));
const workflow = () => withoutYamlQuotes(source());

describe('workflow-coverage.yml', () => {
  it('runs on every pull request, with no branch, label or type filter', () => {
    expect(yamlBlock(workflow(), 'on')).toBe('on:\n  pull_request:');
  });

  it('can read the repository and its runs, and nothing more', () => {
    expect(yamlBlock(workflow(), 'permissions')).toBe('permissions:\n  contents: read\n  actions: read');
  });

  it('stops measuring a pull request’s older head when a newer one is pushed', () => {
    expect(yamlBlock(workflow(), 'concurrency')).toBe(
      'concurrency:\n  group: workflow-coverage-${{ github.event.pull_request.number }}\n  cancel-in-progress: true',
    );
  });

  it('runs no step on a condition but the trace upload', () => {
    expect(workflow().match(/^\s+(?:- )?if:.*$/gm)).toEqual(['      - if: ${{ !cancelled() }}']);
  });

  it('names its job workflow-coverage, so branch rules can require it', () => {
    expect(yamlBlock(workflow(), 'jobs').split('\n').slice(0, 3)).toEqual(['jobs:', '  workflow-coverage:', '    runs-on: ubuntu-26.04']);
  });

  it('gives the job five minutes beyond the wait’s ceiling', () => {
    const minutes = /^ {4}timeout-minutes: (\d+)$/m.exec(workflow())?.[1];
    expect(Number(minutes) * 60_000 - PATIENCE.ceilingMs).toBe(300_000);
  });

  it('checks out the head itself, not the merge commit, with the whole history to find the base', () => {
    expect(workflow()).toContain(
      [
        '      - uses: actions/checkout@<sha>',
        '        with:',
        '          ref: ${{ github.event.pull_request.head.sha }}',
        '          fetch-depth: 0',
      ].join('\n'),
    );
  });

  // Read with its quotes, so a shell argument that loses them reads as a change.
  it('checks out the commit the head branched from, then compares the two', () => {
    expect(source()).toContain(
      [
        '      - run: npm ci',
        '      - name: Wait for the other runs, then compare workflow lines with the base',
        '        env:',
        '          GITHUB_TOKEN: ${{ github.token }}',
        '          HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
        '          BASE: origin/${{ github.base_ref }}',
        '        run: |',
        '          base_sha=$(git merge-base "$HEAD_SHA" "$BASE")',
        '          git worktree add --detach "$RUNNER_TEMP/base" "$base_sha"',
        '          node scripts/workflow-coverage-check.ts "$HEAD_SHA" "$base_sha" "$RUNNER_TEMP/base"',
      ].join('\n'),
    );
  });
});
