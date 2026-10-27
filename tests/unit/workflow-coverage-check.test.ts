import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PATIENCE, main, waitForRuns, type Clock } from '../../scripts/workflow-coverage-check.ts';

/**
 * The live workflow-coverage check (issue #35, AC5; Shyden 2026-10-27, "a job
 * that waits"): on a pull request it waits for every other run on the head and
 * on its develop merge base to complete, then fails when any workflow file
 * leaves more lines unrun on the head than on the base.
 */

/** A clock that only moves when the code under test waits. */
function fakeClock(): Clock & { waits: number[] } {
  let now = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    sleep: (ms) => {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('waitForRuns', () => {
  const patience = { ceilingMs: 100_000, intervalMs: 30_000 };

  it('returns at once, waiting not at all, when nothing is going', async () => {
    const clock = fakeClock();
    const log: string[] = [];
    await waitForRuns(
      () => Promise.resolve([]),
      clock,
      patience,
      (line) => log.push(line),
    );
    expect({ waits: clock.waits, log }).toEqual({ waits: [], log: [] });
  });

  it('waits one interval at a time, naming what it waits for, until nothing is going', async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const answers = [['ci.yml run 1 in_progress', 'mutations.yml run 2 queued'], ['ci.yml run 1 in_progress'], []];
    await waitForRuns(
      () => Promise.resolve(answers.shift() ?? ['asked once too often']),
      clock,
      patience,
      (line) => log.push(line),
    );
    expect({ waits: clock.waits, log, left: answers.length }).toEqual({
      waits: [30_000, 30_000],
      log: [
        'workflow-coverage-check: waiting 30 s on 2 run(s): ci.yml run 1 in_progress; mutations.yml run 2 queued',
        'workflow-coverage-check: waiting 30 s on 1 run(s): ci.yml run 1 in_progress',
      ],
      left: 0,
    });
  });

  it('fails at the ceiling, naming each run still going', async () => {
    const clock = fakeClock();
    await expect(
      waitForRuns(
        () => Promise.resolve(['ci.yml run 1 in_progress']),
        clock,
        patience,
        () => undefined,
      ),
    ).rejects.toThrow('workflow-coverage-check: still going after 120 s, past the 100 s ceiling: ci.yml run 1 in_progress');
    expect(clock.waits).toEqual([30_000, 30_000, 30_000, 30_000]);
  });

  it('waits forty minutes at most, polling every fifteen seconds', () => {
    expect(PATIENCE).toEqual({ ceilingMs: 2_400_000, intervalMs: 15_000 });
  });
});

/** A repository root holding these workflow files. */
function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'workflow-coverage-check-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, '.github/workflows', name), text);
  return root;
}

describe('main', () => {
  const HEAD = 'a'.repeat(40);
  const BASE = 'b'.repeat(40);
  const ONE_STEP = 'on: [push]\njobs:\n  a:\n    steps:\n      - run: echo a\n';
  const TWO_STEPS = `${ONE_STEP}      - run: echo b\n`;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** The env the check reads, with no run on either commit. */
  function setUp(head: Record<string, string>, base: Record<string, string>) {
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.stubEnv('GITHUB_RUN_ID', '7');
    vi.spyOn(process, 'cwd').mockReturnValue(rootWith(head));
    const printed: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => printed.push(String(text)) > 0);
    vi.spyOn(process.stderr, 'write').mockImplementation((text) => printed.push(`stderr: ${String(text)}`) > 0);
    const asked: string[] = [];
    const stand = ((url: string) => {
      asked.push(url);
      return Promise.resolve(Response.json({ total_count: 0, workflow_runs: [] }));
    }) as unknown as typeof fetch;
    return { baseRoot: rootWith(base), printed, asked, stand };
  }

  it.each([[[]], [['a', 'b']], [['a', 'b', 'c', 'd']]])('refuses %j: it takes the head, the base and the base checkout', async (args) => {
    await expect(main(args)).rejects.toThrow('usage: node scripts/workflow-coverage-check.ts <head-sha> <base-sha> <base-root>');
  });

  it.each([
    ['head', ['abc1234', BASE, 'base']],
    ['base', [HEAD, 'abc1234', 'base']],
  ])('refuses a short %s sha', async (_side, args) => {
    await expect(main(args)).rejects.toThrow('workflow-coverage-check: abc1234 is not a full commit sha');
  });

  it.each([
    ['GITHUB_REPOSITORY', '', 'GITHUB_REPOSITORY is empty: name the repository as owner/name'],
    ['GITHUB_TOKEN', '', 'GITHUB_TOKEN is empty: the runs and artifacts are read with it'],
    ['GITHUB_RUN_ID', '', 'GITHUB_RUN_ID is not a run id: the check skips its own run with it'],
    ['GITHUB_RUN_ID', '7x', 'GITHUB_RUN_ID is not a run id: the check skips its own run with it'],
  ])('refuses %s set to %j', async (name, value, message) => {
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.stubEnv('GITHUB_RUN_ID', '7');
    vi.stubEnv(name, value);
    await expect(main([HEAD, BASE, 'base'])).rejects.toThrow(`workflow-coverage-check: ${message}`);
  });

  it('passes when no file leaves more lines unrun than on the base, after asking both commits for runs', async () => {
    const { baseRoot, printed, asked, stand } = setUp({ 'ci.yml': ONE_STEP }, { 'ci.yml': ONE_STEP });
    expect(await main([HEAD, BASE, baseRoot], stand, fakeClock())).toBe(0);
    const runs = (sha: string) => `https://api.github.com/repos/o/r/actions/runs?head_sha=${sha}&per_page=100`;
    expect(asked).toEqual([runs(HEAD), runs(BASE), runs(HEAD), runs(BASE)]);
    expect(printed).toEqual([
      'workflow-coverage-check: .github/workflows/ci.yml: 5 lines unrun on the head, 5 on the base\n',
      `workflow-coverage-check: no workflow file leaves more lines unrun than on the base ${BASE}\n`,
    ]);
  });

  it('fails naming each file that leaves more lines unrun than on the base, with the head’s unrun lines', async () => {
    const { baseRoot, printed, stand } = setUp({ 'ci.yml': TWO_STEPS, 'new.yml': ONE_STEP }, { 'ci.yml': ONE_STEP });
    expect(await main([HEAD, BASE, baseRoot], stand, fakeClock())).toBe(1);
    expect(printed).toEqual([
      'workflow-coverage-check: .github/workflows/ci.yml: 6 lines unrun on the head, 5 on the base\n',
      'workflow-coverage-check: .github/workflows/new.yml: 5 lines unrun on the head, 0 on the base\n',
      'stderr: workflow-coverage-check: .github/workflows/ci.yml leaves 6 lines unrun, 5 on the base: lines 1, 2, 3, 4, 5, 6\n',
      'stderr: workflow-coverage-check: .github/workflows/new.yml leaves 5 lines unrun, 0 on the base: lines 1, 2, 3, 4, 5\n',
    ]);
  });
});
