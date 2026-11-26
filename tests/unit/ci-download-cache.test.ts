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
 * Dockerfile bump misses and downloads the new one. npm uses setup-node's own
 * cache. The Sonar scanner CLI and the JRE and plugins SonarCloud hands it are
 * restored by prefix: the action still installs the version it pins and the
 * scanner still asks SonarCloud for its current JRE and plugins; afterwards
 * whatever the scan did not read is dropped, and the rest is saved under a key
 * naming what is left. Every download step has its own time limit, so a stall
 * fails on that step, whose log names what it was fetching.
 */

const WORKFLOWS = '.github/workflows';
const jobsIn = (file: string) => jobsOf(withoutPinnedShas(readFileSync(`${WORKFLOWS}/${file}`, 'utf8')));

/** A job's steps, each as its own text. */
const stepsOf = (job: string): string[] => job.split(/^(?= {6}- )/m).slice(1);

// [workflow, job, its Node cache's key prefix]. A job holding a token (the Sonar scan, the
// release-cut judge) keeps a cache of its own, which only it saves: a job that installs
// dependencies could otherwise plant a Node binary that then runs beside the token.
const NODE_JOBS = [
  ['check-release-cut.yml', 'judge-release-cut', 'release-cut-node-'],
  ['ci.yml', 'build-and-test', 'node-'],
  ['ci.yml', 'coverage', 'node-'],
  ['sonarcloud.yml', 'coverage-report', 'node-'],
  ['sonarcloud.yml', 'sonarcloud', 'token-job-node-'],
] as const;

const nodeCache = (prefix: string) =>
  [
    '      - uses: actions/cache@<sha>',
    '        timeout-minutes: 5',
    '        with:',
    '          path: ${{ runner.tool_cache }}/node/${{ steps.node.outputs.version }}',
    `          key: ${prefix}\${{ steps.node.outputs.version }}-\${{ runner.os }}-\${{ runner.arch }}`,
  ].join('\n');

describe('Node', () => {
  it('is set up in exactly these jobs', () => {
    const files = ['check-release-cut.yml', 'ci.yml', 'deploy-dev.yml', 'sonarcloud.yml'];
    const found = files.flatMap((file) =>
      Object.entries(jobsIn(file))
        .filter(([, job]) => job.includes('actions/setup-node@'))
        .map(([id]) => [file, id]),
    );
    expect(found).toEqual(NODE_JOBS.map(([file, id]) => [file, id]));
  });

  it.each(NODE_JOBS)(
    '%s %s restores Node under its exact version, keyed %s, just before setting it up, in 5 minutes',
    (file, id, prefix) => {
      const steps = stepsOf(jobsIn(file)[id] ?? '');
      const setup = steps.findIndex((s) => s.includes('actions/setup-node@'));
      expect(steps[setup - 1]?.trimEnd()).toBe(nodeCache(prefix));
      expect(steps[setup]).toContain('        timeout-minutes: 5\n');
    },
  );

  it.each(NODE_JOBS)("%s %s uses npm's cache whenever it installs, and installs in 10 minutes", (file, id) => {
    const steps = stepsOf(jobsIn(file)[id] ?? '');
    const install = steps.find((s) => s.includes('scripts/npm-ci.ts'));
    const setup = steps.find((s) => s.includes('actions/setup-node@')) ?? '';
    expect({
      npmCache: setup.includes("          cache: 'npm'\n"),
      limit: install === undefined || install.includes('        timeout-minutes: 10\n'),
    }).toEqual({ npmCache: install !== undefined, limit: true });
  });
});

describe('the Sonar scan', () => {
  const steps = stepsOf(jobsIn('sonarcloud.yml')['sonarcloud'] ?? '').map((s) => s.trimEnd());
  const at = (needle: string) => steps.findIndex((s) => s.includes(needle));

  const restore = (id: string, path: string, prefix: string) =>
    [
      `      - id: ${id}`,
      '        uses: actions/cache/restore@<sha>',
      '        timeout-minutes: 5',
      '        with:',
      `          path: ${path}`,
      `          key: ${prefix}restore`,
      `          restore-keys: ${prefix}`,
    ].join('\n');

  const save = (restored: string, kept: string, path: string) =>
    [
      `      - if: steps.${kept}.outputs.key != steps.${restored}.outputs.cache-matched-key`,
      '        uses: actions/cache/save@<sha>',
      '        timeout-minutes: 5',
      '        with:',
      `          path: ${path}`,
      `          key: \${{ steps.${kept}.outputs.key }}`,
    ].join('\n');

  // [name, the cache's path, its key prefix, the same two as the shell sees them: no expression in a shell line]
  const CACHES = [
    [
      'scanner',
      '${{ runner.tool_cache }}/sonar-scanner-cli',
      'sonar-scanner-cli-${{ runner.os }}-${{ runner.arch }}-',
      '"$RUNNER_TOOL_CACHE/sonar-scanner-cli"',
      '"sonar-scanner-cli-$RUNNER_OS-$RUNNER_ARCH-"',
    ],
    [
      'plugins',
      '~/.sonar/cache',
      'sonar-cache-${{ runner.os }}-${{ runner.arch }}-',
      '~/.sonar/cache',
      '"sonar-cache-$RUNNER_OS-$RUNNER_ARCH-"',
    ],
  ] as const;

  it.each(CACHES)('restores the %s cache by prefix, then marks it unread, before the scan', (name, path, prefix, shellPath) => {
    const restored = at(`      - id: sonar-${name}-restored\n`);
    expect(steps[restored]).toBe(restore(`sonar-${name}-restored`, path, prefix));
    expect(steps[restored + 1]).toBe(
      [`      - name: Mark the ${name} cache unread`, `        run: node scripts/ci-cache.ts reset ${shellPath}`].join('\n'),
    );
    expect(restored + 1).toBeLessThan(at('SonarSource/sonarqube-scan-action@'));
  });

  it.each(CACHES)(
    'after the scan keeps only what it read of the %s cache, and saves it when that changed',
    (name, path, _prefix, shellPath, shellPrefix) => {
      const kept = at(`      - id: sonar-${name}-kept\n`);
      expect(steps[kept]).toBe(
        [
          `      - id: sonar-${name}-kept`,
          `        name: Keep only what the scan read of the ${name} cache`,
          `        run: node scripts/ci-cache.ts keep ${shellPath} ${shellPrefix} >> "$GITHUB_OUTPUT"`,
        ].join('\n'),
      );
      expect(steps[kept + 1]).toBe(save(`sonar-${name}-restored`, `sonar-${name}-kept`, path));
      expect(kept).toBeGreaterThan(at('SonarSource/sonarqube-scan-action@'));
      expect(kept).toBeLessThan(at('scripts/sonar-verdict.ts'));
    },
  );

  it('scans in 15 minutes', () => {
    expect(steps[at('SonarSource/sonarqube-scan-action@')]).toContain('        timeout-minutes: 15\n');
  });
});
