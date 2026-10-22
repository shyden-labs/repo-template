import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { workflowCoverage, workflowLcov, type ApiJob, type Evidence, type RunEvidence } from '../../scripts/workflow-coverage.ts';
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
