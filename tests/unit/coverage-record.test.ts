import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codeFiles,
  compare,
  formatTotals,
  main,
  parseRecord,
  recordFrom,
  skipHints,
  untestedCounts,
  type Counts,
} from '../../scripts/coverage-record.ts';

/**
 * The coverage record (issue #32; Shyden 2026-10-22, "Untested count" and
 * "Must be recorded"): one committed file holds each code file's untested
 * statements and branch arms. No count may rise, and the record must EQUAL the
 * measured counts, so a gain is recorded in the pull request that earns it.
 * A file no suite measured fails, and so does any comment telling coverage to
 * skip a line, because a skipped line counts as unrun.
 */

const entry = (sTotal: number, sCovered: number, bTotal: number, bCovered: number, skipped = 0) => ({
  lines: { total: sTotal, covered: sCovered, skipped: 0, pct: 0 },
  statements: { total: sTotal, covered: sCovered, skipped, pct: 0 },
  functions: { total: 1, covered: 1, skipped: 0, pct: 100 },
  branches: { total: bTotal, covered: bCovered, skipped: 0, pct: 0 },
});

describe('untestedCounts', () => {
  it('turns the summary into untested counts per file, relative to the root', () => {
    const summary = {
      total: entry(14, 11, 6, 3),
      '/repo/scripts/a.ts': entry(10, 8, 4, 1),
      '/repo/tests/unit/a.test.ts': entry(4, 3, 2, 2),
    };
    expect(untestedCounts(summary, '/repo')).toEqual(
      new Map([
        ['scripts/a.ts', { statements: 2, branches: 3, statementsTotal: 10, branchesTotal: 4 }],
        ['tests/unit/a.test.ts', { statements: 1, branches: 0, statementsTotal: 4, branchesTotal: 2 }],
      ]),
    );
  });

  it('refuses a file outside the root', () => {
    expect(() => untestedCounts({ total: entry(1, 1, 0, 0), '/elsewhere/x.ts': entry(1, 1, 0, 0) }, '/repo')).toThrow(
      'coverage-record: /elsewhere/x.ts is outside /repo',
    );
  });

  it('refuses the parent of the root', () => {
    expect(() => untestedCounts({ total: entry(1, 1, 0, 0), '/': entry(1, 1, 0, 0) }, '/repo')).toThrow(
      'coverage-record: / is outside /repo',
    );
  });

  it('refuses a file entry that is not an object', () => {
    expect(() => untestedCounts({ total: entry(1, 1, 0, 0), '/repo/a.ts': 3 }, '/repo')).toThrow(
      'coverage-record: a.ts has a malformed entry',
    );
  });

  it('refuses a summary with skipped lines, which count as unrun', () => {
    expect(() => untestedCounts({ total: entry(2, 1, 0, 0, 1), '/repo/a.ts': entry(2, 1, 0, 0, 1) }, '/repo')).toThrow(
      'coverage-record: a.ts has 1 skipped statement(s); a skipped line counts as unrun, so remove what skips it',
    );
  });

  it('refuses a summary with no total (fails closed on a malformed report)', () => {
    expect(() => untestedCounts({ '/repo/a.ts': entry(1, 1, 0, 0) }, '/repo')).toThrow(
      'coverage-record: the summary has no total; refusing to judge a malformed report',
    );
  });

  it('refuses a summary that measured no file at all', () => {
    expect(() => untestedCounts({ total: entry(0, 0, 0, 0) }, '/repo')).toThrow(
      'coverage-record: the summary measured no file; refusing to judge an empty report',
    );
  });

  it('refuses a file entry whose counts are not whole numbers', () => {
    const bad = { ...entry(1, 1, 0, 0), branches: { total: 'x', covered: 0, skipped: 0, pct: 0 } };
    expect(() => untestedCounts({ total: entry(1, 1, 0, 0), '/repo/a.ts': bad }, '/repo')).toThrow(
      'coverage-record: a.ts has a malformed branches entry',
    );
  });

  it('refuses a summary that is not an object', () => {
    expect(() => untestedCounts(null, '/repo')).toThrow('coverage-record: the summary is not a JSON object');
  });
});

describe('parseRecord', () => {
  it('reads a record of untested counts', () => {
    expect(parseRecord('{"scripts/a.ts": {"statements": 2, "branches": 0}}')).toEqual(
      new Map([['scripts/a.ts', { statements: 2, branches: 0 }]]),
    );
  });

  it.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a negative count', '{"a.ts": {"statements": -1, "branches": 0}}'],
    ['a fractional count', '{"a.ts": {"statements": 1.5, "branches": 0}}'],
    ['a missing count', '{"a.ts": {"statements": 1}}'],
    ['an extra key', '{"a.ts": {"statements": 1, "branches": 0, "lines": 3}}'],
    ['an entry that is not an object', '{"a.ts": 3}'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseRecord(text)).toThrow(/^coverage-record: the record /);
  });
});

const counts = (statements: number, branches: number): Counts => ({ statements, branches });
const measured = (statements: number, branches: number) => ({
  statements,
  branches,
  statementsTotal: 10,
  branchesTotal: 10,
});

describe('compare', () => {
  it('passes when the record equals what was measured', () => {
    expect(compare(new Map([['a.ts', counts(1, 2)]]), new Map([['a.ts', measured(1, 2)]]))).toEqual([]);
  });

  it('fails a count that rose', () => {
    expect(compare(new Map([['a.ts', counts(1, 2)]]), new Map([['a.ts', measured(2, 3)]]))).toEqual([
      'a.ts: untested statements rose from 1 to 2',
      'a.ts: untested branch arms rose from 2 to 3',
    ]);
  });

  it('fails a gain left unrecorded', () => {
    expect(compare(new Map([['a.ts', counts(3, 2)]]), new Map([['a.ts', measured(1, 0)]]))).toEqual([
      'a.ts: untested statements fell from 3 to 1; record the gain (npm run coverage:record)',
      'a.ts: untested branch arms fell from 2 to 0; record the gain (npm run coverage:record)',
    ]);
  });

  it('fails a measured file the record does not hold', () => {
    expect(compare(new Map(), new Map([['b.ts', measured(0, 0)]]))).toEqual([
      'b.ts: measured but not in the record; record it (npm run coverage:record)',
    ]);
  });

  it('fails a recorded file nothing measured', () => {
    expect(compare(new Map([['c.ts', counts(0, 0)]]), new Map())).toEqual([
      'c.ts: in the record but not measured; a deleted file is dropped by recording, an unmeasured one fails',
    ]);
  });
});

describe('recordFrom', () => {
  it('records the measured counts, in path order, and names each change', () => {
    const { record, changes } = recordFrom(
      new Map([
        ['b.ts', counts(4, 1)],
        ['gone.ts', counts(0, 0)],
      ]),
      new Map([
        ['b.ts', measured(2, 1)],
        ['a.ts', measured(0, 0)],
      ]),
    );
    expect(record).toBe('{\n  "a.ts": { "statements": 0, "branches": 0 },\n  "b.ts": { "statements": 2, "branches": 1 }\n}\n');
    expect(changes).toEqual([
      'a.ts: newly recorded at 0 untested statements, 0 untested branch arms',
      'b.ts: untested statements 4 -> 2',
      'gone.ts: dropped (no longer measured)',
    ]);
  });

  it('refuses to record a count that rose', () => {
    expect(() => recordFrom(new Map([['a.ts', counts(1, 1)]]), new Map([['a.ts', measured(1, 2)]]))).toThrow(
      'coverage-record: refusing to record a rise: a.ts: untested branch arms rose from 1 to 2',
    );
  });
});

// Built from pieces, so this file never holds a real skip comment for the check to find.
const block = (body: string) => ['/', '*', body, '*', '/'].join('');
const line = (body: string) => ['/', '/', body].join('');

describe('skipHints', () => {
  it.each([
    [block(' v8 ignore next ')],
    [block(' v8 ignore next 3 ')],
    [line(' v8 ignore start')],
    [block(' v8 ignore stop ')],
    [block(' v8 ignore next -- @preserve ')],
    [block(' c8 ignore next ')],
    [block(' istanbul ignore else ')],
    [block('   istanbul   ignore   if ')],
    [block('* v8 ignore next ')],
  ])('finds %s', (hint) => {
    expect(skipHints(`const a = 1;\n${hint}\nconst b = 2;\n`)).toEqual([2]);
  });

  it('finds every line that holds one', () => {
    expect(skipHints(`${block(' v8 ignore next ')}\nx;\n${line(' c8 ignore start')}\n`)).toEqual([1, 3]);
  });

  it('finds nothing in code that skips nothing', () => {
    expect(skipHints(`const ignore = 1; ${line(' the v8 engine')}\nconst s = ' v8 ignore next';\n`)).toEqual([]);
  });
});

describe('codeFiles', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'coverage-record-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists every TypeScript and JavaScript file, sorted, outside dependency and output folders', () => {
    for (const dir of ['scripts', 'tests/unit', 'node_modules/x', 'coverage', '.git', '.vite']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    for (const file of [
      'scripts/a.ts',
      'tests/unit/a.test.ts',
      'tool.config.mjs',
      'b.cjs',
      'c.js',
      'd.mts',
      'e.cts',
      'f.tsx',
      'g.jsx',
      'README.md',
      'node_modules/x/index.js',
      'coverage/prettify.js',
      '.git/hook.js',
      '.vite/cache.js',
    ]) {
      writeFileSync(join(root, file), '');
    }
    expect(codeFiles(root)).toEqual([
      'b.cjs',
      'c.js',
      'd.mts',
      'e.cts',
      'f.tsx',
      'g.jsx',
      'scripts/a.ts',
      'tests/unit/a.test.ts',
      'tool.config.mjs',
    ]);
  });
});

describe('formatTotals', () => {
  it('prints the untested counts and the percentages they leave', () => {
    expect(
      formatTotals(
        new Map([
          ['a.ts', { statements: 1, branches: 2, statementsTotal: 8, branchesTotal: 4 }],
          ['b.ts', { statements: 0, branches: 0, statementsTotal: 2, branchesTotal: 0 }],
        ]),
      ),
    ).toBe('coverage-record: 2 file(s) measured; 1 of 10 statements untested (90.00% run), 2 of 4 branch arms untested (50.00% run)');
  });

  it('reads an empty population as fully run rather than dividing by zero', () => {
    expect(formatTotals(new Map())).toBe(
      'coverage-record: 0 file(s) measured; 0 of 0 statements untested (100.00% run), 0 of 0 branch arms untested (100.00% run)',
    );
  });
});

describe('main', () => {
  let root: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'coverage-record-main-'));
    mkdirSync(join(root, 'coverage'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/a.ts'), 'export const a = 1;\n');
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    // CI sets CI=true; every case but the CI one runs as the laptop would.
    vi.stubEnv('CI', '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const summary = (statementsCovered: number) => {
    writeFileSync(
      join(root, 'coverage/coverage-summary.json'),
      JSON.stringify({ total: entry(4, statementsCovered, 2, 2), [join(root, 'scripts/a.ts')]: entry(4, statementsCovered, 2, 2) }),
    );
  };
  const record = (statements: number) => {
    writeFileSync(join(root, 'coverage-record.json'), JSON.stringify({ 'scripts/a.ts': { statements, branches: 0 } }));
  };

  it('check passes when the record equals the report, and prints the totals', () => {
    summary(3);
    record(1);
    expect(main(['check'])).toBe(0);
    expect(out.join('')).toContain('1 of 4 statements untested (75.00% run)');
    expect(out.join('')).toContain('coverage-record: the record matches all 1 measured file(s)\n');
    expect(err).toEqual([]);
  });

  it('check fails, naming the file, when a count rose', () => {
    summary(2);
    record(1);
    expect(main(['check'])).toBe(1);
    expect(err.join('')).toBe('coverage-record: scripts/a.ts: untested statements rose from 1 to 2\n');
  });

  it('check fails on a code file the report never measured', () => {
    summary(3);
    record(1);
    writeFileSync(join(root, 'scripts/b.ts'), 'export const b = 1;\n');
    expect(main(['check'])).toBe(1);
    expect(err.join('')).toBe('coverage-record: scripts/b.ts: no suite measured it; a file no test runs counts as unrun\n');
  });

  it('check fails on a skip comment, naming its line', () => {
    summary(3);
    record(1);
    writeFileSync(join(root, 'scripts/a.ts'), `export const a = 1;\n${block(' v8 ignore next ')}\n`);
    expect(main(['check'])).toBe(1);
    expect(err.join('')).toBe('coverage-record: scripts/a.ts:2 tells coverage to skip a line; a skipped line counts as unrun\n');
  });

  it('check fails closed when the report is missing', () => {
    record(1);
    expect(() => main(['check'])).toThrow(
      'coverage-record: no coverage summary at coverage/coverage-summary.json; run npm run test:coverage first',
    );
  });

  it('check fails closed when the record is missing', () => {
    summary(3);
    expect(() => main(['check'])).toThrow('coverage-record: no record at coverage-record.json; run npm run coverage:record on the laptop');
  });

  it('record writes the measured counts and prints each change', () => {
    summary(4);
    record(1);
    expect(main(['record'])).toBe(0);
    expect(readFileSync(join(root, 'coverage-record.json'), 'utf8')).toBe('{\n  "scripts/a.ts": { "statements": 0, "branches": 0 }\n}\n');
    expect(out.join('')).toContain('coverage-record: scripts/a.ts: untested statements 1 -> 0\n');
  });

  it('record starts a record where there is none', () => {
    summary(4);
    expect(main(['record'])).toBe(0);
    expect(out.join('')).toContain('scripts/a.ts: newly recorded at 0 untested statements, 0 untested branch arms');
  });

  it('record says so when nothing changed', () => {
    summary(3);
    record(1);
    expect(main(['record'])).toBe(0);
    expect(out.join('')).toContain('coverage-record: no change; the record already equals the report\n');
  });

  it('record refuses to run in CI, where nothing may raise or move the record', () => {
    summary(4);
    record(1);
    vi.stubEnv('CI', 'true');
    vi.stubEnv('RECORD_RUN', undefined);
    expect(() => main(['record'])).toThrow(
      'coverage-record: record never runs in CI but the record workflow on a scratch ref; record there or on the laptop',
    );
  });

  it.each([['refs/floors/32-x/abc1234'], ['refs/visual/32-x/abc1234']])(
    'record runs in the record workflow on the scratch ref %s',
    (ref) => {
      summary(4);
      record(1);
      vi.stubEnv('CI', 'true');
      vi.stubEnv('RECORD_RUN', ref);
      expect(main(['record'])).toBe(0);
    },
  );

  it.each([['refs/heads/develop'], ['refs/floors/'], ['']])('record still refuses in CI on %j', (ref) => {
    summary(4);
    record(1);
    vi.stubEnv('CI', 'true');
    vi.stubEnv('RECORD_RUN', ref);
    expect(() => main(['record'])).toThrow('coverage-record: record never runs in CI but the record workflow');
  });

  it.each([[[]], [['raise']], [['check', 'extra']]])('refuses the arguments %j', (args) => {
    expect(() => main(args)).toThrow('usage: node scripts/coverage-record.ts check|record');
  });
});
