import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, phoneTotals } from '../../scripts/devices-report.ts';

/**
 * The per-phone report of a device run (issue #26): every phone ran the same
 * number of tests, none skipped and none failed, and a phone whose input is a
 * stand-in is marked as one, never reported as equal to real taps.
 */

const project = (name: string, input = 'real') => ({ name, metadata: { phone: name.replace(/-.*/, ''), input } });
const spec = (title: string, ...tests: [string, string][]) => ({
  title,
  tests: tests.map(([projectName, status]) => ({ projectName, status })),
});
const report = (projects: ReturnType<typeof project>[], specs: ReturnType<typeof spec>[]) => ({
  config: { projects: [...projects, { name: 'desktop-chrome', metadata: {} }] },
  // A file's suite holds only nested suites; each group holds only specs: both shapes Playwright writes.
  suites: [{ title: 'a.spec.ts', suites: [{ title: 'first', specs: specs.slice(0, 1) }, { title: 'group', specs: specs.slice(1) }] }],
});
const PHONES = [project('android-chrome'), project('ios-safari')];

describe('phoneTotals', () => {
  it('counts each phone project, across nested suites, leaving other projects out', () => {
    const r = report(PHONES, [
      spec('signs in', ['android-chrome', 'expected'], ['ios-safari', 'expected'], ['desktop-chrome', 'expected']),
      spec('pays', ['android-chrome', 'unexpected'], ['ios-safari', 'skipped']),
    ]);
    expect(phoneTotals(r)).toEqual([
      { name: 'android-chrome', input: 'real', tests: 2, failed: 1, skipped: 0 },
      { name: 'ios-safari', input: 'real', tests: 2, failed: 0, skipped: 1 },
    ]);
  });

  it('counts a flaky test as failed: it did not pass first time', () => {
    const r = report(PHONES, [spec('x', ['android-chrome', 'flaky'], ['ios-safari', 'expected'])]);
    expect(phoneTotals(r)[0]).toEqual({ name: 'android-chrome', input: 'real', tests: 1, failed: 1, skipped: 0 });
  });
});

describe('main', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devices-report-'));
    out = [];
    err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((t) => (out.push(String(t)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((t) => (err.push(String(t)), true));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = (r: object) => {
    const path = join(dir, 'report.json');
    writeFileSync(path, JSON.stringify(r));
    return main([path]);
  };

  it.each([[[]], [['a.json', 'b.json']]])('refuses the arguments %j', (args) => {
    expect(() => main(args)).toThrow('usage: node scripts/devices-report.ts <playwright-json-report>');
  });

  it('passes when every phone ran the same tests, all passing, and prints each phone', () => {
    expect(run(report(PHONES, [spec('x', ['android-chrome', 'expected'], ['ios-safari', 'expected'])]))).toBe(0);
    expect(out).toEqual(['devices-report: android-chrome (real taps): 1 test(s), 0 failed, 0 skipped\n', 'devices-report: ios-safari (real taps): 1 test(s), 0 failed, 0 skipped\n']);
    expect(err).toEqual([]);
  });

  it('reads a phone that does not say its input mode as a stand-in', () => {
    run({ ...report([], []), config: { projects: [{ name: 'android-chrome', metadata: { phone: 'android' } }] }, suites: [{ specs: [spec('x', ['android-chrome', 'expected'])] }] });
    expect(out).toEqual(['devices-report: android-chrome (STAND-IN, weaker than real taps): 1 test(s), 0 failed, 0 skipped\n']);
  });

  it('marks a stand-in phone in every line, never as equal to real taps', () => {
    run(report([project('android-chrome'), project('ios-safari', 'stand-in')], [spec('x', ['android-chrome', 'expected'], ['ios-safari', 'expected'])]));
    expect(out[1]).toBe('devices-report: ios-safari (STAND-IN, weaker than real taps): 1 test(s), 0 failed, 0 skipped\n');
  });

  it.each([
    ['a phone that ran fewer tests', [spec('x', ['android-chrome', 'expected'], ['ios-safari', 'expected']), spec('y', ['android-chrome', 'expected'])], 'ios-safari ran 1 test(s), not the 2 another phone ran'],
    ['a phone that skipped a test', [spec('x', ['android-chrome', 'expected'], ['ios-safari', 'skipped'])], 'ios-safari skipped 1 test(s): a step a phone cannot take is raised, never skipped'],
    ['a phone with a failure', [spec('x', ['android-chrome', 'unexpected'], ['ios-safari', 'expected'])], 'android-chrome failed 1 test(s)'],
    ['a phone that ran nothing', [spec('x', ['ios-safari', 'expected'])], 'android-chrome ran no tests'],
  ])('fails, naming it, on %s', (_kind, specs, problem) => {
    expect(run(report(PHONES, specs))).toBe(1);
    expect(err).toContain(`devices-report: ${problem}\n`);
  });

  it('fails closed on a report with no phone projects', () => {
    expect(() => run(report([], [spec('x', ['desktop-chrome', 'expected'])]))).toThrow(
      'devices-report: the report names no phone project (metadata.phone); refusing to judge nothing',
    );
  });
});
