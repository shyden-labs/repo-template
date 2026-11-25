import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EXCEPTIONS, main, problems, type AuditReport, type AuditException } from '../../scripts/npm-audit.ts';
import { withoutYamlComments } from './source-text.ts';

// npm is stood in: a unit test starts no process.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('../../scripts/tools.ts', () => ({ toolPath: (name: string) => `/fixed/${name}` }));
const spawn = vi.mocked(spawnSync);

/**
 * CI's audit fails on every known vulnerability except an advisory Shyden
 * excepted by name, until its expiry (shyden-labs/repo-template#200; the
 * picomatch fixture below is that ticket's advisory, withdrawn by GitHub on
 * 2026-11-18, so EXCEPTIONS is empty now). An exception that has expired,
 * or that no longer matches anything because the fix landed, fails too, so it
 * is removed rather than left behind.
 */

const PICOMATCH = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const OTHER = 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc';
const exception: AuditException = { advisory: 'GHSA-fc5q-39xc-vjpf', expires: '2026-12-01', ticket: 'shyden-labs/repo-template#200' };
const advisory = (url: string, title = 'a flaw') => ({ source: 1, name: 'picomatch', title, url, severity: 'high', range: '<=4.0.7' });
const report = (...urls: string[]): AuditReport => ({
  vulnerabilities: {
    picomatch: { via: urls.map((url) => advisory(url)) },
    vitest: { via: ['picomatch', 'vite'] },
  },
});
const BEFORE = new Date('2026-11-18T12:00:00Z');

describe('problems', () => {
  it('passes a report whose only advisory is excepted and not yet expired', () => {
    expect(problems(report(PICOMATCH), [exception], BEFORE)).toEqual([]);
  });

  it('passes a clean report with no exceptions', () => {
    expect(problems({ vulnerabilities: {} }, [], BEFORE)).toEqual([]);
  });

  it('fails any advisory that is not excepted, naming it', () => {
    expect(problems(report(PICOMATCH, OTHER), [exception], BEFORE)).toEqual([`not excepted: ${OTHER} (a flaw)`]);
  });

  it('fails every advisory when there are no exceptions', () => {
    expect(problems(report(PICOMATCH), [], BEFORE)).toEqual([`not excepted: ${PICOMATCH} (a flaw)`]);
  });

  it('still passes on the expiry day itself', () => {
    expect(problems(report(PICOMATCH), [exception], new Date('2026-12-01T23:59:59Z'))).toEqual([]);
  });

  it('fails an exception the day after it expires', () => {
    expect(problems(report(PICOMATCH), [exception], new Date('2026-12-02T00:00:00Z'))).toEqual([
      'exception for GHSA-fc5q-39xc-vjpf expired on 2026-12-01 (shyden-labs/repo-template#200)',
    ]);
  });

  it('fails an exception that matches nothing, so it is removed once the fix lands', () => {
    expect(problems({ vulnerabilities: {} }, [exception], BEFORE)).toEqual([
      'exception for GHSA-fc5q-39xc-vjpf matches nothing: remove it (shyden-labs/repo-template#200)',
    ]);
  });

  it('counts an advisory reached through several packages once', () => {
    const twice: AuditReport = {
      vulnerabilities: { picomatch: { via: [advisory(OTHER)] }, tinyglobby: { via: [advisory(OTHER)] } },
    };
    expect(problems(twice, [], BEFORE)).toEqual([`not excepted: ${OTHER} (a flaw)`]);
  });
});

describe('EXCEPTIONS', () => {
  it('holds none: GitHub withdrew the picomatch advisory on 2026-11-18 (#200)', () => {
    expect(EXCEPTIONS).toEqual([]);
  });
});

const result = (over: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> => ({
  pid: 1,
  output: [],
  stdout: '',
  stderr: '',
  status: 0,
  signal: null,
  ...over,
});

describe('main', () => {
  beforeEach(() => {
    spawn.mockReset();
    vi.useFakeTimers({ now: BEFORE });
    return () => vi.useRealTimers();
  });

  it('runs npm audit as JSON and passes a clean report', () => {
    spawn.mockReturnValue(result({ status: 0, stdout: JSON.stringify({ vulnerabilities: {} }) }));
    expect(main()).toBe(0);
    expect(spawn).toHaveBeenCalledWith('/fixed/npm', ['audit', '--json'], expect.objectContaining({ encoding: 'utf8' }));
  });

  it('fails naming each problem', () => {
    spawn.mockReturnValue(result({ status: 1, stdout: JSON.stringify(report(PICOMATCH, OTHER)) }));
    expect(() => main()).toThrow(`npm audit found 2 problem(s):\nnot excepted: ${PICOMATCH} (a flaw)\nnot excepted: ${OTHER} (a flaw)`);
  });

  it('fails when npm did not run', () => {
    spawn.mockReturnValue(result({ error: new Error('ENOENT') }));
    expect(() => main()).toThrow('npm audit did not run: ENOENT');
  });

  it('fails when npm printed no report it could read', () => {
    spawn.mockReturnValue(result({ status: 1, stdout: 'npm error code ENOLOCK' }));
    expect(() => main()).toThrow('npm audit printed no JSON report');
  });

  it('fails when the report has no vulnerabilities section', () => {
    spawn.mockReturnValue(result({ status: 1, stdout: '{"error":{"code":"ENOAUDIT"}}' }));
    expect(() => main()).toThrow('npm audit printed no JSON report');
  });
});

describe('ci.yml', () => {
  it('audits through scripts/npm-audit.ts and nowhere calls npm audit directly', () => {
    const ci = withoutYamlComments(readFileSync('.github/workflows/ci.yml', 'utf8'));
    expect(ci).toContain('run: node scripts/npm-audit.ts');
    expect(ci).not.toMatch(/npm audit\b/);
  });
});
