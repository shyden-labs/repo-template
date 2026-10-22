import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parseTrace, runnerArgs, TRACE_SHELL } from '../../scripts/workflow-trace.ts';
import { withoutPinnedShas, withoutYamlComments, yamlBlock } from './source-text.ts';

/**
 * Every run step writes a trace of the lines bash ran (issue #35, part 2).
 * Each workflow's `defaults.run.shell` is the one tracing shell; no step sets
 * its own; each job's last step uploads the traces, even after a failure.
 * The runner splits the shell string as .NET does, never through a shell, so
 * `runnerArgs` models that and refuses what it does not model.
 */

const SHA = 'a'.repeat(64);

describe('runnerArgs', () => {
  it('splits the program from its arguments, puts the script path at {0} and groups double-quoted text', () => {
    expect(runnerArgs('bash -e -c "echo a; source $0" {0}', '/tmp/s.sh')).toEqual({
      file: 'bash',
      args: ['-e', '-c', 'echo a; source $0', '/tmp/s.sh'],
    });
  });

  it('reads a run of spaces, and a trailing one, as a single break between arguments', () => {
    expect(runnerArgs('bash  -e   {0} ', '/tmp/s.sh')).toEqual({ file: 'bash', args: ['-e', '/tmp/s.sh'] });
  });

  it('reads the tracing shell as bash with the prelude as one argument and the script last', () => {
    const { file, args } = runnerArgs(TRACE_SHELL, '/tmp/s.sh');
    expect([file, args.length, args.slice(0, 6), args.at(-1)]).toEqual([
      'bash',
      7,
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', args[5]],
      '/tmp/s.sh',
    ]);
  });

  it.each([
    ['a shell string with no {0}', 'bash -e', '/tmp/s.sh', 'the shell string has no {0}: the runner refuses it'],
    ['a bare program', 'bash', '/tmp/s.sh', 'the shell string has no {0}: the runner refuses it'],
    [
      'a brace besides {0}',
      'bash -c "f() { :; }" {0}',
      '/tmp/s.sh',
      'the shell string holds a brace besides {0}: the runner reads it as a format item and throws',
    ],
    [
      'a backslash',
      'bash -c "a\\b" {0}',
      '/tmp/s.sh',
      'the shell string holds a backslash or "": how the runner splits it is not modelled',
    ],
    [
      'an empty quoted pair',
      'bash -c "" {0}',
      '/tmp/s.sh',
      'the shell string holds a backslash or "": how the runner splits it is not modelled',
    ],
    ['an unclosed quote', 'bash -c "a {0}', '/tmp/s.sh', 'the shell string leaves a double quote open'],
    [
      'a script path holding a quote',
      'bash {0}',
      '/tmp/"s.sh',
      'the script path holds a double quote: how the runner escapes it is not modelled',
    ],
  ])('refuses %s', (_kind, shell, path, message) => {
    expect(() => runnerArgs(shell, path)).toThrow(`workflow-trace: ${message}`);
  });
});

describe('TRACE_SHELL', () => {
  it('holds no brace but {0} and no expression, which the runner or GitHub would read first', () => {
    expect([TRACE_SHELL.split('{0}').length - 1, TRACE_SHELL.replaceAll('{0}', '').match(/[{}]/g), TRACE_SHELL.includes('${{')]).toEqual([
      1,
      null,
      false,
    ]);
  });

  it('records the script, then traces only the script’s own lines, then runs it', () => {
    const prelude = runnerArgs(TRACE_SHELL, '/tmp/s.sh').args[5];
    expect(prelude?.split('; ')).toEqual([
      '__workflow_trace=$RUNNER_TEMP/workflow-trace/$GITHUB_JOB',
      'mkdir -p $__workflow_trace',
      '__workflow_trace=$__workflow_trace/$GITHUB_ACTION',
      'sha256sum $0 > $__workflow_trace',
      "grep -c '' $0 >> $__workflow_trace",
      'set -T',
      "trap 'if [[ $BASH_SOURCE == $0 ]]",
      'then echo $LINENO >> $__workflow_trace',
      "fi' DEBUG",
      'source $0',
    ]);
  });
});

describe('parseTrace', () => {
  it('reads the script’s hash, its line count and each line bash ran', () => {
    expect(parseTrace(`${SHA}  /tmp/s.sh\n3\n1\n2\n1\n`)).toEqual({ sha: SHA, lineCount: 3, traced: new Set([1, 2]) });
  });

  it('reads a script that ran no line', () => {
    expect(parseTrace(`${SHA}  /tmp/s.sh\n3\n`)).toEqual({ sha: SHA, lineCount: 3, traced: new Set() });
  });

  it.each([
    ['an empty trace', '', 'the trace is empty: the step wrote nothing'],
    ['a hash that is not 64 hex digits', 'abc  /tmp/s.sh\n3\n', 'line 1 is not a sha256sum line'],
    ['a line count that is not a number', `${SHA}  /tmp/s.sh\nx\n`, 'line 2 is not a line count'],
    ['a traced line that is not a number', `${SHA}  /tmp/s.sh\n3\n1\nx\n`, 'line 4 is not a line number'],
    ['a traced line past the script', `${SHA}  /tmp/s.sh\n3\n4\n`, 'line 3 traces line 4, past the script’s 3 lines'],
    ['a traced line 0', `${SHA}  /tmp/s.sh\n3\n0\n`, 'line 3 is not a line number'],
  ])('refuses %s', (_kind, text, message) => {
    expect(() => parseTrace(text)).toThrow(`workflow-trace: ${message}`);
  });
});

// Every workflow, read from the folder: the population is whatever is there.
const DIR = '.github/workflows';
const workflows = readdirSync(DIR).filter((f) => f.endsWith('.yml'));
const text = (file: string) => withoutPinnedShas(withoutYamlComments(readFileSync(`${DIR}/${file}`, 'utf8')));
const jobsOf = (file: string) =>
  yamlBlock(text(file), 'jobs')
    .split('\n')
    .flatMap((line) => /^ {2}([\w-]+):$/.exec(line)?.slice(1) ?? []);
const jobs = workflows.flatMap((file) => jobsOf(file).map((job) => [file, job] as const));
const lastStep = (file: string, job: string) =>
  yamlBlock(text(file), job, '  ')
    .split(/\n(?= {6}- )/)
    .slice(-1)
    .join('')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

const UPLOAD = [
  '      - if: ${{ !cancelled() }}',
  '        uses: actions/upload-artifact@<sha>',
  '        with:',
  '          name: workflow-trace-${{ github.job }}',
  '          path: ${{ runner.temp }}/workflow-trace/',
  '          if-no-files-found: error',
  '          retention-days: 7',
].join('\n');

describe('the workflows', () => {
  it('are the six the template ships', () => {
    expect(workflows.length).toBe(6);
  });

  it('hold the seven jobs the template ships', () => {
    expect(jobs.length).toBe(7);
  });

  it.each(workflows)('%s runs every step under the tracing shell', (file) => {
    expect(yamlBlock(text(file), 'defaults')).toBe(`defaults:\n  run:\n    shell: ${TRACE_SHELL}`);
  });

  it.each(workflows)('%s lets no step choose its own shell', (file) => {
    expect(
      text(file)
        .split('\n')
        .filter((line) => /^\s*shell:/.test(line)),
    ).toEqual([`    shell: ${TRACE_SHELL}`]);
  });

  it.each(jobs)('%s job %s uploads its traces last, even after a failure', (file, job) => {
    expect(lastStep(file, job)).toBe(UPLOAD);
  });
});

describe('README.md', () => {
  it('names the workflow-line modules and their doc in the file table', () => {
    expect(readFileSync('README.md', 'utf8')).toContain(
      '| `scripts/workflow-lines.ts`, `scripts/workflow-trace.ts`, `scripts/workflow-coverage.ts`, `scripts/zip.ts`, `docs/workflow-lines.md` |',
    );
  });
});
