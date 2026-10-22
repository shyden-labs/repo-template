import { describe, it, expect, beforeAll } from 'vitest';
import { executableUnits, layout, lcov, loadBash, ranLines, runSteps, type Bash } from '../../scripts/workflow-lines.ts';

/**
 * Workflow lines are code (issue #35; Shyden 2026-10-22: a changed workflow
 * line counts as run only if a run on that same commit took it). These pin
 * the pure part: finding each `run:` step and the name GitHub gives it,
 * finding a script's executable lines with the bash grammar, deciding which
 * ran from a trace of line numbers, and writing lcov for the workflow file.
 */

const wf = (...lines: string[]) => `${lines.join('\n')}\n`;

describe('runSteps', () => {
  const WORKFLOW = wf(
    'name: ci',
    'on: [push]',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@abc # v1',
    '      - run: npm ci',
    '      - name: Test',
    '        id: unit',
    '        run: |',
    '          npm test',
    '',
    '          echo done',
    '      - run: |-',
    '          x=1',
    '  lint:',
    '    steps:',
    '      - id: fmt',
    '        run: npx prettier --check .',
    '      - run: echo "two"',
  );

  it("finds every run step, its job, the name GitHub gives it, and its script's first line in the file", () => {
    expect(runSteps(WORKFLOW)).toEqual([
      { job: 'build', action: '__run', firstLine: 8, script: ['npm ci'], text: 'npm ci' },
      { job: 'build', action: 'unit', firstLine: 12, script: ['npm test', '', 'echo done'], text: 'npm test\n\necho done\n' },
      { job: 'build', action: '__run_2', firstLine: 16, script: ['x=1'], text: 'x=1' },
      { job: 'lint', action: 'fmt', firstLine: 20, script: ['npx prettier --check .'], text: 'npx prettier --check .' },
      { job: 'lint', action: '__run', firstLine: 21, script: ['echo "two"'], text: 'echo "two"' },
    ]);
  });

  it('reads a workflow with no jobs as having no run steps', () => {
    expect(runSteps(wf('name: x', 'on: [push]'))).toEqual([]);
  });

  it('refuses a folded run block, whose lines bash would not see as written', () => {
    expect(() => runSteps(wf('jobs:', '  a:', '    steps:', '      - run: >', '          echo x'))).toThrow(
      'workflow-lines: line 4 folds its run block (>); write it as | so each line is what bash runs',
    );
  });

  it('reads past blank lines and comments between jobs and steps', () => {
    expect(runSteps(wf('jobs:', '', '  # the one job', '  a:', '    steps:', '', '      # first', '      - run: echo a'))).toEqual([
      { job: 'a', action: '__run', firstLine: 8, script: ['echo a'], text: 'echo a' },
    ]);
  });

  it('stops at the next top-level key after jobs', () => {
    expect(runSteps(wf('jobs:', '  a:', '    steps:', '      - run: echo a', 'env:', '  X: 1'))).toEqual([
      { job: 'a', action: '__run', firstLine: 4, script: ['echo a'], text: 'echo a' },
    ]);
  });

  it('reads a steps list written at the same indent as its key', () => {
    expect(runSteps(wf('jobs:', '  a:', '    steps:', '    - run: echo a'))).toEqual([
      { job: 'a', action: '__run', firstLine: 4, script: ['echo a'], text: 'echo a' },
    ]);
  });

  it('ends a run block at the next key of its step', () => {
    expect(runSteps(wf('jobs:', '  a:', '    steps:', '      - run: |', '          echo a', '        env:', '          X: 1'))).toEqual([
      { job: 'a', action: '__run', firstLine: 5, script: ['echo a'], text: 'echo a\n' },
    ]);
  });

  it.each([
    ['a job written inline', ['  a: { runs-on: x }'], 'line 2 writes a job inline; write its keys one per line'],
    ['steps written inline', ['  a:', '    steps: [{ run: echo a }]'], 'line 3 writes its steps inline; write one step per line'],
    ['a quoted run value', ['  a:', '    steps:', '      - run: "echo a"'], 'line 4 quotes its run value; write it plain or as a | block'],
    [
      'a block with another indicator',
      ['  a:', '    steps:', '      - run: |+', '          echo a'],
      'line 4 writes its run block as |+; write it as | or |-',
    ],
    [
      'a plain value continued over lines',
      ['  a:', '    steps:', '      - run: echo a', '          b'],
      'line 4 continues its run value over lines; write it as a | block',
    ],
    ['an empty run value', ['  a:', '    steps:', '      - run:', '      - run: echo a'], 'line 4 has an empty run value'],
    ['an empty run block', ['  a:', '    steps:', '      - run: |', ''], 'line 4 has an empty run value'],
    [
      'a block line indented less than its first',
      ['  a:', '    steps:', '      - run: |', '            echo a', '          echo b'],
      "line 6 is indented less than its run block's first line",
    ],
    [
      'a run under a step input',
      ['  a:', '    steps:', '      - uses: x/y@v1', '        with:', '          run: echo a'],
      'line 6 has a run: outside any step this reader models',
    ],
    [
      'a run in a list item outside steps',
      [
        '  a:',
        '    outputs:',
        '      matrix:',
        '        include:',
        '          - os: x',
        '            run: echo m',
        '    steps:',
        '      - run: echo a',
      ],
      'line 7 has a run: outside any step this reader models',
    ],
    [
      'a run after jobs',
      ['  a:', '    steps:', '      - run: echo a', 'other:', '  - run: echo b'],
      'line 6 has a run: outside any step this reader models',
    ],
  ])('refuses %s', (_kind, lines, message) => {
    expect(() => runSteps(wf('jobs:', ...lines))).toThrow(`workflow-lines: ${message}`);
  });
});

describe('layout', () => {
  // Shyden 2026-10-22 (#35): every line but blank lines and comments is code; the
  // top settings belong to the workflow, a job's own keys to the job, a step's lines
  // to the step, and a run block's script lines are judged by the trace instead.
  const WORKFLOW = wf(
    '# about this file', // 1
    'name: ci', // 2
    'on: [push]', // 3
    '', // 4
    'jobs:', // 5
    '  build:', // 6
    '    runs-on: ubuntu-latest', // 7
    '    # a comment in the job', // 8
    '    steps:', // 9
    '      - uses: actions/checkout@abc # v1', // 10
    '        with:', // 11
    '          fetch-depth: 0', // 12
    '      - run: npm ci # install', // 13
    '      # a comment between steps', // 14
    '      - name: Test', // 15
    '        run: |', // 16
    '          npm test', // 17
    '', // 18
    '          echo done', // 19
    '        env:', // 20
    '          X: 1', // 21
    '    timeout-minutes: 5', // 22
    '  lint:', // 23
    '    steps:', // 24
    '      - name: Format # the check', // 25
    '        run: |-', // 26
    '          x=1', // 27
  );

  it('gives every code line one owner: the workflow, a job or a step, and leaves out a run block’s script lines', () => {
    const { top, jobs } = layout(WORKFLOW);
    expect(top).toEqual([2, 3, 5]);
    expect(jobs.map(({ id, lines, steps }) => ({ id, lines, steps: steps.map((step) => step.lines) }))).toEqual([
      { id: 'build', lines: [6, 7, 9, 22], steps: [[10, 11, 12], [13], [15, 16, 20, 21]] },
      { id: 'lint', lines: [23, 24], steps: [[25, 26]] },
    ]);
  });

  it('names each step as the jobs API does: its name, else Run and its uses or its one-line run', () => {
    expect(layout(WORKFLOW).jobs.flatMap((job) => job.steps.map((step) => step.apiName))).toEqual([
      'Run actions/checkout@abc',
      'Run npm ci',
      'Test',
      'Format',
    ]);
  });

  it('keeps each run step, and its text as the runner writes it: a plain value ends at its comment, | keeps one newline, |- none', () => {
    expect(layout(WORKFLOW).jobs.flatMap((job) => job.steps.map((step) => step.run))).toEqual([
      undefined,
      { job: 'build', action: '__run', firstLine: 13, script: ['npm ci'], text: 'npm ci' },
      { job: 'build', action: '__run_2', firstLine: 17, script: ['npm test', '', 'echo done'], text: 'npm test\n\necho done\n' },
      { job: 'lint', action: '__run', firstLine: 27, script: ['x=1'], text: 'x=1' },
    ]);
  });

  it('reads a step id up to its comment', () => {
    expect(
      layout(wf('jobs:', '  a:', '    steps:', '      - id: unit # the tests', '        run: echo a')).jobs[0]?.steps[0]?.run?.action,
    ).toBe('unit');
  });

  it('names a named uses step by its name', () => {
    expect(
      layout(wf('jobs:', '  a:', '    steps:', '      - name: Check out # the code', '        uses: actions/checkout@abc')).jobs[0]
        ?.steps[0]?.apiName,
    ).toBe('Check out');
  });

  it('names an unnamed run block by its first line', () => {
    expect(
      layout(wf('jobs:', '  a:', '    steps:', '      - run: |', '          echo a', '          echo b')).jobs[0]?.steps[0]?.apiName,
    ).toBe('Run echo a');
  });

  it('gives every line to the workflow when there are no jobs, and keys after jobs to the workflow', () => {
    expect(layout(wf('name: x', 'on: [push]')).top).toEqual([1, 2]);
    expect(layout(wf('jobs:', '  a:', '    steps:', '      - run: echo a', 'env:', '  X: 1')).top).toEqual([1, 5, 6]);
  });

  it('gives no job line to the workflow when nothing follows the jobs', () => {
    expect(layout(wf('on: [push]', 'jobs:', '  a:', '    steps:', '      - run: echo a')).top).toEqual([1, 2]);
  });

  it.each(['name', 'strategy', 'uses', 'services', 'container'])(
    'refuses a job with %s:, which changes the job names or steps the jobs API reports',
    (key) => {
      expect(() => layout(wf('jobs:', '  a:', '    runs-on: x', `    ${key}: y`, '    steps:', '      - run: echo a'))).toThrow(
        `workflow-lines: line 4 gives job a a ${key}:; the reader cannot yet line its jobs and steps up with the API (Shyden 2026-10-22: fail, naming it)`,
      );
    },
  );

  it('reads those words as keys only at the job’s own indent', () => {
    expect(layout(wf('jobs:', '  a:', '    env:', '      name: y', '    steps:', '      - run: echo a')).jobs[0]?.lines).toEqual([
      2, 3, 4, 5,
    ]);
  });

  it('refuses a step with neither run nor uses', () => {
    expect(() =>
      layout(wf('jobs:', '  a:', '    steps:', '      - run: echo a', '      - name: nothing', '        env:', '          X: 1')),
    ).toThrow('workflow-lines: line 5 is a step with no run or uses');
  });

  it('refuses a line inside steps that belongs to no step', () => {
    expect(() => layout(wf('jobs:', '  a:', '    steps:', '        - run: echo a', '      stray: 1'))).toThrow(
      'workflow-lines: line 5 sits in steps outside any step',
    );
  });
});

describe('executableUnits', () => {
  let bash: Bash;
  beforeAll(async () => {
    bash = await loadBash();
  });

  it.each([
    ['a command', ['echo hi'], [[1, 1]]],
    ['a command continued over lines', ['echo a \\', '  b'], [[1, 2]]],
    ['an assignment', ['x=1'], [[1, 1]]],
    ['an exported assignment', ['export X=1'], [[1, 1]]],
    ['a test', ['[ -n "$X" ]'], [[1, 1]]],
    [
      'an if: its test and each branch, not fi or else',
      ['if [ -n "$X" ]; then', '  echo a', 'else', '  echo b', 'fi'],
      [
        [1, 1],
        [2, 2],
        [4, 4],
      ],
    ],
    [
      'a for loop: its header and its body, not done',
      ['for f in *; do', '  echo "$f"', 'done'],
      [
        [1, 1],
        [2, 2],
      ],
    ],
    ['a heredoc, owned by its command', ['cat <<EOT', 'hello', 'EOT'], [[1, 3]]],
    [
      'a case: its header and each command, not the patterns',
      ['case "$X" in', '  a) echo a ;;', '  *) echo b ;;', 'esac'],
      [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    ],
    ['a comment and a blank line as nothing', ['# note', '', 'echo x'], [[3, 3]]],
  ])('finds %s', (_kind, script, units) => {
    expect(executableUnits(bash, script)).toEqual(units);
  });
});

describe('ranLines', () => {
  it('reads a unit as run when any traced line falls in it, and a line as run only when every unit on it ran', () => {
    expect(
      ranLines(
        [
          [1, 1],
          [2, 3],
          [3, 3],
          [5, 5],
        ],
        new Set([1, 3]),
      ),
    ).toEqual(
      new Map([
        [1, true],
        [2, true],
        [3, true],
        [5, false],
      ]),
    );
  });

  it('reads a unit before every traced line as not run', () => {
    expect(
      ranLines(
        [
          [1, 1],
          [2, 2],
        ],
        new Set([2]),
      ),
    ).toEqual(
      new Map([
        [1, false],
        [2, true],
      ]),
    );
  });

  it('reads a line as not run whichever order its units come in, and lists lines in order', () => {
    expect([
      ...ranLines(
        [
          [2, 2],
          [1, 2],
        ],
        new Set([1]),
      ).entries(),
    ]).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it('reads a line shared by a unit that ran and one that did not as not run', () => {
    expect(
      ranLines(
        [
          [1, 2],
          [2, 2],
        ],
        new Set([1]),
      ),
    ).toEqual(
      new Map([
        [1, true],
        [2, false],
      ]),
    );
  });
});

describe('lcov', () => {
  it('writes one record for the file, a line per executable line, with the totals', () => {
    expect(
      lcov(
        '.github/workflows/ci.yml',
        new Map([
          [12, true],
          [14, false],
        ]),
      ),
    ).toBe('TN:\nSF:.github/workflows/ci.yml\nDA:12,1\nDA:14,0\nLF:2\nLH:1\nend_of_record\n');
  });
});
