/**
 * Holds each code file's untested statements and branch arms in one committed
 * record, `coverage-record.json`, so no count ever rises and every gain is
 * recorded in the pull request that earns it (issue #32; Shyden 2026-10-22:
 * "Untested count" and "Must be recorded"). A count, not a percentage: a
 * percentage ratchet would block a pull request that deletes well-tested code.
 *
 *   npm run test:coverage                   # measure every code file
 *   node scripts/coverage-record.ts check   # CI: the record must equal the report
 *   node scripts/coverage-record.ts record  # laptop, or the record workflow on a scratch ref
 *
 * The check also fails on a code file no suite measured, and on any comment
 * telling coverage to skip a line: a skipped line counts as unrun. It fails
 * closed on a missing or malformed report or record.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { runIfEntry } from './cli.ts';

/** Untested statements and branch arms in one file. */
export interface Counts {
  statements: number;
  branches: number;
}

/** What one coverage run measured in one file: untested counts and their totals. */
export interface Measured extends Counts {
  statementsTotal: number;
  branchesTotal: number;
}

export const SUMMARY = 'coverage/coverage-summary.json';
export const RECORD = 'coverage-record.json';
const RECORD_COMMAND = 'npm run coverage:record';
/** The refs the record workflow measures: never a branch, so measuring starts no other run. */
const SCRATCH_REF = /^refs\/(?:floors|visual)\/./;

/** Every TypeScript and JavaScript extension: tests and tool configs are code too. */
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Dependencies, git's own files, and what tools write: never the repo's code. */
const NOT_SOURCE = new Set(['node_modules', '.git', 'coverage', '.vite']);

function fail(message: string): never {
  throw new Error(`coverage-record: ${message}`);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

interface Metric {
  total: number;
  covered: number;
  skipped: number;
}

function metric(entry: Record<string, unknown>, name: string, file: string): Metric {
  const m = entry[name];
  if (!isObject(m) || !isCount(m.total) || !isCount(m.covered) || !isCount(m.skipped)) {
    return fail(`${file} has a malformed ${name} entry`);
  }
  return { total: m.total, covered: m.covered, skipped: m.skipped };
}

/** The json-summary report as untested counts per file, keyed by path relative to `root`. */
export function untestedCounts(summary: unknown, root: string): Map<string, Measured> {
  if (!isObject(summary)) return fail('the summary is not a JSON object');
  if (!('total' in summary)) return fail('the summary has no total; refusing to judge a malformed report');
  const files = Object.keys(summary).filter((key) => key !== 'total');
  if (files.length === 0) return fail('the summary measured no file; refusing to judge an empty report');
  const out = new Map<string, Measured>();
  for (const absolute of files.sort()) {
    const file = relative(root, absolute).split(sep).join('/');
    if (file.startsWith('../') || file === '..') fail(`${absolute} is outside ${root}`);
    const entry = summary[absolute];
    if (!isObject(entry)) return fail(`${file} has a malformed entry`);
    const statements = metric(entry, 'statements', file);
    const branches = metric(entry, 'branches', file);
    const skipped = statements.skipped + branches.skipped;
    if (skipped > 0) {
      fail(
        `${file} has ${skipped} skipped statement(s); ` +
          'a skipped line counts as unrun, so remove what skips it',
      );
    }
    out.set(file, {
      statements: statements.total - statements.covered,
      branches: branches.total - branches.covered,
      statementsTotal: statements.total,
      branchesTotal: branches.total,
    });
  }
  return out;
}

/** The committed record; anything but `{ "<file>": { "statements": n, "branches": n } }` is refused. */
export function parseRecord(text: string): Map<string, Counts> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('the record is not JSON');
  }
  if (!isObject(parsed)) return fail('the record is not a JSON object');
  const out = new Map<string, Counts>();
  for (const [file, entry] of Object.entries(parsed)) {
    if (
      !isObject(entry) ||
      Object.keys(entry).sort().join() !== 'branches,statements' ||
      !isCount(entry.statements) ||
      !isCount(entry.branches)
    ) {
      return fail(`the record has a malformed entry for ${file}`);
    }
    out.set(file, { statements: entry.statements, branches: entry.branches });
  }
  return out;
}

const KINDS = [
  ['statements', 'untested statements'],
  ['branches', 'untested branch arms'],
] as const;

/** Every way the record differs from what was measured; empty when they are equal. */
export function compare(record: Map<string, Counts>, measured: Map<string, Measured>): string[] {
  const problems: string[] = [];
  for (const file of [...new Set([...record.keys(), ...measured.keys()])].sort()) {
    const was = record.get(file);
    const now = measured.get(file);
    if (was === undefined) {
      problems.push(`${file}: measured but not in the record; record it (${RECORD_COMMAND})`);
    } else if (now === undefined) {
      problems.push(
        `${file}: in the record but not measured; a deleted file is dropped by recording, an unmeasured one fails`,
      );
    } else {
      for (const [key, label] of KINDS) {
        if (now[key] > was[key]) problems.push(`${file}: ${label} rose from ${was[key]} to ${now[key]}`);
        if (now[key] < was[key]) {
          problems.push(`${file}: ${label} fell from ${was[key]} to ${now[key]}; record the gain (${RECORD_COMMAND})`);
        }
      }
    }
  }
  return problems;
}

/** The new record text and each change it makes; refuses any count that rose. */
export function recordFrom(
  record: Map<string, Counts>,
  measured: Map<string, Measured>,
): { record: string; changes: string[] } {
  const rises = compare(record, measured).filter((p) => p.includes(' rose from '));
  if (rises.length > 0) fail(`refusing to record a rise: ${rises.join('; ')}`);
  const files = [...measured.keys()].sort();
  const lines = files.map((file) => {
    const { statements, branches } = measured.get(file) as Measured;
    return `  ${JSON.stringify(file)}: { "statements": ${statements}, "branches": ${branches} }`;
  });
  const changes: string[] = [];
  for (const file of [...new Set([...record.keys(), ...files])].sort()) {
    const was = record.get(file);
    const now = measured.get(file);
    if (was === undefined) {
      const { statements, branches } = now as Measured;
      changes.push(`${file}: newly recorded at ${statements} untested statements, ${branches} untested branch arms`);
    } else if (now === undefined) {
      changes.push(`${file}: dropped (no longer measured)`);
    } else {
      for (const [key, label] of KINDS) {
        if (now[key] !== was[key]) changes.push(`${file}: ${label} ${was[key]} -> ${now[key]}`);
      }
    }
  }
  return { record: `{\n${lines.join(',\n')}\n}\n`, changes };
}

/** A comment that tells a coverage tool to skip code: an opener, then `v8|c8|istanbul ignore`. */
const SKIP = /(?:\/\*+|\/\/)\s*(?:v8|c8|istanbul)\s+ignore\b/;

/** The 1-based lines holding a skip comment. */
export function skipHints(text: string): number[] {
  return text.split('\n').flatMap((line, i) => (SKIP.test(line) ? [i + 1] : []));
}

/** Every code file under `root`, relative and sorted, read from the filesystem rather than a list. */
export function codeFiles(root: string, dir = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!NOT_SOURCE.has(entry.name)) found.push(...codeFiles(root, path));
    } else if (CODE.test(entry.name)) {
      found.push(path);
    }
  }
  return found.sort();
}

const percent = (untested: number, total: number): string =>
  `${(total === 0 ? 100 : (100 * (total - untested)) / total).toFixed(2)}% run`;

/** One line with the whole repo's untested counts and the percentages they leave. */
export function formatTotals(measured: Map<string, Measured>): string {
  let s = 0;
  let sTotal = 0;
  let b = 0;
  let bTotal = 0;
  for (const m of measured.values()) {
    s += m.statements;
    sTotal += m.statementsTotal;
    b += m.branches;
    bTotal += m.branchesTotal;
  }
  return (
    `coverage-record: ${measured.size} file(s) measured; ` +
    `${s} of ${sTotal} statements untested (${percent(s, sTotal)}), ` +
    `${b} of ${bTotal} branch arms untested (${percent(b, bTotal)})`
  );
}

function read(root: string, file: string, missing: string): string {
  const path = join(root, file);
  if (!existsSync(path)) fail(missing);
  return readFileSync(path, 'utf8');
}

export function main(args: string[]): number {
  const root = process.cwd();
  const [mode, ...rest] = args;
  if ((mode !== 'check' && mode !== 'record') || rest.length > 0) {
    throw new Error('usage: node scripts/coverage-record.ts check|record');
  }
  // In CI only the record workflow may record, on a scratch ref, handing the file back as an artifact (#30).
  if (mode === 'record' && process.env.CI && !SCRATCH_REF.test(process.env.RECORD_RUN ?? '')) {
    fail('record never runs in CI but the record workflow on a scratch ref; record there or on the laptop');
  }
  const measured = untestedCounts(
    JSON.parse(read(root, SUMMARY, `no coverage summary at ${SUMMARY}; run npm run test:coverage first`)),
    root,
  );
  process.stdout.write(`${formatTotals(measured)}\n`);
  if (mode === 'record') {
    const old = existsSync(join(root, RECORD)) ? parseRecord(readFileSync(join(root, RECORD), 'utf8')) : new Map<string, Counts>();
    const { record, changes } = recordFrom(old, measured);
    writeFileSync(join(root, RECORD), record);
    if (changes.length === 0) process.stdout.write('coverage-record: no change; the record already equals the report\n');
    for (const change of changes) process.stdout.write(`coverage-record: ${change}\n`);
    return 0;
  }
  const record = parseRecord(read(root, RECORD, `no record at ${RECORD}; run ${RECORD_COMMAND} on the laptop`));
  const problems = compare(record, measured);
  const files = codeFiles(root);
  for (const file of files) {
    if (!measured.has(file)) problems.push(`${file}: no suite measured it; a file no test runs counts as unrun`);
    for (const line of skipHints(readFileSync(join(root, file), 'utf8'))) {
      problems.push(`${file}:${line} tells coverage to skip a line; a skipped line counts as unrun`);
    }
  }
  for (const problem of problems) process.stderr.write(`coverage-record: ${problem}\n`);
  if (problems.length > 0) return 1;
  process.stdout.write(`coverage-record: the record matches all ${measured.size} measured file(s)\n`);
  return 0;
}

await runIfEntry(import.meta.url, main);
