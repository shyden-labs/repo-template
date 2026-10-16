import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutYamlComments, withoutYamlQuotes } from './source-text';
import unitConfig from '../../vitest.unit.config';
import logsConfig from '../../vitest.logs.config';

/**
 * Logging and auditing have a test suite of their own, run in CI as a
 * prerequisite to a release (operator 2026-10-16, every project; Refs #16).
 * The configs are imported, so what is judged is what vitest resolves, not
 * how the file reads. The workflows are read as comment-stripped source
 * text, as `supply-chain.test.ts` reads them: no YAML parser is available.
 */

const scripts = (): Record<string, string> =>
  (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
const workflow = (file: string): string =>
  withoutYamlQuotes(withoutYamlComments(readFileSync(`.github/workflows/${file}`, 'utf8')));
const usesLines = (text: string): string[] =>
  text.split('\n').filter((line) => /^\s*-?\s*uses:/.test(line)).map((line) => line.trim().replace(/^-\s*/, ''));
const readme = () => readFileSync('README.md', 'utf8');

describe('the unit suite', () => {
  it('collects tests under tests/unit only', () => {
    expect(unitConfig.test?.include).toEqual(['tests/unit/**/*.test.ts']);
  });

  it('is what npm run test:unit runs', () => {
    expect(scripts()['test:unit']).toBe('vitest run --config vitest.unit.config.ts');
  });
});

describe('the logs suite', () => {
  it('collects tests under tests/logs only, and fails when it holds none, so a release gate cannot pass on nothing', () => {
    // An exact object: `passWithNoTests` (or anything else) added to it is red.
    expect(logsConfig.test).toEqual({ include: ['tests/logs/**/*.test.ts'] });
  });

  it('is what npm run test:logs runs', () => {
    expect(scripts()['test:logs']).toBe('vitest run --config vitest.logs.config.ts');
  });
});

describe('the logs workflow', () => {
  it('is started by a person on the release ref or called by a release pipeline, never by a pull request or a push', () => {
    const on = workflow('logs.yml').match(/^on:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? '';
    const triggers = on
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim().replace(/:.*$/, ''));
    expect(triggers).toEqual(['workflow_dispatch', 'workflow_call']);
  });

  it('runs the logs suite', () => {
    expect(workflow('logs.yml').split('\n').map((line) => line.trim())).toContain('- run: npm run test:logs');
  });

  it('installs from the lock file before it runs the suite', () => {
    const lines = workflow('logs.yml').split('\n').map((line) => line.trim());
    const install = lines.indexOf('- run: npm ci');
    expect([install > -1, lines.indexOf('- run: npm run test:logs') > install]).toEqual([true, true]);
  });

  it('stops within 30 minutes when a step hangs, not GitHub’s default 360', () => {
    const minutes = workflow('logs.yml').match(/^ {4}timeout-minutes: (\d+)$/m)?.[1];
    expect(Number(minutes)).toBeGreaterThan(0);
    expect(Number(minutes)).toBeLessThanOrEqual(30);
  });

  it('pins the same actions at the same SHAs as ci.yml', () => {
    const logs = usesLines(readFileSync('.github/workflows/logs.yml', 'utf8'));
    expect(logs.length).toBe(2);
    expect(logs).toEqual(usesLines(readFileSync('.github/workflows/ci.yml', 'utf8')));
  });
});

describe('pull-request CI', () => {
  it('never runs the logs suite', () => {
    expect(workflow('ci.yml')).not.toMatch(/test:logs|vitest\.logs\.config/);
  });

  it('still runs the unit suite (the control for the absence above)', () => {
    expect(workflow('ci.yml').split('\n').map((line) => line.trim())).toContain('- run: npm run test:unit');
  });
});

describe('a new repository', () => {
  it('reads why the logs suite exists, in the operator’s words', () => {
    const doc = readFileSync('docs/logs-suite.md', 'utf8');
    expect(doc).toContain(
      '*"by the way. this should be the case for all projects, not just this one. separate test suite for logging and auditing. run in ci as a pre-requisite to a release"*',
    );
  });

  it('finds the logs suite’s files in the README’s file table', () => {
    expect(readme()).toContain(
      '| `docs/logs-suite.md`, `vitest.logs.config.ts`, `vitest.unit.config.ts`, `.github/workflows/logs.yml` |',
    );
  });

  it('is told to fill the logs suite and gate its release on it before its first release', () => {
    expect(readme()).toContain(
      '8. **Before the first release, put the log and audit checks in `tests/logs/`** and make `.github/workflows/logs.yml` a required step of the release (`docs/logs-suite.md`).',
    );
  });
});
