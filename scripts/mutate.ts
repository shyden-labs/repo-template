/**
 * The mutations check (issue #21; Shyden 2026-10-16: "mutation testing is
 * vital. we need it", then "it must be run"; docs/mutations.md).
 *
 *   node scripts/mutate.ts pr <base-ref>          # CI's mutations job
 *   node scripts/mutate.ts run <mutation-file>... # by hand
 *
 * `pr` fails when the pull request adds or changes a non-unit test file and no
 * mutation file it adds or changes targets that file, naming each; then it
 * runs every mutation file the pull request adds or changes. A run takes each
 * file's targets clean first (red before any mutation is refused), plants each
 * row (its anchor exactly once), runs the targets, judges the result against
 * the row's written prediction, and puts the file back, even on failure. A
 * misprediction is a finding: read it, never re-run it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIfEntry } from './cli.ts';

export interface Row {
  name: string;
  path: string;
  anchor: string;
  replacement: string;
  predict: { red: string[] } | { green: true };
}

export interface MutationFile {
  targets: string[];
  suite: string;
  mutations: Row[];
}

/** Every non-unit suite: the folder its tests live in and the config that runs them. New suites join here. */
export const SUITES: Record<string, { dir: string; config: string }> = {
  logs: { dir: 'tests/logs/', config: 'vitest.logs.config.ts' },
  integration: { dir: 'tests/integration/', config: 'vitest.integration.config.ts' },
};

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const KEYS = ['mutations', 'suite', 'targets'];

function fail(message: string): never {
  throw new Error(`mutate: ${message}`);
}

/** A test file in one of the non-unit suites. */
export const nonUnitTest = (path: string): boolean => TEST_FILE.test(path) && Object.values(SUITES).some((s) => path.startsWith(s.dir));

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** One mutation file, refused unless every row is complete and predicts red with named tests, or green. */
export function parseMutationFile(text: string, path: string): MutationFile {
  const refuse = (message: string): never => fail(`${path} ${message}`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse('is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refuse('is not a JSON object');
  const f = raw as Record<string, unknown>;
  const unknown = Object.keys(f).filter((k) => !KEYS.includes(k));
  if (unknown.length > 0) refuse(`has keys it does not know: ${unknown.join(', ')}`);
  if (!Array.isArray(f.targets) || f.targets.length === 0 || !f.targets.every(isText)) {
    refuse('targets must list the non-unit test files it proves');
  }
  for (const target of f.targets as string[]) {
    if (!nonUnitTest(target)) refuse(`${target} is not a non-unit test file`);
  }
  if (!(typeof f.suite === 'string' && f.suite in SUITES))
    refuse(`suite ${String(f.suite)} is not one of ${Object.keys(SUITES).join(', ')}`);
  if (!Array.isArray(f.mutations) || f.mutations.length === 0) refuse('mutations must hold at least one row');
  const rows = (f.mutations as Record<string, unknown>[]).map((r, i) => {
    const where = `row ${i + 1}`;
    if (
      ![r.name, r.path, r.anchor, r.replacement].every((v) => typeof v === 'string') ||
      !isText(r.name) ||
      !isText(r.path) ||
      !isText(r.anchor)
    ) {
      refuse(`${where} needs a name, a path, an anchor and a replacement`);
    }
    if (r.anchor === r.replacement) refuse(`${where} (${r.name as string}) replaces its anchor with itself`);
    const p = r.predict as Record<string, unknown> | undefined;
    const red = p !== undefined && Object.keys(p).join() === 'red' && Array.isArray(p.red) && p.red.length > 0 && p.red.every(isText);
    const green = p !== undefined && Object.keys(p).join() === 'green' && p.green === true;
    if (!red && !green) refuse(`${where} (${r.name as string}) must predict { "red": [named tests] } or { "green": true }`);
    return r as unknown as Row;
  });
  return { targets: f.targets as string[], suite: f.suite as string, mutations: rows };
}

/** How many changed paths were judged, and each changed non-unit test no changed mutation file targets. */
export function judge(changed: string[], files: MutationFile[]): { judged: number; missing: string[] } {
  const targeted = new Set(files.flatMap((f) => f.targets));
  return { judged: changed.length, missing: changed.filter((p) => nonUnitTest(p) && !targeted.has(p)) };
}

/** The text with the row's anchor replaced, refused unless the anchor appears exactly once. */
export function apply(text: string, row: Row): string {
  const count = text.split(row.anchor).length - 1;
  if (count !== 1) fail(`row "${row.name}": its anchor appears ${count} times in ${row.path}, not exactly once`);
  return text.replace(row.anchor, row.replacement);
}

/** Why a run does not match its row's prediction; '' when it does. */
export function verdict(row: Row, run: { failed: string[]; total: number }, cleanTotal: number): string {
  if (run.total !== cleanTotal) return `ran ${run.total} tests, not the clean ${cleanTotal}: tests were dropped or added`;
  if ('green' in row.predict) return run.failed.length === 0 ? '' : `predicted green, but failed: ${run.failed.join(', ')}`;
  const named = row.predict.red;
  if (run.failed.length === 0) return `predicted red (${named.join(', ')}), but nothing failed`;
  const missed = named.filter((n) => !run.failed.some((f) => f.includes(n)));
  if (missed.length > 0) return `predicted ${missed.join(', ')} to fail; failed instead: ${run.failed.join(', ')}`;
  const extra = run.failed.filter((f) => !named.some((n) => f.includes(n)));
  return extra.length === 0 ? '' : `failed too, unpredicted: ${extra.join(', ')}`;
}

/** Runs a file's targets in its suite and reads vitest's JSON report. */
function runSuite(file: MutationFile): { failed: string[]; total: number } {
  const dir = mkdtempSync(join(tmpdir(), 'mutate-'));
  const report = join(dir, 'report.json');
  try {
    const result = spawnSync(
      'npx',
      [
        'vitest',
        'run',
        '--config',
        (SUITES[file.suite] as { config: string }).config,
        ...file.targets,
        '--reporter=json',
        `--outputFile=${report}`,
      ],
      { encoding: 'utf8' },
    );
    if (!existsSync(report)) fail(`the ${file.suite} suite wrote no report (exit ${String(result.status)}); it did not run`);
    const json = JSON.parse(readFileSync(report, 'utf8')) as {
      numTotalTests: number;
      testResults: { assertionResults: { fullName: string; status: string }[] }[];
    };
    return {
      failed: json.testResults.flatMap((t) => t.assertionResults.filter((a) => a.status === 'failed').map((a) => a.fullName)),
      total: json.numTotalTests,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs one mutation file; returns each row that did not go as predicted. */
function runFile(path: string, root: string): string[] {
  const file = parseMutationFile(readFileSync(join(root, path), 'utf8'), path);
  const clean = runSuite(file);
  if (clean.failed.length > 0) fail(`${path}: the targets are red before any mutation: ${clean.failed.join(', ')}`);
  process.stdout.write(`mutate: ${path}: clean, ${clean.total} test(s)\n`);
  const problems: string[] = [];
  for (const row of file.mutations) {
    const target = join(root, row.path);
    const original = readFileSync(target, 'utf8');
    let result: { failed: string[]; total: number };
    try {
      writeFileSync(target, apply(original, row));
      result = runSuite(file);
    } finally {
      writeFileSync(target, original);
    }
    const problem = verdict(row, result, clean.total);
    if (problem === '') process.stdout.write(`mutate: ${path}: ${row.name}: as predicted\n`);
    else problems.push(`${path}: ${row.name}: ${problem}`);
  }
  return problems;
}

export function main(args: string[]): number {
  const [mode, ...rest] = args;
  const usage = 'usage: node scripts/mutate.ts pr <base-ref> | run <mutation-file>...';
  if (!((mode === 'pr' && rest.length === 1) || (mode === 'run' && rest.length > 0))) throw new Error(usage);
  const root = process.cwd();
  let files = rest;
  if (mode === 'pr') {
    const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', `${rest[0] as string}...HEAD`], { encoding: 'utf8' })
      .split('\n')
      .filter((p) => p !== '');
    files = changed.filter((p) => p.startsWith('mutations/') && p.endsWith('.json'));
    const parsed = files.map((p) => parseMutationFile(readFileSync(join(root, p), 'utf8'), p));
    const { judged, missing } = judge(changed, parsed);
    const tests = changed.filter(nonUnitTest).length;
    process.stdout.write(`mutate: judged ${judged} changed path(s); ${tests} non-unit test file(s), ${files.length} mutation file(s)\n`);
    for (const m of missing) process.stderr.write(`mutate: ${m} changed, but no mutation file in this pull request targets it\n`);
    if (missing.length > 0) return 1;
  }
  const problems = files.flatMap((f) => runFile(f, root));
  for (const p of problems) process.stderr.write(`mutate: ${p}\n`);
  return problems.length === 0 ? 0 : 1;
}

await runIfEntry(import.meta.url, main);
