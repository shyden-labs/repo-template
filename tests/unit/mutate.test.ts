import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, judge, main, nonUnitTest, parseMutationFile, SUITES, verdict, type MutationFile, type Row } from '../../scripts/mutate.ts';

/**
 * The mutations check (issue #21; Shyden 2026-10-16: "mutation testing is
 * vital. we need it", "it must be run"). A pull request that adds or changes
 * a non-unit test file carries a mutation file targeting it; every mutation
 * file it adds or changes runs, each target clean first, each anchor matching
 * exactly once, each row judged against its written prediction, every file
 * put back. `git` and the suites are stood in: no process starts.
 */

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));
const git = vi.mocked(execFileSync);
const suite = vi.mocked(spawnSync);

const RED: Row = { name: 'drops the timestamp', path: 'src/writer.ts', anchor: 'at: now()', replacement: 'at: 0', predict: { red: ['stamps each line'] } };
const GREEN: Row = { name: 'an equivalent rename', path: 'src/writer.ts', anchor: 'const line', replacement: 'const entry', predict: { green: true } };
const FILE: MutationFile = { targets: ['tests/logs/writer.test.ts'], suite: 'logs', mutations: [RED, GREEN] };

describe('SUITES', () => {
  it('lists every non-unit suite with the folder it holds and the command that runs it', () => {
    expect(SUITES).toEqual({ logs: { dir: 'tests/logs/', config: 'vitest.logs.config.ts' } });
  });
});

describe('nonUnitTest', () => {
  it.each([['tests/logs/writer.test.ts'], ['tests/logs/deep/a.test.mjs']])('counts %s', (path) => {
    expect(nonUnitTest(path)).toBe(true);
  });

  it.each([['tests/unit/writer.test.ts'], ['tests/logs/helpers.ts'], ['src/writer.ts'], ['tests/logsx/a.test.ts']])('does not count %s', (path) => {
    expect(nonUnitTest(path)).toBe(false);
  });
});

describe('parseMutationFile', () => {
  it('reads a mutation file', () => {
    expect(parseMutationFile(JSON.stringify(FILE), 'mutations/a.json')).toEqual(FILE);
  });

  const broken = (over: object) => JSON.stringify({ ...FILE, ...over });
  const row = (over: object) => JSON.stringify({ ...FILE, mutations: [{ ...RED, ...over }] });
  it.each([
    ['not JSON', '{', 'is not JSON'],
    ['not an object', '[]', 'is not a JSON object'],
    ['no targets', broken({ targets: [] }), 'targets must list the non-unit test files it proves'],
    ['a target that is not a non-unit test', broken({ targets: ['tests/unit/a.test.ts'] }), 'tests/unit/a.test.ts is not a non-unit test file'],
    ['an unknown suite', broken({ suite: 'e2e' }), 'suite e2e is not one of logs'],
    ['a key it does not know', broken({ extra: 1 }), 'has keys it does not know: extra'],
    ['no mutations', broken({ mutations: [] }), 'mutations must hold at least one row'],
    ['a row with no anchor', row({ anchor: '' }), 'row 1 needs a name, a path, an anchor and a replacement'],
    ['a row whose replacement changes nothing', row({ replacement: 'at: now()' }), 'row 1 (drops the timestamp) replaces its anchor with itself'],
    ['a row predicting red with no tests', row({ predict: { red: [] } }), 'row 1 (drops the timestamp) must predict { "red": [named tests] } or { "green": true }'],
    ['a row predicting both', row({ predict: { red: ['x'], green: true } }), 'row 1 (drops the timestamp) must predict { "red": [named tests] } or { "green": true }'],
  ])('refuses %s', (_kind, text, message) => {
    expect(() => parseMutationFile(text, 'mutations/a.json')).toThrow(`mutate: mutations/a.json ${message}`);
  });
});

describe('judge', () => {
  it('passes a pull request touching no non-unit test, saying how many paths it judged', () => {
    expect(judge(['README.md', 'tests/unit/a.test.ts'], [])).toEqual({ judged: 2, missing: [] });
  });

  it('names each changed non-unit test no changed mutation file targets', () => {
    expect(judge(['tests/logs/writer.test.ts', 'tests/logs/reader.test.ts', 'mutations/a.json'], [FILE])).toEqual({
      judged: 3,
      missing: ['tests/logs/reader.test.ts'],
    });
  });
});

describe('apply', () => {
  it('replaces an anchor that appears exactly once', () => {
    expect(apply('a at: now() b', RED)).toBe('a at: 0 b');
  });

  it.each([['never', 'a b', 0], ['twice', 'at: now() at: now()', 2]])('refuses an anchor that appears %s', (_kind, text, count) => {
    expect(() => apply(text, RED)).toThrow(
      `mutate: row "drops the timestamp": its anchor appears ${count} times in src/writer.ts, not exactly once`,
    );
  });
});

describe('verdict', () => {
  const run = (failed: string[], total = 5) => ({ failed, total });

  it('accepts red with every named test failing and no other', () => {
    expect(verdict(RED, run(['writer > stamps each line']), 5)).toBe('');
  });

  it('accepts green with nothing failing', () => {
    expect(verdict(GREEN, run([]), 5)).toBe('');
  });

  it.each([
    ['a predicted red that stayed green', RED, run([]), 'predicted red (stamps each line), but nothing failed'],
    ['a predicted test that did not fail', RED, run(['writer > other']), 'predicted stamps each line to fail; failed instead: writer > other'],
    ['a failure nobody predicted', RED, run(['writer > stamps each line', 'writer > other']), 'failed too, unpredicted: writer > other'],
    ['a predicted green that went red', GREEN, run(['writer > other']), 'predicted green, but failed: writer > other'],
    ['a moved test total', GREEN, run([], 4), 'ran 4 tests, not the clean 5: tests were dropped or added'],
  ])('names %s', (_kind, row, result, problem) => {
    expect(verdict(row, result, 5)).toBe(problem);
  });
});

describe('main', () => {
  let root: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    git.mockReset();
    suite.mockReset();
    root = mkdtempSync(join(tmpdir(), 'mutate-'));
    mkdirSync(join(root, 'mutations'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/writer.ts'), 'const line = { at: now() };\n');
    out = [];
    err = [];
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.spyOn(process.stdout, 'write').mockImplementation((t) => (out.push(String(t)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((t) => (err.push(String(t)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  /** One suite run: writes vitest's JSON report where the runner asked for it. */
  const report = (failed: string[], total = 5) =>
    suite.mockImplementationOnce((_cmd, args) => {
      const results = [...failed.map((f) => ({ fullName: f, status: 'failed' })), ...Array.from({ length: total - failed.length }, () => ({ fullName: 'ok', status: 'passed' }))];
      // Written at each --outputFile the runner passed; with none, the run reads no report and fails.
      for (const arg of (args as string[]).filter((a) => a.startsWith('--outputFile='))) {
        writeFileSync(arg.slice('--outputFile='.length), JSON.stringify({ numTotalTests: total, testResults: [{ assertionResults: results }] }));
      }
      return { status: failed.length > 0 ? 1 : 0 } as never;
    });
  const changed = (...paths: string[]) => git.mockReturnValueOnce(`${paths.join('\n')}\n`);

  it.each([[[]], [['pr']], [['pr', 'origin/develop', 'x']], [['run']], [['other']]])('refuses the arguments %j', (args) => {
    expect(() => main(args)).toThrow('usage: node scripts/mutate.ts pr <base-ref> | run <mutation-file>...');
  });

  it('passes a pull request touching no non-unit test and no mutation file, at once', () => {
    changed('README.md');
    expect(main(['pr', 'origin/develop'])).toBe(0);
    expect(git).toHaveBeenCalledWith('git', ['diff', '--name-only', '--diff-filter=AMR', 'origin/develop...HEAD'], { encoding: 'utf8' });
    expect(suite).not.toHaveBeenCalled();
    expect(out).toEqual(['mutate: judged 1 changed path(s); 0 non-unit test file(s), 0 mutation file(s)\n']);
  });

  it('fails a pull request that changes a non-unit test with no mutation file, naming it', () => {
    changed('tests/logs/writer.test.ts');
    expect(main(['pr', 'origin/develop'])).toBe(1);
    expect(err).toEqual(['mutate: tests/logs/writer.test.ts changed, but no mutation file in this pull request targets it\n']);
  });

  it('runs each changed mutation file: clean first, each row planted, judged and put back', () => {
    writeFileSync(join(root, 'mutations/a.json'), JSON.stringify(FILE));
    changed('tests/logs/writer.test.ts', 'mutations/a.json');
    report([]);
    report(['writer > stamps each line']);
    report([]);
    expect(main(['pr', 'origin/develop'])).toBe(0);
    expect(readFileSync(join(root, 'src/writer.ts'), 'utf8')).toBe('const line = { at: now() };\n');
    expect(suite.mock.calls.map((c) => (c[1] as string[]).slice(0, 5))).toEqual([
      ['vitest', 'run', '--config', 'vitest.logs.config.ts', 'tests/logs/writer.test.ts'],
      ['vitest', 'run', '--config', 'vitest.logs.config.ts', 'tests/logs/writer.test.ts'],
      ['vitest', 'run', '--config', 'vitest.logs.config.ts', 'tests/logs/writer.test.ts'],
    ]);
    expect(out.slice(1)).toEqual([
      'mutate: mutations/a.json: clean, 5 test(s)\n',
      'mutate: mutations/a.json: drops the timestamp: as predicted\n',
      'mutate: mutations/a.json: an equivalent rename: as predicted\n',
    ]);
  });

  it('fails a row not as predicted, naming it, and still puts the file back', () => {
    writeFileSync(join(root, 'mutations/a.json'), JSON.stringify(FILE));
    report([]);
    report([]);
    report([]);
    expect(main(['run', 'mutations/a.json'])).toBe(1);
    expect(err).toEqual(['mutate: mutations/a.json: drops the timestamp: predicted red (stamps each line), but nothing failed\n']);
    expect(readFileSync(join(root, 'src/writer.ts'), 'utf8')).toBe('const line = { at: now() };\n');
  });

  it('puts the file back when the suite cannot even start', () => {
    writeFileSync(join(root, 'mutations/a.json'), JSON.stringify(FILE));
    report([]);
    suite.mockImplementationOnce(() => {
      throw new Error('spawn npx ENOENT');
    });
    expect(() => main(['run', 'mutations/a.json'])).toThrow('spawn npx ENOENT');
    expect(readFileSync(join(root, 'src/writer.ts'), 'utf8')).toBe('const line = { at: now() };\n');
  });

  it('refuses a target that is red before anything is planted', () => {
    writeFileSync(join(root, 'mutations/a.json'), JSON.stringify(FILE));
    report(['writer > stamps each line']);
    expect(() => main(['run', 'mutations/a.json'])).toThrow(
      'mutate: mutations/a.json: the targets are red before any mutation: writer > stamps each line',
    );
  });

  it('refuses a suite run that wrote no report', () => {
    writeFileSync(join(root, 'mutations/a.json'), JSON.stringify(FILE));
    suite.mockImplementationOnce(() => ({ status: 1 }) as never);
    expect(() => main(['run', 'mutations/a.json'])).toThrow('mutate: the logs suite wrote no report (exit 1); it did not run');
  });
});
