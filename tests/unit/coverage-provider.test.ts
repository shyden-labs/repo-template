import { describe, it, expect } from 'vitest';
import v8 from '@vitest/coverage-v8';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';
import provider, { AllCodeProvider, EXCLUDE } from '../../scripts/coverage-provider.ts';

/**
 * Tests are code too (Shyden 2026-10-22), but Vitest always adds the test
 * files, setup files and config file to `coverage.exclude`, and its source says
 * user config cannot override that. The custom provider keeps everything V8
 * does and replaces only that list. The stand-in context below is what Vitest
 * hands a provider once it has added its own exclusions.
 */

const ROOT = '/repo';
const INCLUDE = ['**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}'];

function vitestContext(version: string, warnings: string[] = []) {
  return {
    version,
    _coverageOptions: {
      include: INCLUDE,
      // What Vitest's config resolution forces in: the test include pattern and node_modules.
      exclude: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', '**/node_modules/**'],
      reportsDirectory: 'coverage',
    },
    config: { root: ROOT, project: [] },
    projects: [],
    logger: { warn: (message: string) => void warnings.push(message) },
  };
}

function initialized<T extends V8CoverageProvider>(p: T): T {
  const warnings: string[] = [];
  p.initialize(vitestContext(p.version, warnings) as never);
  expect(warnings).toEqual([]);
  return p;
}

describe('the coverage provider', () => {
  it('hands Vitest the all-code provider', async () => {
    expect(await provider.getProvider()).toBeInstanceOf(AllCodeProvider);
  });

  it("keeps V8's own hooks for starting and taking coverage in each worker", () => {
    expect(provider.startCoverage).toBe(v8.startCoverage);
    expect(provider.takeCoverage).toBe(v8.takeCoverage);
    expect(provider.stopCoverage).toBe(v8.stopCoverage);
  });

  it("keeps V8's warning when Vitest and the provider are different versions", () => {
    const warnings: string[] = [];
    new AllCodeProvider().initialize(vitestContext('0.0.0', warnings) as never);
    expect(warnings.join('')).toContain('Running mixed versions is not supported');
  });

  it('excludes only dependencies, what tools write, and virtual modules', () => {
    expect(initialized(new AllCodeProvider()).options.exclude).toEqual(EXCLUDE);
  });

  it('measures a test file', () => {
    expect(initialized(new AllCodeProvider()).isIncluded(`${ROOT}/tests/unit/a.test.ts`)).toBe(true);
  });

  it('control: plain V8 leaves that test file out', () => {
    expect(initialized(new V8CoverageProvider()).isIncluded(`${ROOT}/tests/unit/a.test.ts`)).toBe(false);
  });

  it('measures a script', () => {
    expect(initialized(new AllCodeProvider()).isIncluded(`${ROOT}/scripts/a.ts`)).toBe(true);
  });

  it.each([['node_modules/x/index.js'], ['coverage/prettify.js'], ['src/virtual:entry.ts'], ['src/__x00__id.ts']])(
    'leaves out %s',
    (file) => {
      expect(initialized(new AllCodeProvider()).isIncluded(`${ROOT}/${file}`)).toBe(false);
    },
  );
});
