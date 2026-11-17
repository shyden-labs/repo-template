import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { withoutPinnedShas, withoutYamlComments, yamlBlock } from './source-text.ts';
import { scanWithoutVerdict, swallowed, tokenGated } from './workflow-honesty.ts';

/**
 * A check is green only if it ran and passed (Shyden 2026-10-18: "don't pass
 * if it doesn't run"; issue shyden-labs/repo-template#27). No workflow swallows a failure, no step runs
 * only when the SonarCloud token is missing, and a scan is always followed by
 * the step that reads its verdict. Each form is planted below and watched red.
 */

const WORKFLOWS = '.github/workflows';
const files = readdirSync(WORKFLOWS)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();
const read = (f: string) => readFileSync(`${WORKFLOWS}/${f}`, 'utf8');

describe('every workflow', () => {
  it('is judged', () => {
    expect(files).toEqual(['check-release-cut.yml', 'ci.yml', 'deploy-dev.yml', 'sonarcloud.yml']);
  });

  it.each(files)('%s swallows no failure and gates no step on the token', (file) => {
    expect([...swallowed(file, read(file)), ...tokenGated(file, read(file))]).toEqual([]);
  });
});

/** Each job of a workflow, by id, as its own text (comments dropped). */
const jobsOf = (text: string): Record<string, string> => {
  const body = withoutYamlComments(text).split(/^jobs:\n/m)[1] ?? '';
  return Object.fromEntries(
    body
      .split(/^(?= {2}[\w-]+:\n)/m)
      .filter((chunk) => /^ {2}[\w-]+:\n/.test(chunk))
      .map((chunk) => [chunk.slice(2, chunk.indexOf(':')), chunk]),
  );
};

// Issue shyden-labs/repo-template#193: the token never shares a job with a dependency install or
// the branch's own code. One job installs and runs the coverage suite holding no secret, and hands
// on only coverage/lcov.info; the scan job keeps the id `sonarcloud`, the required check's name.
describe('sonarcloud.yml keeps the token away from installed code', () => {
  const jobs = jobsOf(read('sonarcloud.yml'));

  it('has a coverage job and a scan job', () => {
    expect(Object.keys(jobs)).toEqual(['coverage-report', 'sonarcloud']);
  });

  it('runs the coverage suite holding no secret, handing on only coverage/lcov.info', () => {
    const job = withoutPinnedShas(jobs['coverage-report'] ?? '');
    expect({
      secrets: job.includes('secrets.'),
      environment: job.includes('environment:'),
      runsSuite: job.includes('      - run: npm run test:coverage\n'),
      upload: job.includes(
        [
          '      - uses: actions/upload-artifact@<sha>',
          '        with:',
          '          name: coverage-lcov',
          '          path: coverage/lcov.info',
          '          if-no-files-found: error',
        ].join('\n'),
      ),
    }).toEqual({ secrets: false, environment: false, runsSuite: true, upload: true });
  });

  it('scans in a fresh checkout that runs no npm, reading the token from the sonarcloud environment', () => {
    const job = withoutPinnedShas(jobs.sonarcloud ?? '');
    expect({
      npm: /\bnpm\b/.test(job),
      needs: job.includes('    needs: coverage-report\n'),
      environment: job.includes('    environment: sonarcloud\n'),
      download: job.includes(
        [
          '      - uses: actions/download-artifact@<sha>',
          '        with:',
          '          name: coverage-lcov',
          '          path: coverage',
        ].join('\n'),
      ),
      host: job.includes('            -Dsonar.host.url=https://sonarcloud.io\n'),
    }).toEqual({ npm: false, needs: true, environment: true, download: true, host: true });
  });

  it('fails first when the token is missing, naming the key and where it is set', () => {
    expect(withoutPinnedShas(jobs.sonarcloud ?? '')).toContain(
      [
        '    steps:',
        '      - name: The SonarCloud token is set',
        '        env:',
        '          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}',
        '        run: |',
        '          if [ -z "$SONAR_TOKEN" ]; then',
        '            echo "::error title=SONAR_TOKEN is missing::Set SONAR_TOKEN in the sonarcloud environment, and as a Dependabot secret for Dependabot pull requests (docs/sonarcloud.md)."',
        '            exit 1',
        '          fi',
        '      - uses: actions/checkout@<sha>',
      ].join('\n'),
    );
  });

  // The docs (reusing-workflows, read 2026-11-17): the caller must still pass the secret, or an
  // environment secret resolves to an empty string in the called workflow, with no error.
  it("is called with the caller's secrets passed on", () => {
    expect(read('ci.yml')).toContain(
      '    uses: ./.github/workflows/sonarcloud.yml\n    with:\n      organization: shyden-labs\n      project-key: shyden-labs_repo-template\n    secrets: inherit\n',
    );
  });
});

// SonarCloud's githubactions:S8264 (PR shyden-labs/repo-template#194): a permission granted at
// workflow level reaches every job. Each workflow grants nothing at its top; each job is granted
// only what it uses.
describe('every workflow grants permissions per job, least first', () => {
  it.each(files)('%s grants nothing at workflow level', (file) => {
    expect(
      read(file)
        .split('\n')
        .filter((line) => line.startsWith('permissions:')),
    ).toEqual(['permissions: {}']);
  });

  it.each([
    ['check-release-cut.yml', 'judge-release-cut', ['contents: read', 'statuses: write']],
    ['ci.yml', 'build-and-test', ['contents: read']],
    ['ci.yml', 'coverage', ['contents: read']],
    ['ci.yml', 'sonarcloud', ['contents: read', 'pull-requests: read']],
    ['deploy-dev.yml', 'deploy-dev', ['contents: read']],
    ['sonarcloud.yml', 'coverage-report', ['contents: read']],
    ['sonarcloud.yml', 'sonarcloud', ['contents: read', 'pull-requests: read']],
  ])('%s job %s is granted %j', (file, job, grants) => {
    expect(yamlBlock(jobsOf(read(file))[job] ?? '', 'permissions', '    ')).toBe(
      ['    permissions:', ...grants.map((g) => `      ${g}`)].join('\n'),
    );
  });

  it('judges every job of every workflow', () => {
    expect(files.flatMap((file) => Object.keys(jobsOf(read(file))).map((job) => `${file} ${job}`))).toEqual([
      'check-release-cut.yml judge-release-cut',
      'ci.yml build-and-test',
      'ci.yml coverage',
      'ci.yml sonarcloud',
      'deploy-dev.yml deploy-dev',
      'sonarcloud.yml coverage-report',
      'sonarcloud.yml sonarcloud',
    ]);
  });
});

describe('sonarcloud.yml', () => {
  it('scans, then reads the verdict of that scan', () => {
    const text = read('sonarcloud.yml');
    expect({ scans: text.includes('SonarSource/sonarqube-scan-action@'), problems: scanWithoutVerdict('sonarcloud.yml', text) }).toEqual({
      scans: true,
      problems: [],
    });
  });

  // Issue shyden-labs/repo-template#164: without these, the scanner judged tests/ and the config files as
  // uncovered source, failing the coverage gate of a fully covered pull request.
  // Issue shyden-labs/repo-template#187: sonar.tests without sonar.sources left the scanner indexing
  // tests/ alone, so from 2026-10-31 the gate passed on no source code at all.
  it('scans tests as tests and judges coverage only on what the unit suite measures', () => {
    expect(read('sonarcloud.yml')).toContain(
      [
        '            -Dsonar.javascript.lcov.reportPaths=coverage/lcov.info',
        '            -Dsonar.sources=.',
        '            -Dsonar.tests=tests',
        '            -Dsonar.exclusions=tests/**',
        '            -Dsonar.coverage.exclusions=eslint.config.js,vitest.unit.config.ts',
      ].join('\n'),
    );
  });
});

describe('the checks', () => {
  it.each([
    ['|| true on a test command', '      - run: npm run test:coverage || true'],
    ['|| exit 0 on a scan', '        run: sonar-scanner || exit 0'],
    ['|| : on a step', '        run: npm test || :'],
    ['continue-on-error', '        continue-on-error: true'],
  ])('names %s', (_kind, line) => {
    expect(swallowed('w.yml', `steps:\n${line}\n`)).toEqual([`w.yml:2 swallows a failure: ${line.trim()}`]);
  });

  it('reads a comment naming || true as nothing', () => {
    expect(swallowed('w.yml', 'steps:\n  # never write || true here\n')).toEqual([]);
  });

  it('names a step that runs only on an empty token', () => {
    expect(tokenGated('w.yml', "steps:\n      - if: env.SONAR_TOKEN == ''\n        run: echo skipped\n")).toEqual([
      "w.yml:2 gates a step on the token: - if: env.SONAR_TOKEN == ''",
    ]);
  });

  it('names a scan with no verdict step after it', () => {
    expect(scanWithoutVerdict('w.yml', 'steps:\n      - uses: SonarSource/sonarqube-scan-action@abc\n')).toEqual([
      'w.yml scans, but no step after it runs scripts/sonar-verdict.ts',
    ]);
  });

  it('names a verdict step that comes before the scan', () => {
    expect(
      scanWithoutVerdict(
        'w.yml',
        'steps:\n      - run: node scripts/sonar-verdict.ts x\n      - uses: SonarSource/sonarqube-scan-action@abc\n',
      ),
    ).toEqual(['w.yml scans, but no step after it runs scripts/sonar-verdict.ts']);
  });

  it('passes a workflow that does not scan', () => {
    expect(scanWithoutVerdict('w.yml', 'steps:\n      - run: npm ci\n')).toEqual([]);
  });
});
