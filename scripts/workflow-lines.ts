/**
 * Workflow lines are code (issue #35; Shyden 2026-10-22: "a changed workflow
 * line counts as run only if a run on that same commit took it"). This is the
 * pure part of measuring them:
 *
 * - `runSteps` finds each `run:` step of a workflow, the job it is in, the
 *   name GitHub gives it in `GITHUB_ACTION` (its `id`, else `__run`,
 *   `__run_2`, ... over the job's id-less run steps), and the line where its
 *   script starts in the workflow file.
 * - `executableUnits` finds a script's executable lines with the bash grammar
 *   (`@vscode/tree-sitter-wasm`): commands, declarations, tests, assignments,
 *   the header row of a for, case or select. A command with a heredoc owns the
 *   heredoc's lines. `fi`, `else`, `done`, case patterns and comments are not
 *   code.
 * - `ranLines` decides what ran from the line numbers a trace recorded: bash
 *   reports a continued command at one of its lines, so a unit ran if any
 *   traced line falls in it, and a line ran only if every unit on it ran.
 * - `lcov` writes the record for the workflow file.
 *
 * Reading the traces and the runs, and joining the record, come next (#35).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface Node {
  type: string;
  startPosition: { row: number };
  endPosition: { row: number };
  parent: Node | null;
  namedChildren: Node[];
}

export interface Bash {
  parse(source: string): { rootNode: Node };
}

export interface RunStep {
  job: string;
  action: string;
  firstLine: number;
  script: string[];
  /** The script exactly as the runner writes it to its file: what the trace's sha256 is of. */
  text: string;
}

function fail(message: string): never {
  throw new Error(`workflow-lines: ${message}`);
}

/** A parser for bash, from the WASM grammar: nothing native is built. */
export async function loadBash(): Promise<Bash> {
  const { Parser, Language } = require('@vscode/tree-sitter-wasm') as {
    Parser: { init(): Promise<void>; new (): Bash & { setLanguage(language: unknown): void } };
    Language: { load(path: string): Promise<unknown> };
  };
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm')));
  return parser;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Where each code line of a workflow belongs (1-based file lines). */
export interface Layout {
  /** The workflow's own lines: everything outside its jobs. */
  top: number[];
  jobs: LayoutJob[];
}

export interface LayoutJob {
  id: string;
  /** The job's own lines: its id and the keys outside its steps. */
  lines: number[];
  steps: LayoutStep[];
}

export interface LayoutStep {
  /** The step's lines, leaving out a run block's script lines (the trace judges those). */
  lines: number[];
  /** The name the jobs API gives the step. */
  apiName: string;
  run?: RunStep;
}

/** Job keys that change the job names or the step list the jobs API reports. */
const UNMODELLED_JOB_KEYS = new Set(['name', 'strategy', 'uses', 'services', 'container']);

const isCode = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#');

/** A plain YAML value: it ends where a comment starts (a # at its start or after a space). */
function plain(value: string): string {
  const comment = /(?:^|\s)#/.exec(value);
  return (comment ? value.slice(0, comment.index) : value).trim();
}

/**
 * Every run step of a workflow, in file order. It reads the block style the
 * template writes (one key per line, steps as a `- ` list) and refuses any
 * other shape a run could hide in: a `run:` line it did not read as a step's
 * script fails the read, so "no run steps" is never a blind answer.
 */
export function runSteps(workflow: string): RunStep[] {
  return layout(workflow).jobs.flatMap((job) => job.steps.flatMap((step) => (step.run ? [step.run] : [])));
}

/**
 * Gives every code line of a workflow one owner (Shyden 2026-10-22, #35: a
 * line is code unless blank or a comment; the top settings ran when any job
 * ran, a job's lines when the job ran, a step's when the step ran). A job
 * shape whose jobs or steps the API reports differently fails, naming it.
 */
export function layout(workflow: string): Layout {
  const lines = workflow.split('\n');
  const top: number[] = [];
  const jobs: LayoutJob[] = [];
  /** The run lines read as steps, and the lines of their scripts. */
  const read = new Set<number>();
  const jobsAt = lines.indexOf('jobs:');
  let current: LayoutJob | undefined;
  let jobIndent = -1;
  let jobKeyIndent = -1;
  let stepsIndent = -1;
  let unnamed = 0;
  const start = jobsAt === -1 ? lines.length : jobsAt + 1;
  /** Where the jobs end: the next top-level key, or the end of the file. */
  let after = lines.length;
  lines.slice(0, start).forEach((line, n) => {
    if (isCode(line)) top.push(n + 1);
  });
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!isCode(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) {
      after = i;
      break;
    }
    if (jobIndent === -1) jobIndent = indent;
    if (indent === jobIndent) {
      const id = (/^\s*([\w-]+):\s*$/.exec(line) ?? fail(`line ${i + 1} writes a job inline; write its keys one per line`))[1] as string;
      current = { id, lines: [i + 1], steps: [] };
      jobs.push(current);
      jobKeyIndent = -1;
      stepsIndent = -1;
      unnamed = 0;
      continue;
    }
    const job = current as LayoutJob;
    // A step: its keys sit on the dash line or below it, at the dash's column + 2.
    // The list may sit at its key's own indent; anything else at or above that indent ends it.
    const dash = /^(\s*)- /.exec(line);
    const inSteps = stepsIndent !== -1 && (indent > stepsIndent || (dash !== null && indent === stepsIndent));
    if (!inSteps) {
      stepsIndent = -1;
      if (jobKeyIndent === -1) jobKeyIndent = indent;
      job.lines.push(i + 1);
      const key = indent === jobKeyIndent ? /^\s*([\w-]+):/.exec(line)?.[1] : undefined;
      if (key !== undefined && UNMODELLED_JOB_KEYS.has(key)) {
        fail(
          `line ${i + 1} gives job ${job.id} a ${key}:; the reader cannot yet line its jobs and steps up with the API (Shyden 2026-10-22: fail, naming it)`,
        );
      }
      const stepsKey = /^\s*steps:(.*)$/.exec(line);
      if (stepsKey) {
        if ((stepsKey[1] as string).trim() !== '') fail(`line ${i + 1} writes its steps inline; write one step per line`);
        stepsIndent = indent;
      }
      continue;
    }
    if (!dash) fail(`line ${i + 1} sits in steps outside any step`);
    const keyIndent = (dash[1] as string).length + 2;
    const stepLines: [number, string][] = [[i, `${' '.repeat(keyIndent)}${line.slice(keyIndent)}`]];
    let j = i + 1;
    for (const next of lines.slice(j)) {
      if (next.trim() !== '' && indentOf(next) < keyIndent) break;
      stepLines.push([j, next]);
      j += 1;
    }
    i = j - 1;
    const keyValue = (key: string) => stepLines.map(([, l]) => new RegExp(`^ {${keyIndent}}${key}:(.*)$`).exec(l)).find((m) => m)?.[1];
    const runAt = stepLines.findIndex(([, l]) => new RegExp(`^ {${keyIndent}}run:`).test(l));
    const name = keyValue('name');
    const uses = keyValue('uses');
    if (runAt === -1) {
      if (uses === undefined) fail(`line ${(stepLines[0] as [number, string])[0] + 1} is a step with no run or uses`);
      job.steps.push({
        lines: stepLines.filter(([, l]) => isCode(l)).map(([n]) => n + 1),
        apiName: name === undefined ? `Run ${plain(uses)}` : plain(name),
      });
      continue;
    }
    const idValue = keyValue('id');
    const id = idValue === undefined ? undefined : plain(idValue);
    const [runLine, runText] = stepLines[runAt] as [number, string];
    const at = `line ${runLine + 1}`;
    const value = plain(runText.slice(runText.indexOf('run:') + 4));
    // The run value's own lines end at the step's next key.
    let runEnd = runAt + 1;
    for (const [, next] of stepLines.slice(runEnd)) {
      if (next.trim() !== '' && indentOf(next) <= keyIndent) break;
      runEnd += 1;
    }
    const body = stepLines.slice(runAt + 1, runEnd);
    while (body.length > 0 && (body.at(-1) as [number, string])[1].trim() === '') body.pop();
    read.add(runLine);
    for (const [n] of body) read.add(n);
    if (/^>/.test(value)) fail(`${at} folds its run block (>); write it as | so each line is what bash runs`);
    if (/^["']/.test(value)) fail(`${at} quotes its run value; write it plain or as a | block`);
    if (/^\|/.test(value) && !/^\|-?$/.test(value)) fail(`${at} writes its run block as ${value}; write it as | or |-`);
    if (value === '' || (value.startsWith('|') && body.length === 0)) fail(`${at} has an empty run value`);
    let firstLine = runLine + 1;
    let script = [value];
    let text = value;
    if (value.startsWith('|')) {
      const contentIndent = indentOf((body.find(([, l]) => l.trim() !== '') as [number, string])[1]);
      const under = body.find(([, l]) => l.trim() !== '' && indentOf(l) < contentIndent);
      if (under) fail(`line ${under[0] + 1} is indented less than its run block's first line`);
      firstLine = (body[0] as [number, string])[0] + 1;
      script = body.map(([, l]) => l.slice(contentIndent));
      // The runner writes the block as YAML reads it: | keeps one final newline, |- none.
      text = script.join('\n') + (value === '|' ? '\n' : '');
    } else if (body.length > 0) fail(`${at} continues its run value over lines; write it as a | block`);
    unnamed += id === undefined ? 1 : 0;
    const action = id ?? (unnamed === 1 ? '__run' : `__run_${unnamed}`);
    const scriptLines = new Set(value.startsWith('|') ? body.map(([n]) => n) : []);
    job.steps.push({
      lines: stepLines.filter(([n, l]) => isCode(l) && !scriptLines.has(n)).map(([n]) => n + 1),
      // An empty run is refused above, so the script has a line that is not blank.
      apiName: name === undefined ? `Run ${(script.find((l) => l.trim() !== '') as string).trim()}` : plain(name),
      run: { job: job.id, action, firstLine, script, text },
    });
  }
  lines.slice(after).forEach((line, n) => {
    if (isCode(line)) top.push(after + n + 1);
  });
  lines.forEach((l, n) => {
    if (/^\s*(-\s+)?run:\s*\S/.test(l) && !read.has(n)) fail(`line ${n + 1} has a run: outside any step this reader models`);
  });
  return { top, jobs };
}

/** Node types that are a statement bash traces as one unit. */
const UNIT = new Set(['command', 'declaration_command', 'unset_command', 'test_command', 'variable_assignments', 'variable_assignment']);
/** Node types whose first row is a unit of its own (the loop or case header). */
const HEADER = new Set(['for_statement', 'c_style_for_statement', 'case_statement', 'select_statement']);

/** The line ranges (1-based, inclusive) of a script's executable units, in order. */
export function executableUnits(bash: Bash, script: string[]): [number, number][] {
  const units: [number, number][] = [];
  const walk = (node: Node): void => {
    if (UNIT.has(node.type)) {
      const owner = node.parent?.type === 'redirected_statement' ? node.parent : node;
      units.push([owner.startPosition.row + 1, owner.endPosition.row + 1]);
      return;
    }
    if (HEADER.has(node.type)) units.push([node.startPosition.row + 1, node.startPosition.row + 1]);
    for (const child of node.namedChildren) walk(child);
  };
  walk(bash.parse(script.join('\n')).rootNode);
  return units;
}

/** Each executable line, and whether it ran: every unit on it must have a traced line. */
export function ranLines(units: [number, number][], traced: Set<number>): Map<number, boolean> {
  const ran = new Map<number, boolean>();
  for (const [start, end] of units) {
    const unitRan = [...traced].some((t) => t >= start && t <= end);
    for (let line = start; line <= end; line += 1) ran.set(line, (ran.get(line) ?? true) && unitRan);
  }
  return new Map([...ran.entries()].sort(([a], [b]) => a - b));
}

/** The lcov record of one workflow file. */
export function lcov(file: string, ran: Map<number, boolean>): string {
  const lines = [...ran.entries()].map(([line, hit]) => `DA:${line},${hit ? 1 : 0}`);
  const hits = [...ran.values()].filter(Boolean).length;
  return `TN:\nSF:${file}\n${lines.join('\n')}\nLF:${ran.size}\nLH:${hits}\nend_of_record\n`;
}
