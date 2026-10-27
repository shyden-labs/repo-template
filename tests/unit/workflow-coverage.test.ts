import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
  fetchEvidence,
  githubApi,
  main,
  runsGoing,
  unrunRise,
  workflowCoverage,
  workflowFiles,
  workflowLcov,
  type ApiJob,
  type Evidence,
  type RunEvidence,
} from '../../scripts/workflow-coverage.ts';
import { loadBash, type Bash } from '../../scripts/workflow-lines.ts';

/**
 * One commit's runs become lcov for every workflow file (issue #35, AC2 and
 * AC6). Shyden 2026-10-22: a line is code unless blank or a comment; the top
 * settings ran when any job ran; a job's lines when the job ran; a step's
 * when it concluded success or failure (cancelled is unrun); shell lines when
 * the step's trace shows them; a shape the reader cannot line up fails.
 */

let bash: Bash;
beforeAll(async () => {
  bash = await loadBash();
});

const wf = (...lines: string[]) => `${lines.join('\n')}\n`;
const PATH = '.github/workflows/t.yml';
const WORKFLOW = wf(
  'name: t', // 1
  'on: [push]', // 2
  'jobs:', // 3
  '  a:', // 4
  '    runs-on: x', // 5
  '    steps:', // 6
  '      - uses: actions/checkout@abc', // 7
  '      - run: echo one', // 8
  '      - name: Branch', // 9
  '        run: |', // 10
  '          if [ -n "$X" ]; then', // 11
  '            echo yes', // 12
  '          else', // 13
  '            echo no', // 14
  '          fi', // 15
  '      - name: Later', // 16
  '        if: failure()', // 17
  '        run: echo later', // 18
  '  b:', // 19
  '    runs-on: x', // 20
  '    steps:', // 21
  '      - run: echo b', // 22
);
const BRANCH = 'if [ -n "$X" ]; then\n  echo yes\nelse\n  echo no\nfi\n';

/** A trace as the runner's shell writes it: the script's sha256sum line, its line count, the lines bash ran. */
const trace = (text: string, lineCount: number, lines: number[]) =>
  `${createHash('sha256').update(text).digest('hex')}  /home/runner/work/_temp/x.sh\n${lineCount}\n${lines.map((n) => `${n}\n`).join('')}`;

type Step = [name: string, conclusion: string, status?: string];

/** A completed job as the jobs API lists it: Set up job, the given steps, the posts (numbered after a gap), Complete job. */
function job(name: string, steps: Step[], posts: string[] = []): ApiJob {
  const all: Step[] = [['Set up job', 'success'], ...steps, ...posts.map((p): Step => [p, 'success']), ['Complete job', 'success']];
  return {
    name,
    status: 'completed',
    conclusion: 'success',
    steps: all.map(([stepName, conclusion, status = 'completed'], i) => ({
      number: i <= steps.length ? i + 1 : i + 8,
      name: stepName,
      status,
      conclusion,
    })),
  };
}

const SKIPPED_B: ApiJob = { name: 'b', status: 'completed', conclusion: 'skipped', steps: [] };
const CHECKOUT: Step = ['Run actions/checkout@abc', 'success'];
const ONE: Step = ['Run echo one', 'success'];
const A_STEPS: Step[] = [CHECKOUT, ONE, ['Branch', 'success'], ['Later', 'skipped']];
const withBranch = (conclusion: string): Step[] => [CHECKOUT, ONE, ['Branch', conclusion], ['Later', 'skipped']];

function run(jobs: ApiJob[], traces: Record<string, string>, extra: Partial<RunEvidence> = {}): RunEvidence {
  return { id: 7, path: PATH, status: 'completed', jobs, traces: new Map(Object.entries(traces)), ...extra };
}

const ONE_TRACE = trace('echo one', 1, [1]);
const THEN_TRACES = { 'a/__run': ONE_TRACE, 'a/__run_2': trace(BRANCH, 5, [1, 2]) };
const evidence = (...runs: RunEvidence[]): Evidence => ({ workflows: new Map([[PATH, WORKFLOW]]), runs });
/** The one workflow file's lines; every call checks it was judged at all. */
function coverage(...runs: RunEvidence[]): Map<number, boolean> {
  const map = workflowCoverage(bash, evidence(...runs)).get(PATH);
  expect(map).toBeInstanceOf(Map);
  return map as Map<number, boolean>;
}
const at = (map: Map<number, boolean> | undefined, lines: number[]) => lines.map((line) => (map as Map<number, boolean>).get(line));
const ranOf = (map: Map<number, boolean>) => [...map.entries()].filter(([, hit]) => hit).map(([line]) => line);

describe('workflowCoverage', () => {
  it('counts a line as run only when its workflow, job, step or traced shell line ran', () => {
    const map = coverage(run([job('a', A_STEPS, ['Post Run actions/checkout@abc']), SKIPPED_B], THEN_TRACES));
    // The known positive for ranOf, which the all-unrun tests below lean on.
    expect(ranOf(map)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect([...map]).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, true],
      [6, true],
      [7, true],
      [8, true],
      [9, true],
      [10, true],
      [11, true],
      [12, true],
      [14, false],
      [16, false],
      [17, false],
      [18, false],
      [19, false],
      [20, false],
      [21, false],
      [22, false],
    ]);
  });

  it('reads the shell lines of a step that ran with no trace as unrun, and its YAML lines as run (AC6)', () => {
    expect(at(coverage(run([job('a', A_STEPS), SKIPPED_B], { 'a/__run': ONE_TRACE })), [9, 10, 11, 12])).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('reads a plain run line as unrun when its step ran but its trace shows nothing', () => {
    expect(coverage(run([job('a', A_STEPS), SKIPPED_B], { 'a/__run': trace('echo one', 1, []) })).get(8)).toBe(false);
  });

  it('reads a run line as unrun when the step was skipped, whatever ran in other steps', () => {
    expect(at(coverage(run([job('a', A_STEPS), SKIPPED_B], THEN_TRACES)), [16, 17, 18])).toEqual([false, false, false]);
  });

  it('reads every line as unrun when every job was skipped, the top settings too', () => {
    expect(ranOf(coverage(run([{ ...SKIPPED_B, name: 'a' }, SKIPPED_B], {})))).toEqual([]);
  });

  it('reads every line as unrun when no run took the workflow', () => {
    const map = coverage();
    expect(map.size).toBe(20);
    expect(ranOf(map)).toEqual([]);
  });

  it('reads a failed step as run', () => {
    expect(at(coverage(run([job('a', withBranch('failure')), SKIPPED_B], THEN_TRACES)), [9, 11, 12])).toEqual([true, true, true]);
  });

  it('reads a cancelled step as unrun and ignores the trace it left', () => {
    expect(at(coverage(run([job('a', withBranch('cancelled')), SKIPPED_B], THEN_TRACES)), [9, 10, 11, 12])).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('joins every run on the commit: a line ran if any of them took it', () => {
    const elseTraces = { 'a/__run_2': trace(BRANCH, 5, [1, 4]) };
    const map = coverage(
      run([job('a', A_STEPS), SKIPPED_B], THEN_TRACES),
      run([job('a', A_STEPS), job('b', [['Run echo b', 'success']])], elseTraces, { id: 8 }),
    );
    expect(at(map, [8, 12, 14, 19, 22])).toEqual([true, true, true, true, false]);
  });

  it('joins the steps of every run: a step that ran in one run and was skipped in a later one ran', () => {
    const later = run([job('a', withBranch('skipped')), SKIPPED_B], { 'a/__run': ONE_TRACE }, { id: 8 });
    expect(at(coverage(run([job('a', A_STEPS), SKIPPED_B], THEN_TRACES), later), [9, 10, 11, 12])).toEqual([true, true, true, true]);
  });

  it('joins the attempts of one run: a step skipped in one attempt and run in another ran', () => {
    expect(at(coverage(run([job('a', withBranch('skipped')), job('a', A_STEPS), SKIPPED_B], THEN_TRACES)), [9, 11, 12])).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('accepts a trace of a script an expression changed when its line count is the same', () => {
    const text = 'echo ${{ github.sha }}';
    const map = workflowCoverage(bash, {
      workflows: new Map([[PATH, wf('jobs:', '  a:', '    steps:', `      - run: ${text}`)]]),
      runs: [run([job('a', [[`Run ${text}`, 'success']])], { 'a/__run': trace('echo 0123abc', 1, [1]) })],
    }).get(PATH);
    expect((map as Map<number, boolean>).get(4)).toBe(true);
  });

  it('ignores a Dependabot run, which no workflow file holds', () => {
    expect(ranOf(coverage(run([job('a', A_STEPS)], THEN_TRACES, { path: 'dynamic/dependabot/dependabot-updates' })))).toEqual([]);
  });

  it.each<[string, () => Evidence, string]>([
    [
      'a run still going',
      () => evidence(run([], {}, { status: 'in_progress' })),
      'run 7 of .github/workflows/t.yml is in_progress, not completed',
    ],
    [
      'a job still going',
      () => evidence(run([{ ...job('a', A_STEPS), status: 'in_progress' }], {})),
      'run 7: job a is in_progress, not completed',
    ],
    [
      'a step still going',
      () => evidence(run([job('a', [CHECKOUT, ONE, ['Branch', 'success'], ['Later', 'success', 'queued']])], {})),
      'run 7: job a step Later is queued, not completed',
    ],
    [
      'a step conclusion it does not model',
      () => evidence(run([job('a', [CHECKOUT, ONE, ['Branch', 'success'], ['Later', 'neutral']])], {})),
      'run 7: job a step Later concluded neutral; the reader models success, failure, skipped and cancelled',
    ],
    [
      'a step with no conclusion',
      () =>
        evidence(
          run(
            [{ ...job('a', A_STEPS), steps: job('a', A_STEPS).steps.map((s) => (s.name === 'Later' ? { ...s, conclusion: null } : s)) }],
            {},
          ),
        ),
      'run 7: job a step Later concluded null; the reader models success, failure, skipped and cancelled',
    ],
    [
      'a run of a workflow file the commit does not hold',
      () => evidence(run([], {}, { path: '.github/workflows/gone.yml' })),
      'run 7 is of .github/workflows/gone.yml, which this commit has no file for',
    ],
    [
      'a job the file does not hold',
      () => evidence(run([job('c', [])], {})),
      'run 7: the API reports job c, which .github/workflows/t.yml does not define',
    ],
    [
      'a step name that differs from the file',
      () => evidence(run([job('a', [CHECKOUT, ['Run echo 1', 'success'], ['Branch', 'success'], ['Later', 'skipped']])], {})),
      'run 7: job a step 3 is "Run echo 1" in the API and "Run echo one" in the file; the reader cannot line them up (name the step, or teach the reader this shape)',
    ],
    [
      'a pre step',
      () => evidence(run([job('a', [['Pre Run x/y@v1', 'success'], ...A_STEPS])], {})),
      'run 7: job a step 2 is "Pre Run x/y@v1" in the API and "Run actions/checkout@abc" in the file; the reader cannot line them up (name the step, or teach the reader this shape)',
    ],
    [
      'a step after the file’s steps that is not a post step',
      () => evidence(run([job('a', [...A_STEPS, ['Initialize containers', 'success']])], {})),
      'run 7: job a step 6 is "Initialize containers", after the file’s 4 steps; only Post steps and Complete job may follow',
    ],
    [
      'a step list that does not start with Set up job',
      () => evidence(run([{ ...job('a', A_STEPS), steps: job('a', A_STEPS).steps.slice(1) }], {})),
      'run 7: job a starts with "Run actions/checkout@abc", not "Set up job"',
    ],
    [
      'a step list that does not end with Complete job',
      () => evidence(run([{ ...job('a', A_STEPS), steps: job('a', A_STEPS).steps.slice(0, -1) }], {})),
      'run 7: job a ends with "Later", not "Complete job"',
    ],
    [
      'a step list shorter than the file’s',
      () => evidence(run([job('a', A_STEPS.slice(0, 2))], {})),
      'run 7: job a lists 2 steps between Set up job and Complete job; the file has 4',
    ],
    [
      'a trace of a skipped step',
      () => evidence(run([job('a', A_STEPS)], { ...THEN_TRACES, 'a/__run_3': trace('echo later', 1, [1]) })),
      'run 7: trace a/__run_3 is of step Later, which did not run',
    ],
    [
      'a trace of a job the file does not hold',
      () => evidence(run([job('a', A_STEPS)], { 'c/__run': trace('x', 1, []) })),
      'run 7: trace c/__run is of job c, which .github/workflows/t.yml does not define',
    ],
    [
      'a trace of no run step',
      () => evidence(run([job('a', A_STEPS)], { 'a/__run_9': trace('x', 1, []) })),
      'run 7: trace a/__run_9 names no run step of job a',
    ],
    [
      'a trace key with no job folder',
      () => evidence(run([job('a', A_STEPS)], { __run: trace('x', 1, []) })),
      'run 7: trace __run is not <job>/<step>',
    ],
    [
      'a trace key with a nested folder',
      () => evidence(run([job('a', A_STEPS)], { 'a/b/__run': trace('x', 1, []) })),
      'run 7: trace a/b/__run is not <job>/<step>',
    ],
    [
      'a trace of another script',
      () => evidence(run([job('a', A_STEPS)], { 'a/__run': trace('echo two', 1, [1]) })),
      'run 7: trace a/__run is of another script than step 2 of job a in .github/workflows/t.yml',
    ],
    [
      'an expression that changed the line count',
      () => ({
        workflows: new Map([[PATH, wf('jobs:', '  a:', '    steps:', '      - run: echo ${{ x }}')]]),
        runs: [run([job('a', [['Run echo ${{ x }}', 'success']])], { 'a/__run': trace('echo a\necho b', 2, [1, 2]) })],
      }),
      'run 7: trace a/__run is of another script than step 1 of job a in .github/workflows/t.yml',
    ],
  ])('fails closed on %s', (_kind, make, message) => {
    expect(() => workflowCoverage(bash, make())).toThrow(`workflow-coverage: ${message}`);
  });
});

describe('workflowLcov', () => {
  it('writes one lcov record per workflow file, in path order', () => {
    const coverageOf = new Map([
      ['.github/workflows/z.yml', new Map([[1, false]])],
      [
        '.github/workflows/a.yml',
        new Map([
          [1, true],
          [3, false],
        ]),
      ],
    ]);
    expect(workflowLcov(coverageOf)).toBe(
      'TN:\nSF:.github/workflows/a.yml\nDA:1,1\nDA:3,0\nLF:2\nLH:1\nend_of_record\nTN:\nSF:.github/workflows/z.yml\nDA:1,0\nLF:1\nLH:0\nend_of_record\n',
    );
  });
});

describe('runsGoing', () => {
  const SHA = 'c'.repeat(40);
  const RUNS = `/repos/o/r/actions/runs?head_sha=${SHA}&per_page=100`;
  /** A stand-in API answering every call with `page`, and recording each as `json <path>` or `bytes <path>`: each test pins it to the one runs list. */
  const stand = (page: unknown) => {
    const asked: string[] = [];
    const answer = (kind: string) => (path: string) => {
      asked.push(`${kind} ${path}`);
      return Promise.resolve(page as Uint8Array);
    };
    return { asked, api: { json: answer('json'), bytes: answer('bytes') } };
  };
  const run = (id: number, path: string, status: string) => ({ id, path: `.github/workflows/${path}`, status });

  it('names each run on the commit that has not completed, by file, id and status', async () => {
    const runs = [
      run(1, 'ci.yml', 'completed'),
      run(2, 'mutations.yml', 'in_progress'),
      run(3, 'deploy-dev.yml', 'queued'),
      run(4, 'logs.yml', 'waiting'),
      { id: 5, path: 'dynamic/dependabot/dependabot-updates', status: 'in_progress' },
    ];
    const { asked, api } = stand({ total_count: 5, workflow_runs: runs });
    expect(await runsGoing(api, 'o/r', SHA, 9)).toEqual([
      '.github/workflows/mutations.yml run 2 in_progress',
      '.github/workflows/deploy-dev.yml run 3 queued',
      '.github/workflows/logs.yml run 4 waiting',
    ]);
    expect(asked).toEqual([`json ${RUNS}`]);
  });

  it('leaves out the run it is told to skip', async () => {
    const { asked, api } = stand({ total_count: 1, workflow_runs: [run(9, 'workflow-coverage.yml', 'in_progress')] });
    expect(await runsGoing(api, 'o/r', SHA, 9)).toEqual([]);
    expect(asked).toEqual([`json ${RUNS}`]);
  });

  it('refuses a list longer than the page it read', async () => {
    const { asked, api } = stand({ total_count: 2, workflow_runs: [run(1, 'ci.yml', 'completed')] });
    await expect(runsGoing(api, 'o/r', SHA, 9)).rejects.toThrow(
      `workflow-coverage: ${RUNS} lists 2 workflow_runs; one page of 100 was read`,
    );
    expect(asked).toEqual([`json ${RUNS}`]);
  });
});

describe('unrunRise', () => {
  /** A file's coverage from its lines: `true` ran, `false` unrun, numbered from 1. */
  const of = (...ran: boolean[]) => new Map(ran.map((r, i) => [i + 1, r]));
  const A = '.github/workflows/a.yml';
  const Z = '.github/workflows/z.yml';

  it('names nothing when every file leaves as many lines unrun as its base', () => {
    expect(unrunRise(new Map([[A, of(true, false)]]), new Map([[A, of(false, true, true)]]))).toEqual([]);
  });

  it('names nothing when a file leaves fewer lines unrun than its base', () => {
    expect(unrunRise(new Map([[A, of(true, true)]]), new Map([[A, of(false, false)]]))).toEqual([]);
  });

  it('names each file leaving more lines unrun than its base, in path order, with the head’s unrun lines', () => {
    const head = new Map([
      [Z, of(false, true, false)],
      [A, of(false, false)],
    ]);
    const base = new Map([
      [A, of(false, true)],
      [Z, of(true, false, true, true)],
    ]);
    expect(unrunRise(head, base)).toEqual([
      { file: A, head: 2, base: 1, unrun: [1, 2] },
      { file: Z, head: 2, base: 1, unrun: [1, 3] },
    ]);
  });

  it('counts a file the base lacks from no unrun line', () => {
    expect(unrunRise(new Map([[A, of(true, false)]]), new Map())).toEqual([{ file: A, head: 1, base: 0, unrun: [2] }]);
  });

  it('names nothing for a file the head lacks', () => {
    expect(unrunRise(new Map(), new Map([[A, of(false)]]))).toEqual([]);
  });
});

describe('the real runs on dc5302f', () => {
  // ci.yml and deploy-dev.yml as they were at dc5302f, and its two runs (39693590851, 39693590892), cut to the fields read.
  const dir = new URL('fixtures/workflow-coverage/dc5302f/', import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, dir), 'utf8');
  type Fixture = Omit<RunEvidence, 'traces'> & { traces: Record<string, string> };
  let map: Map<string, Map<number, boolean>>;
  beforeAll(() => {
    const runs = (JSON.parse(read('runs.json')) as Fixture[]).map((r) => ({ ...r, traces: new Map(Object.entries(r.traces)) }));
    map = workflowCoverage(bash, {
      workflows: new Map([
        ['.github/workflows/ci.yml', read('workflows/ci.yml')],
        ['.github/workflows/deploy-dev.yml', read('workflows/deploy-dev.yml')],
      ]),
      runs,
    });
  });

  it('reads the deploy step’s branch that did not run as unrun, and every line around it as run', () => {
    // 46 the if, 47 git diff, 49 git ls-files (the else: the push had an earlier commit), 52-55 the summary, 59-60 the placeholder deploy.
    expect(at(map.get('.github/workflows/deploy-dev.yml'), [46, 47, 49, 52, 53, 54, 55, 59, 60])).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('reads every line of ci.yml as run on that green push', () => {
    const ci = map.get('.github/workflows/ci.yml') as Map<number, boolean>;
    expect(ci.size).toBe(50);
    expect([...ci].filter(([, hit]) => !hit)).toEqual([]);
  });

  it('counts what it read: the totals counted by hand from the two files', () => {
    // ci.yml: 50 lines that are not blank or comments, all run. deploy-dev.yml: 14 top, 4 job, 16 step
    // and 9 shell lines (46, 47, 49, 52-55, 59, 60); of those only 49, the else branch, did not run.
    expect([...map].map(([file, lines]) => `${file} ${[...lines.values()].filter(Boolean).length}/${lines.size}`)).toEqual([
      '.github/workflows/ci.yml 50/50',
      '.github/workflows/deploy-dev.yml 42/43',
    ]);
  });
});

describe('fetchEvidence', () => {
  const REPO = 'o/r';
  const SHA = 'a'.repeat(40);
  const ZIP = new Uint8Array(readFileSync(new URL('fixtures/workflow-coverage/deploy-dev-traces.zip', import.meta.url)));
  const STEP = { number: 1, name: 'Set up job', status: 'completed', conclusion: 'success' };
  const JOB = { name: 'deploy-dev', status: 'completed', conclusion: 'failure', steps: [STEP], html_url: 'ignored' };

  /** A stand-in API answering each path from `answers`, and recording what was asked. */
  function api(answers: Record<string, unknown>, zips: Record<string, Uint8Array> = { '/repos/o/r/actions/artifacts/5/zip': ZIP }) {
    const asked: string[] = [];
    const answer = (path: string) => {
      asked.push(path);
      // An unplanned path answers undefined, which the reader refuses with a message no test expects.
      return path in zips ? zips[path] : answers[path];
    };
    return {
      asked,
      api: { json: (path: string) => Promise.resolve(answer(path)), bytes: (path: string) => Promise.resolve(answer(path) as Uint8Array) },
    };
  }

  const RUNS = `/repos/o/r/actions/runs?head_sha=${SHA}&per_page=100`;
  const JOBS = '/repos/o/r/actions/runs/9/jobs?filter=all&per_page=100';
  const ARTIFACTS = '/repos/o/r/actions/runs/9/artifacts?per_page=100';
  const runsPage = (...runs: unknown[]) => ({ total_count: runs.length, workflow_runs: runs });
  const RUN = { id: 9, path: '.github/workflows/deploy-dev.yml', status: 'completed' };
  const TRACE_ARTIFACT = { id: 5, name: 'workflow-trace-deploy-dev', expired: false };
  const answers = (artifacts: unknown[] = [TRACE_ARTIFACT, { id: 6, name: 'coverage-report', expired: true }]) => ({
    [RUNS]: runsPage(RUN, { id: 10, path: 'dynamic/dependabot/dependabot-updates', status: 'completed' }),
    [JOBS]: { total_count: 1, jobs: [JOB] },
    [ARTIFACTS]: { total_count: artifacts.length, artifacts },
  });

  it('reads the runs on the commit, every attempt’s jobs, and the traces in each trace artifact', async () => {
    const { asked, api: stand } = api(answers());
    const workflows = new Map([['.github/workflows/deploy-dev.yml', 'x']]);
    const evidence = await fetchEvidence(stand, REPO, SHA, workflows);
    expect(asked).toEqual([RUNS, JOBS, ARTIFACTS, '/repos/o/r/actions/artifacts/5/zip']);
    expect(evidence.workflows).toBe(workflows);
    expect(evidence.runs.map((r) => ({ ...r, traces: [...r.traces.keys()] }))).toEqual([
      {
        id: 9,
        path: '.github/workflows/deploy-dev.yml',
        status: 'completed',
        jobs: [{ name: 'deploy-dev', status: 'completed', conclusion: 'failure', steps: [STEP] }],
        traces: ['deploy-dev/__run', 'deploy-dev/__run_2'],
      },
    ]);
    expect(evidence.runs[0]?.traces.get('deploy-dev/__run_2')?.split('\n')[1]).toBe('2');
  });

  it('skips the run it is told to, reading none of its jobs or artifacts', async () => {
    const going = { id: 11, path: '.github/workflows/workflow-coverage.yml', status: 'in_progress' };
    const { asked, api: stand } = api({ ...answers(), [RUNS]: runsPage(RUN, going) });
    const evidence = await fetchEvidence(stand, REPO, SHA, new Map(), 11);
    expect(asked).toEqual([RUNS, JOBS, ARTIFACTS, '/repos/o/r/actions/artifacts/5/zip']);
    expect(evidence.runs.map((r) => r.id)).toEqual([9]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'a second page of runs',
      { ...answers(), [RUNS]: { total_count: 101, workflow_runs: [RUN] } },
      `${RUNS} lists 101 workflow_runs; one page of 100 was read`,
    ],
    ['a second page of jobs', { ...answers(), [JOBS]: { total_count: 2, jobs: [JOB] } }, `${JOBS} lists 2 jobs; one page of 100 was read`],
    [
      'a second page of artifacts',
      { ...answers(), [ARTIFACTS]: { total_count: 3, artifacts: [] } },
      `${ARTIFACTS} lists 3 artifacts; one page of 100 was read`,
    ],
    ['an answer with no list', { ...answers(), [RUNS]: { message: 'Not Found' } }, `${RUNS} answered no workflow_runs list`],
    [
      'a list entry that is not an object',
      { ...answers(), [RUNS]: runsPage('x') },
      `${RUNS} lists a workflow_runs entry that is not an object`,
    ],
    ['a run with no id', { ...answers(), [RUNS]: runsPage({ path: 'p', status: 'completed' }) }, `${RUNS} lists an entry with no id`],
    [
      'a job with no name',
      { ...answers(), [JOBS]: { total_count: 1, jobs: [{ ...JOB, name: undefined }] } },
      `${JOBS} lists an entry with no name`,
    ],
    [
      'a job with no steps list',
      { ...answers(), [JOBS]: { total_count: 1, jobs: [{ ...JOB, steps: null }] } },
      `${JOBS} lists a job with no steps list`,
    ],
    [
      'a step that is not an object',
      { ...answers(), [JOBS]: { total_count: 1, jobs: [{ ...JOB, steps: [1] }] } },
      `${JOBS} lists a step that is not an object`,
    ],
    [
      'a step with no conclusion field',
      { ...answers(), [JOBS]: { total_count: 1, jobs: [{ ...JOB, steps: [{ ...STEP, conclusion: undefined }] }] } },
      `${JOBS} lists an entry with no conclusion`,
    ],
    [
      'an expired trace artifact',
      answers([{ ...TRACE_ARTIFACT, expired: true }]),
      'run 9: artifact workflow-trace-deploy-dev has expired; re-run the run to measure this commit',
    ],
    [
      'a trace artifact with no expiry',
      answers([{ id: 5, name: 'workflow-trace-deploy-dev' }]),
      'run 9: artifact workflow-trace-deploy-dev has expired; re-run the run to measure this commit',
    ],
    [
      'an entry of another job',
      answers([{ ...TRACE_ARTIFACT, name: 'workflow-trace-other' }]),
      'run 9: artifact workflow-trace-other holds deploy-dev/__run, not other/<step>',
    ],
    ['two artifacts holding one trace', answers([TRACE_ARTIFACT, TRACE_ARTIFACT]), 'run 9: two artifacts hold deploy-dev/__run'],
  ])('fails closed on %s', async (_kind, page, message) => {
    await expect(fetchEvidence(api(page).api, REPO, SHA, new Map())).rejects.toThrow(`workflow-coverage: ${message}`);
  });

  it('fails closed on an entry nested deeper than <job>/<step>', async () => {
    const zipOf = (name: string) => new Uint8Array(readFileSync(new URL(`fixtures/workflow-coverage/${name}`, import.meta.url)));
    const stand = api(answers([{ ...TRACE_ARTIFACT, name: 'workflow-trace-j' }]), {
      '/repos/o/r/actions/artifacts/5/zip': zipOf('stored.zip'),
    });
    // stored.zip holds j/a and j/b, one level under the job, so it reads; nested.zip holds j/k/a, a level deeper.
    expect([...((await fetchEvidence(stand.api, REPO, SHA, new Map())).runs[0] as RunEvidence).traces.keys()]).toEqual(['j/a', 'j/b']);
    const deep = api(answers([{ ...TRACE_ARTIFACT, name: 'workflow-trace-j' }]), {
      '/repos/o/r/actions/artifacts/5/zip': zipOf('nested.zip'),
    });
    await expect(fetchEvidence(deep.api, REPO, SHA, new Map())).rejects.toThrow(
      'workflow-coverage: run 9: artifact workflow-trace-j holds j/k/a, not j/<step>',
    );
  });
});

describe('githubApi', () => {
  const HEADERS = { headers: { Authorization: 'Bearer t0k', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } };

  it('sends the token and API version, and reads JSON and bytes', async () => {
    const calls: unknown[] = [];
    const stand = ((url: string, init: unknown) => {
      calls.push([url, init]);
      return Promise.resolve(url.endsWith('/zip') ? new Response(new Uint8Array([1, 2])) : Response.json({ a: 1 }));
    }) as unknown as typeof fetch;
    const client = githubApi('t0k', stand);
    expect(await client.json('/x')).toEqual({ a: 1 });
    expect([...(await client.bytes('/y/zip'))]).toEqual([1, 2]);
    expect(calls).toEqual([
      ['https://api.github.com/x', HEADERS],
      ['https://api.github.com/y/zip', HEADERS],
    ]);
  });

  it('fails on an answer that is not 2xx, naming it', async () => {
    const stand = (() => Promise.resolve(new Response('no', { status: 404 }))) as unknown as typeof fetch;
    await expect(githubApi('t', stand).json('/x')).rejects.toThrow('workflow-coverage: GET /x answered 404');
    await expect(githubApi('t', stand).bytes('/y')).rejects.toThrow('workflow-coverage: GET /y answered 404');
  });
});

/** A repository root holding the given workflow files, in a new temporary folder. */
function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'workflow-coverage-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, '.github/workflows', name), text);
  return root;
}

describe('workflowFiles', () => {
  it('reads every .yml and .yaml file under .github/workflows from the filesystem, in name order', () => {
    expect(workflowFiles(rootWith({ 'b.yml': 'B', 'a.yaml': 'A', 'README.md': 'not a workflow' }))).toEqual(
      new Map([
        ['.github/workflows/a.yaml', 'A'],
        ['.github/workflows/b.yml', 'B'],
      ]),
    );
  });
});

describe('main', () => {
  const SHA = 'b'.repeat(40);
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([[[]], [['a']], [['a', 'b', 'c']]])('refuses %j: it takes a commit sha and an output path', async (args) => {
    await expect(main(args)).rejects.toThrow('usage: node scripts/workflow-coverage.ts <commit-sha> <out.lcov>');
  });

  it('refuses a short sha', async () => {
    await expect(main(['abc1234', 'out.lcov'])).rejects.toThrow('workflow-coverage: abc1234 is not a full commit sha');
  });

  it.each([
    ['GITHUB_REPOSITORY', 'GITHUB_REPOSITORY is empty: name the repository as owner/name'],
    ['GITHUB_TOKEN', 'GITHUB_TOKEN is empty: the runs and artifacts are read with it'],
  ])('refuses an empty %s', async (name, message) => {
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_TOKEN', 't');
    vi.stubEnv(name, '');
    await expect(main([SHA, 'out.lcov'])).rejects.toThrow(`workflow-coverage: ${message}`);
  });

  it('writes the lcov of every workflow file and prints what ran', async () => {
    const root = rootWith({ 'ci.yml': 'on: [push]\njobs:\n  a:\n    steps:\n      - run: echo a\n' });
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.stubEnv('GITHUB_REPOSITORY', 'o/r');
    vi.stubEnv('GITHUB_TOKEN', 't');
    const asked: string[] = [];
    const stand = ((url: string) => {
      asked.push(url);
      return Promise.resolve(Response.json({ total_count: 0, workflow_runs: [] }));
    }) as unknown as typeof fetch;
    const printed: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => printed.push(String(text)) > 0);
    const out = join(root, 'workflow.lcov');
    expect(await main([SHA, out], stand)).toBe(0);
    expect(asked).toEqual([`https://api.github.com/repos/o/r/actions/runs?head_sha=${SHA}&per_page=100`]);
    expect(readFileSync(out, 'utf8')).toBe(
      'TN:\nSF:.github/workflows/ci.yml\nDA:1,0\nDA:2,0\nDA:3,0\nDA:4,0\nDA:5,0\nLF:5\nLH:0\nend_of_record\n',
    );
    expect(printed).toEqual([
      'workflow-coverage: .github/workflows/ci.yml: 0 of 5 lines ran\n',
      `workflow-coverage: 0 of 5 workflow lines ran on ${SHA}, over 0 run(s); lcov in ${out}\n`,
    ]);
  });
});
