import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { triggerBlocks } from '../../scripts/coverage-dispatch.ts';

/**
 * A push to a scratch branch `coverage/<branch>/<short-sha>` starts no run
 * (issue #35, part 6): the session pushes its finished commit there only to
 * start the hand-started workflows on it, before it pushes the pull request.
 * A push trigger that matched those branches would run CI twice per push.
 * Measured 2026-10-28: a push of coverage/probe/80ee4aa listed 0 runs.
 */

const WORKFLOWS = '.github/workflows';
/** A scratch branch as the docs name it. */
const SCRATCH = 'coverage/35-part6-dispatch/0123abc';

/** A GitHub branch filter as a regex: `**` any characters, `*` any but `/`. Other pattern syntax is not read. */
function filterMatches(pattern: string, branch: string): boolean {
  if (/[?+[\]!]/.test(pattern)) throw new Error(`a branch pattern this guard does not read: ${pattern}`);
  const source = pattern
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((s) => s.replace(/[.^$|(){}\\/]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${source}$`).test(branch);
}

/** The branch patterns of a `push:` block, from an inline `[a, b]` or a `- a` list. */
function branchPatterns(lines: string[]): string[] | undefined {
  const at = lines.findIndex((line) => /^\s*branches:/.test(line));
  if (at === -1) return undefined;
  const inline = (lines[at] as string).replace(/^\s*branches:/, '').trim();
  if (inline.startsWith('['))
    return inline
      .slice(1, -1)
      .split(',')
      .map((p) => p.trim().replace(/^['"]|['"]$/g, ''));
  const indent = (lines[at] as string).search(/\S/);
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.search(/\S/) <= indent) break;
    items.push(
      line
        .trim()
        .replace(/^-\s*/, '')
        .replace(/^['"]|['"]$/g, ''),
    );
  }
  return items;
}

/** Each way a workflow's triggers would start a run when a coverage branch is pushed. */
function startsOnScratch(file: string, text: string): string[] {
  const blocks = triggerBlocks(text, file);
  const found: string[] = [];
  if (blocks.has('create')) found.push(`${file}: create fires on every new branch`);
  const push = blocks.get('push');
  if (push === undefined) return found;
  if (push.some((line) => /^\s*branches-ignore:/.test(line)))
    return [...found, `${file}: push uses branches-ignore; list the branches it runs on`];
  const patterns = branchPatterns(push);
  if (patterns === undefined) return [...found, `${file}: push names no branches, so it runs on every branch`];
  return [...found, ...patterns.filter((p) => filterMatches(p, SCRATCH)).map((p) => `${file}: push branch ${p} matches ${SCRATCH}`)];
}

const workflows = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();
const pushers = workflows.filter((f) => triggerBlocks(readFileSync(`${WORKFLOWS}/${f}`, 'utf8'), f).has('push'));

describe('no push to a coverage branch starts a run', () => {
  it('judges every workflow, two of which run on push', () => {
    expect({ workflows, pushers }).toEqual({
      workflows: [
        'check-release-cut.yml',
        'ci.yml',
        'deploy-dev.yml',
        'logs.yml',
        'mutations.yml',
        'record.yml',
        'sonarcloud.yml',
        'workflow-coverage.yml',
      ],
      pushers: ['ci.yml', 'deploy-dev.yml'],
    });
  });

  it.each(workflows)('%s starts nothing when a coverage branch is pushed', (file) => {
    expect(startsOnScratch(file, readFileSync(`${WORKFLOWS}/${file}`, 'utf8'))).toEqual([]);
  });
});

describe('the guard', () => {
  const on = (block: string) => `on:\n${block}\njobs:\n`;

  it.each([
    ['a push with no branches', on('  push:'), 'w.yml: push names no branches, so it runs on every branch'],
    ['an inline on: push', 'on: push\njobs:\n', 'w.yml: push names no branches, so it runs on every branch'],
    [
      'a push filtered by paths alone',
      on('  push:\n    paths:\n      - src/**'),
      'w.yml: push names no branches, so it runs on every branch',
    ],
    ['branches-ignore', on('  push:\n    branches-ignore: [main]'), 'w.yml: push uses branches-ignore; list the branches it runs on'],
    ['branches: ** inline', on("  push:\n    branches: ['**']"), 'w.yml: push branch ** matches coverage/35-part6-dispatch/0123abc'],
    [
      'branches: coverage/** listed',
      on('  push:\n    branches:\n      - coverage/**'),
      'w.yml: push branch coverage/** matches coverage/35-part6-dispatch/0123abc',
    ],
    [
      'branches: */** listed',
      on("  push:\n    branches:\n      - '*/**'"),
      'w.yml: push branch */** matches coverage/35-part6-dispatch/0123abc',
    ],
    ['a create trigger', on('  create:\n  pull_request:'), 'w.yml: create fires on every new branch'],
  ])('names %s', (_kind, text, finding) => {
    expect(startsOnScratch('w.yml', text)).toEqual([finding]);
  });

  it.each([
    ['develop listed', on('  push:\n    branches: [develop]')],
    ['release/* listed', on('  push:\n    branches:\n      - release/*')],
    ['coverage/* listed, one level only', on('  push:\n    branches: [coverage/*]')],
    ['no push at all', on('  pull_request:')],
  ])('passes %s', (_kind, text) => {
    expect(startsOnScratch('w.yml', text)).toEqual([]);
  });

  it.each([['!coverage/**'], ['release/v?'], ['feature/[ab]']])('refuses the pattern %s it does not read', (pattern) => {
    expect(() => startsOnScratch('w.yml', on(`  push:\n    branches: ['${pattern}']`))).toThrow(
      `a branch pattern this guard does not read: ${pattern}`,
    );
  });
});
