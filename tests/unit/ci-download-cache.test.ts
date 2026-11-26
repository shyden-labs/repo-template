import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutPinnedShas } from './source-text.ts';
import { jobsOf } from './workflow-honesty.ts';

/**
 * CI caches every download, and still takes a newer version (Shyden 2026-11-26:
 * "do the same for any other downloads we do in CI. always make sure we still
 * check for a newer version though"; issue shyden-labs/repo-template#224).
 *
 * Node's download is kept under a key naming its exact version, so a
 * Dockerfile bump misses and downloads the new one, and npm uses setup-node's
 * own cache. Each download step has its own time limit, so a stall fails on
 * that step, whose log names what it was fetching.
 *
 * A job holding a secret or a write permission restores nothing from the
 * cache. A cache key is a name, not a lock: any job in the same cache scope
 * can write any key, and a dependency's install script in one job could plant
 * a binary that would then run beside the token in another. The Sonar scan
 * and the release-cut judge download fresh (the scan action checks its
 * scanner's signature).
 */

const WORKFLOWS = '.github/workflows';
const jobsIn = (file: string) => jobsOf(withoutPinnedShas(readFileSync(`${WORKFLOWS}/${file}`, 'utf8')));

/** A job's steps, each as its own text. */
const stepsOf = (job: string): string[] => job.split(/^(?= {6}- )/m).slice(1);

const FILES = ['check-release-cut.yml', 'ci.yml', 'deploy-dev.yml', 'sonarcloud.yml'];

/** The jobs that hold no secret and no write permission, and so cache their downloads. */
const CACHING_JOBS = [
  ['ci.yml', 'build-and-test'],
  ['ci.yml', 'coverage'],
  ['sonarcloud.yml', 'coverage-report'],
] as const;

/** The jobs that hold a secret or a write permission, and so restore nothing. */
const TRUSTED_JOBS = [
  ['check-release-cut.yml', 'judge-release-cut'],
  ['ci.yml', 'sonarcloud'],
  ['deploy-dev.yml', 'deploy-dev'],
  ['sonarcloud.yml', 'sonarcloud'],
] as const;

const NODE_CACHE = [
  '      - uses: actions/cache@<sha>',
  '        timeout-minutes: 5',
  '        with:',
  '          path: ${{ runner.tool_cache }}/node/${{ steps.node.outputs.version }}',
  '          key: node-${{ steps.node.outputs.version }}-${{ runner.os }}-${{ runner.arch }}',
].join('\n');

/** A job holds a secret, or a permission to write. */
const holdsPower = (job: string) => /secrets[.:]|environment:|^ {6}[\w-]+: write$/m.test(job);

describe('every job', () => {
  it('is either a caching job or a trusted one', () => {
    const all = FILES.flatMap((file) => Object.keys(jobsIn(file)).map((id) => `${file} ${id}`));
    expect(all.sort()).toEqual([...CACHING_JOBS, ...TRUSTED_JOBS].map(([file, id]) => `${file} ${id}`).sort());
  });

  it.each(CACHING_JOBS)('%s %s holds no secret and no write permission', (file, id) => {
    expect(holdsPower(jobsIn(file)[id] ?? '')).toBe(false);
  });

  it.each(TRUSTED_JOBS)('%s %s holds a secret or a write permission, and restores nothing from the cache', (file, id) => {
    const job = jobsIn(file)[id] ?? '';
    expect({ power: holdsPower(job), cache: job.includes('actions/cache') }).toEqual({ power: true, cache: false });
  });
});

describe('a caching job', () => {
  it.each(CACHING_JOBS)('%s %s restores Node under its exact version just before setting it up, in 5 minutes', (file, id) => {
    const steps = stepsOf(jobsIn(file)[id] ?? '');
    const setup = steps.findIndex((s) => s.includes('actions/setup-node@'));
    expect(steps[setup - 1]?.trimEnd()).toBe(NODE_CACHE);
    expect(steps[setup]).toContain('        timeout-minutes: 5\n');
  });

  it.each(CACHING_JOBS)("%s %s uses npm's cache and installs in 10 minutes", (file, id) => {
    const steps = stepsOf(jobsIn(file)[id] ?? '');
    expect({
      npmCache: steps.find((s) => s.includes('actions/setup-node@'))?.includes("          cache: 'npm'\n"),
      limit: steps.find((s) => s.includes('scripts/npm-ci.ts'))?.includes('        timeout-minutes: 10\n'),
    }).toEqual({ npmCache: true, limit: true });
  });
});

describe('a trusted job', () => {
  it.each([
    ['check-release-cut.yml', 'judge-release-cut'],
    ['sonarcloud.yml', 'sonarcloud'],
  ])('%s %s sets Node up in 5 minutes', (file, id) => {
    const steps = stepsOf(jobsIn(file)[id] ?? '');
    expect(steps.find((s) => s.includes('actions/setup-node@'))).toContain('        timeout-minutes: 5\n');
  });

  it('scans in 15 minutes', () => {
    const steps = stepsOf(jobsIn('sonarcloud.yml')['sonarcloud'] ?? '');
    expect(steps.find((s) => s.includes('SonarSource/sonarqube-scan-action@'))).toContain('        timeout-minutes: 15\n');
  });
});
