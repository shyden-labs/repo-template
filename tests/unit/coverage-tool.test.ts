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

// The coverage run holds the integration suite, and the laptop runs only unit
// tests, formatters, linters and type checks (Shyden 2026-10-09), so the docs
// send measuring and recording to CI (#109).
describe('the docs measure and record coverage in CI, never on the laptop', () => {
  it('says so in README step 10', () => {
    expect(readFileSync('README.md', 'utf8')).toContain(
      '10. **Keep coverage recorded.** Coverage is measured in CI, never on the laptop: `npm run test:coverage` also runs the integration suite. Push your commit to a scratch ref, start the record workflow (`record.yml`) on it, fold its record into the commit with `node scripts/fold-record.ts <run-id>`, then push once; `docs/measure-then-commit.md` has the steps.',
    );
  });

  it('says where each command runs in docs/coverage.md', () => {
    expect(readFileSync('docs/coverage.md', 'utf8')).toContain(
      [
        'Coverage is off in the 1 s unit step (`npm run test:unit`) and runs as its',
        'own command, in CI only: it runs the integration suite too, and the laptop',
        'runs only unit tests, formatters, linters and type checks (Shyden,',
        '2026-10-09). The record workflow records, and the laptop folds its record',
        'into the commit (`docs/measure-then-commit.md`):',
        '',
        '```sh',
        'npm run test:coverage                   # CI: writes coverage/lcov.info and coverage/coverage-summary.json',
        "node scripts/coverage-record.ts check   # CI's coverage job",
        'npm run coverage:record                 # the record workflow, on a scratch ref: writes coverage-record.json',
        "node scripts/fold-record.ts <run-id>    # the laptop: folds that run's record into the commit",
        '```',
      ].join('\n'),
    );
  });

  it('records a gain through the record workflow in docs/coverage.md', () => {
    expect(readFileSync('docs/coverage.md', 'utf8')).toContain(
      [
        '- The record must **equal** what was measured, so a gain is recorded in the',
        '  pull request that earns it: record it with the record workflow and fold',
        '  it into the commit with the change.',
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
