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

/**
 * Every run step of a workflow, in file order. It reads the block style the
 * template writes (one key per line, steps as a `- ` list) and refuses any
 * other shape a run could hide in: a `run:` line it did not read as a step's
 * script fails the read, so "no run steps" is never a blind answer.
 */
export function runSteps(workflow: string): RunStep[] {
  const lines = workflow.split('\n');
  const steps: RunStep[] = [];
  /** The run lines read as steps, and the lines of their scripts. */
  const read = new Set<number>();
  const jobsAt = lines.indexOf('jobs:');
  let job = '';
  let jobIndent = -1;
  let stepsIndent = -1;
  let unnamed = 0;
  for (let i = jobsAt === -1 ? lines.length : jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    if (jobIndent === -1) jobIndent = indent;
    if (indent === jobIndent) {
      job = (/^\s*([\w-]+):\s*$/.exec(line) ?? fail(`line ${i + 1} writes a job inline; write its keys one per line`))[1] as string;
      stepsIndent = -1;
      unnamed = 0;
      continue;
    }
    const stepsKey = /^\s*steps:(.*)$/.exec(line);
    if (stepsKey) {
      if ((stepsKey[1] as string).trim() !== '') fail(`line ${i + 1} writes its steps inline; write one step per line`);
      stepsIndent = indent;
      continue;
    }
    // A step: its keys sit on the dash line or below it, at the dash's column + 2.
    // The list may sit at its key's own indent; anything else at or above that indent ends it.
    const dash = /^(\s*)- /.exec(line);
    const inSteps = stepsIndent !== -1 && (indent > stepsIndent || (dash !== null && indent === stepsIndent));
    if (!inSteps) stepsIndent = -1;
    if (!inSteps || !dash) continue;
    const keyIndent = (dash[1] as string).length + 2;
    const stepLines: [number, string][] = [[i, `${' '.repeat(keyIndent)}${line.slice(keyIndent)}`]];
    let j = i + 1;
    for (const next of lines.slice(j)) {
      if (next.trim() !== '' && indentOf(next) < keyIndent) break;
      stepLines.push([j, next]);
      j += 1;
    }
    i = j - 1;
    const runAt = stepLines.findIndex(([, l]) => new RegExp(`^ {${keyIndent}}run:`).test(l));
    if (runAt === -1) continue;
    const id = stepLines.map(([, l]) => new RegExp(`^ {${keyIndent}}id:\\s*(\\S+)\\s*$`).exec(l)).find((m) => m)?.[1];
    const [runLine, runText] = stepLines[runAt] as [number, string];
    const at = `line ${runLine + 1}`;
    const value = runText.slice(runText.indexOf('run:') + 4).trim();
    // The run value's own lines end at the step's next key.
    let end = runAt + 1;
    for (const [, next] of stepLines.slice(end)) {
      if (next.trim() !== '' && indentOf(next) <= keyIndent) break;
      end += 1;
    }
    const body = stepLines.slice(runAt + 1, end);
    while (body.length > 0 && (body.at(-1) as [number, string])[1].trim() === '') body.pop();
    read.add(runLine);
    for (const [n] of body) read.add(n);
    if (/^>/.test(value)) fail(`${at} folds its run block (>); write it as | so each line is what bash runs`);
    if (/^["']/.test(value)) fail(`${at} quotes its run value; write it plain or as a | block`);
    if (/^\|/.test(value) && !/^\|-?$/.test(value)) fail(`${at} writes its run block as ${value}; write it as | or |-`);
    if (value === '' || (value.startsWith('|') && body.length === 0)) fail(`${at} has an empty run value`);
    let firstLine = runLine + 1;
    let script = [value];
    if (value.startsWith('|')) {
      const contentIndent = indentOf((body.find(([, l]) => l.trim() !== '') as [number, string])[1]);
      const under = body.find(([, l]) => l.trim() !== '' && indentOf(l) < contentIndent);
      if (under) fail(`line ${under[0] + 1} is indented less than its run block's first line`);
      firstLine = (body[0] as [number, string])[0] + 1;
      script = body.map(([, l]) => l.slice(contentIndent));
    } else if (body.length > 0) fail(`${at} continues its run value over lines; write it as a | block`);
    unnamed += id === undefined ? 1 : 0;
    const action = id ?? (unnamed === 1 ? '__run' : `__run_${unnamed}`);
    steps.push({ job, action, firstLine, script });
  }
  lines.forEach((l, n) => {
    if (/^\s*(-\s+)?run:\s*\S/.test(l) && !read.has(n)) fail(`line ${n + 1} has a run: outside any step this reader models`);
  });
  return steps;
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
