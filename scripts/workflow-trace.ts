/**
 * Every workflow `run:` step writes a trace of the lines bash ran (issue #35,
 * part 2). Each workflow sets `defaults.run.shell` to `TRACE_SHELL`, and each
 * job's last step uploads `$RUNNER_TEMP/workflow-trace/` as the artifact
 * `workflow-trace-<job>`.
 *
 * A trace file is `$RUNNER_TEMP/workflow-trace/$GITHUB_JOB/$GITHUB_ACTION`:
 * the script's `sha256sum` line, its line count (`wc -l`), then each line
 * number bash was about to run, from a DEBUG trap that skips every line but
 * the step's own script. The hash and count let a reader see whether the
 * script that ran is the one in the workflow file (a `${{ }}` expression can
 * change it).
 *
 * The prelude is inlined in the shell string, not a file, because a step can
 * run before checkout (record.yml checks its ref first). The runner reads the
 * string through .NET `string.Format` and starts bash with .NET's argument
 * splitting, never a shell (actions/runner ScriptHandler.cs and
 * ProcessInvoker.cs, read 2026-10-22). So the string holds no brace but
 * `{0}`, no backslash, and one double-quoted argument: `runnerArgs` models
 * exactly that and refuses the rest.
 */

export const TRACE_SHELL =
  'bash --noprofile --norc -eo pipefail -c "' +
  [
    '__workflow_trace=$RUNNER_TEMP/workflow-trace/$GITHUB_JOB',
    'mkdir -p $__workflow_trace',
    '__workflow_trace=$__workflow_trace/$GITHUB_ACTION',
    'sha256sum $0 > $__workflow_trace',
    'wc -l < $0 >> $__workflow_trace',
    'set -T',
    "trap 'if [[ $BASH_SOURCE == $0 ]]",
    'then echo $LINENO >> $__workflow_trace',
    "fi' DEBUG",
    'source $0',
  ].join('; ') +
  '" {0}';

function fail(message: string): never {
  throw new Error(`workflow-trace: ${message}`);
}

/** The program and arguments the runner starts for a `shell:` string and a script path. */
export function runnerArgs(shell: string, scriptPath: string): { file: string; args: string[] } {
  const space = shell.indexOf(' ');
  const file = space === -1 ? shell : shell.slice(0, space);
  const format = space === -1 ? '' : shell.slice(space + 1).trimStart();
  if (!format.includes('{0}')) fail('the shell string has no {0}: the runner refuses it');
  if (/[{}]/.test(format.replaceAll('{0}', '')))
    fail('the shell string holds a brace besides {0}: the runner reads it as a format item and throws');
  if (format.includes('\\') || format.includes('""'))
    fail('the shell string holds a backslash or "": how the runner splits it is not modelled');
  if (scriptPath.includes('"')) fail('the script path holds a double quote: how the runner escapes it is not modelled');
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const c of format.replaceAll('{0}', scriptPath)) {
    if (c === '"') {
      quoted = !quoted;
      started = true;
    } else if (c === ' ' && !quoted) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (quoted) fail('the shell string leaves a double quote open');
  if (started) args.push(current);
  return { file, args };
}

/** One step's trace: the script's hash, its line count and the lines bash ran. */
export function parseTrace(text: string): { sha: string; lineCount: number; traced: Set<number> } {
  const lines = text.split('\n').filter((line, i, all) => !(i === all.length - 1 && line === ''));
  if (lines.length === 0) fail('the trace is empty: the step wrote nothing');
  const [shaLine = '', countLine = '', ...rest] = lines;
  const sha = /^([0-9a-f]{64}) {2}\S/.exec(shaLine)?.[1] ?? fail('line 1 is not a sha256sum line');
  const lineCount = /^\d+$/.test(countLine.trim()) ? Number(countLine.trim()) : fail('line 2 is not a line count');
  const traced = new Set<number>();
  rest.forEach((line, i) => {
    if (!/^[1-9]\d*$/.test(line)) fail(`line ${i + 3} is not a line number`);
    const n = Number(line);
    if (n > lineCount) fail(`line ${i + 3} traces line ${n}, past the script’s ${lineCount} lines`);
    traced.add(n);
  });
  return { sha, lineCount, traced };
}
