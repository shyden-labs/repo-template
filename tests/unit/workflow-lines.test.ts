import { describe, it, expect, beforeAll } from 'vitest';
import { executableUnits, lcov, loadBash, ranLines, runSteps, type Bash } from '../../scripts/workflow-lines';

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
      { job: 'build', action: '__run', firstLine: 8, script: ['npm ci'] },
      { job: 'build', action: 'unit', firstLine: 12, script: ['npm test', '', 'echo done'] },
      { job: 'build', action: '__run_2', firstLine: 16, script: ['x=1'] },
      { job: 'lint', action: 'fmt', firstLine: 20, script: ['npx prettier --check .'] },
      { job: 'lint', action: '__run', firstLine: 21, script: ['echo "two"'] },
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
      { job: 'a', action: '__run', firstLine: 8, script: ['echo a'] },
    ]);
  });

  it('stops at the next top-level key after jobs', () => {
    expect(runSteps(wf('jobs:', '  a:', '    steps:', '      - run: echo a', 'env:', '  X: 1'))).toEqual([
      { job: 'a', action: '__run', firstLine: 4, script: ['echo a'] },
    ]);
  });

  it('reads a steps list written at the same indent as its key', () => {
    expect(runSteps(wf('jobs:', '  a:', '    steps:', '    - run: echo a'))).toEqual([{ job: 'a', action: '__run', firstLine: 4, script: ['echo a'] }]);
  });

  it('ends a run block at the next key of its step', () => {
    expect(runSteps(wf('jobs:', '  a:', '    steps:', '      - run: |', '          echo a', '        env:', '          X: 1'))).toEqual([
      { job: 'a', action: '__run', firstLine: 5, script: ['echo a'] },
    ]);
  });

  it.each([
    ['a job written inline', ['  a: { runs-on: x }'], 'line 2 writes a job inline; write its keys one per line'],
    ['steps written inline', ['  a:', '    steps: [{ run: echo a }]'], 'line 3 writes its steps inline; write one step per line'],
    ['a quoted run value', ['  a:', '    steps:', '      - run: "echo a"'], 'line 4 quotes its run value; write it plain or as a | block'],
    ['a block with another indicator', ['  a:', '    steps:', '      - run: |+', '          echo a'], 'line 4 writes its run block as |+; write it as | or |-'],
    ['a plain value continued over lines', ['  a:', '    steps:', '      - run: echo a', '          b'], 'line 4 continues its run value over lines; write it as a | block'],
    ['an empty run value', ['  a:', '    steps:', '      - run:', '      - run: echo a'], 'line 4 has an empty run value'],
    ['an empty run block', ['  a:', '    steps:', '      - run: |', ''], 'line 4 has an empty run value'],
    ['a block line indented less than its first', ['  a:', '    steps:', '      - run: |', '            echo a', '          echo b'], 'line 6 is indented less than its run block\'s first line'],
    ['a run under a step input', ['  a:', '    steps:', '      - uses: x/y@v1', '        with:', '          run: echo a'], 'line 6 has a run: outside any step this reader models'],
    ['a run in a list item outside steps', ['  a:', '    strategy:', '      matrix:', '        include:', '          - os: x', '            run: echo m', '    steps:', '      - run: echo a'], 'line 7 has a run: outside any step this reader models'],
    ['a run after jobs',['  a:', '    steps:', '      - run: echo a', 'other:', '  - run: echo b'], 'line 6 has a run: outside any step this reader models'],
  ])('refuses %s', (_kind, lines, message) => {
    expect(() => runSteps(wf('jobs:', ...lines))).toThrow(`workflow-lines: ${message}`);
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
    ['an if: its test and each branch, not fi or else', ['if [ -n "$X" ]; then', '  echo a', 'else', '  echo b', 'fi'], [[1, 1], [2, 2], [4, 4]]],
    ['a for loop: its header and its body, not done', ['for f in *; do', '  echo "$f"', 'done'], [[1, 1], [2, 2]]],
    ['a heredoc, owned by its command', ['cat <<EOT', 'hello', 'EOT'], [[1, 3]]],
    ['a case: its header and each command, not the patterns', ['case "$X" in', '  a) echo a ;;', '  *) echo b ;;', 'esac'], [[1, 1], [2, 2], [3, 3]]],
    ['a comment and a blank line as nothing', ['# note', '', 'echo x'], [[3, 3]]],
  ])('finds %s', (_kind, script, units) => {
    expect(executableUnits(bash, script)).toEqual(units);
  });
});

describe('ranLines', () => {
  it('reads a unit as run when any traced line falls in it, and a line as run only when every unit on it ran', () => {
    expect(ranLines([[1, 1], [2, 3], [3, 3], [5, 5]], new Set([1, 3]))).toEqual(
      new Map([
        [1, true],
        [2, true],
        [3, true],
        [5, false],
      ]),
    );
  });

  it('reads a line shared by a unit that ran and one that did not as not run', () => {
    expect(ranLines([[1, 2], [2, 2]], new Set([1]))).toEqual(
      new Map([
        [1, true],
        [2, false],
      ]),
    );
  });
});

describe('lcov', () => {
  it('writes one record for the file, a line per executable line, with the totals', () => {
    expect(lcov('.github/workflows/ci.yml', new Map([[12, true], [14, false]]))).toBe(
      'TN:\nSF:.github/workflows/ci.yml\nDA:12,1\nDA:14,0\nLF:2\nLH:1\nend_of_record\n',
    );
  });
});
