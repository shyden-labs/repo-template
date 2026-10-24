import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutPinnedShas, withoutYamlComments, withoutYamlQuotes } from './source-text.ts';
import coverageConfig from '../../vitest.coverage.config.ts';

/**
 * One coverage tool, wired the same way in every repo made from the template
 * (issue #32; ONE COVERAGE TOOL, Shyden 2026-10-21): Vitest's own V8 provider,
 * pinned to the exact Vitest version so the two never drift, run as its own
 * command with the 1 s unit step left without coverage, and checked against
 * the committed record in its own CI job.
 */

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { version?: string }>;
};
const yaml = (file: string) => withoutPinnedShas(withoutYamlQuotes(withoutYamlComments(readFileSync(file, 'utf8'))));

describe('the coverage tool is pinned to the exact Vitest version', () => {
  it('names an exact Vitest version', () => {
    expect(pkg.devDependencies.vitest).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('names the same exact version of @vitest/coverage-v8', () => {
    expect(pkg.devDependencies['@vitest/coverage-v8']).toBe(pkg.devDependencies.vitest);
  });

  it('locks Vitest at that version', () => {
    expect(lock.packages['node_modules/vitest']?.version).toBe(pkg.devDependencies.vitest);
  });

  it('locks @vitest/coverage-v8 at that version', () => {
    expect(lock.packages['node_modules/@vitest/coverage-v8']?.version).toBe(pkg.devDependencies.vitest);
  });
});

describe('the commands', () => {
  it('runs the unit step without coverage', () => {
    expect(pkg.scripts['test:unit']).toBe('vitest run --config vitest.unit.config.ts');
  });

  it('measures every TypeScript and JavaScript file, tests included, with the V8-based provider, writing lcov and a summary', () => {
    expect(pkg.scripts['test:coverage']).toBe(
      "vitest run --config vitest.coverage.config.ts --coverage.enabled --coverage.provider=custom --coverage.customProviderModule=./scripts/coverage-provider.ts --coverage.include='**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx}' --coverage.reporter=json-summary --coverage.reporter=lcov --coverage.reporter=text-summary",
    );
  });

  it('runs the integration suite on its own config, with no limit inside it', () => {
    expect(pkg.scripts['test:integration']).toBe('vitest run --config vitest.integration.config.ts');
  });

  it('measures the unit and integration suites together, each on its own files', () => {
    expect(coverageConfig.test.projects).toEqual([
      // The refusals, without the unit limits' judges and 1 s timeouts, which instrumented code would trip (#92).
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          pool: 'forks',
          setupFiles: ['tests/setup/unit-refusal.ts', 'tests/setup/load.ts'],
        },
      },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] } },
    ]);
  });

  it('records the measured counts with the record script', () => {
    expect(pkg.scripts['coverage:record']).toBe('node scripts/coverage-record.ts record');
  });
});

describe('CI', () => {
  it('runs the coverage command and checks the record in its own job', () => {
    expect(yaml('.github/workflows/ci.yml')).toContain(
      [
        '  coverage:',
        '    runs-on: ubuntu-26.04',
        '    steps:',
        '      - uses: actions/checkout@<sha>',
        '      - uses: actions/setup-node@<sha>',
        '        with:',
        '          node-version-file: .nvmrc',
        '          cache: npm',
        '      - run: npm ci',
        '      - run: npm run test:coverage',
        '      - run: node scripts/coverage-record.ts check',
      ].join('\n'),
    );
  });
});

describe('Dependabot moves the pair together', () => {
  const npmBlock = () => {
    const text = yaml('.github/dependabot.yml');
    return text.slice(text.indexOf('package-ecosystem: npm'), text.indexOf('package-ecosystem: github-actions'));
  };

  it('has an npm block to read', () => {
    expect(npmBlock()).toContain('package-ecosystem: npm');
  });

  it('groups Vitest and its packages into one pull request', () => {
    expect(npmBlock()).toContain(['      vitest:', '        patterns:', '          - vitest', '          - @vitest/*'].join('\n'));
  });

  it('keeps them out of the patch catch-all, which would otherwise score higher for a patch bump', () => {
    expect(npmBlock()).toContain(
      [
        '      patch-updates:',
        '        update-types:',
        '          - patch',
        '        exclude-patterns:',
        '          - vitest',
        '          - @vitest/*',
      ].join('\n'),
    );
  });
});
