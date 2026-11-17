import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseReportTask, verdict } from '../../scripts/sonar-verdict.ts';

/**
 * SonarCloud's quality gate, read for the analysis this run's scan made
 * (issue shyden-labs/repo-template#27; Shyden's ruling of 2026-10-18: a scan that does not run fails, and
 * the results are checked, failing the workflow when the gate fails). Green only on OK;
 * every other answer, and every answer that cannot be read, fails by name.
 * HTTP and the wait are stood in: nothing reaches the network.
 */

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(() => Promise.resolve()) }));
const waited = vi.mocked(sleep);

const REPORT = [
  'projectKey=shyden-labs_app',
  'serverUrl=https://sonarcloud.io',
  'dashboardUrl=https://sonarcloud.io/dashboard?id=x&pullRequest=7',
  'ceTaskId=AX1',
].join('\n');

describe('parseReportTask', () => {
  it("reads the scan's task id, server and dashboard", () => {
    expect(parseReportTask(REPORT)).toEqual({
      serverUrl: 'https://sonarcloud.io',
      ceTaskId: 'AX1',
      dashboardUrl: 'https://sonarcloud.io/dashboard?id=x&pullRequest=7',
    });
  });

  it.each([['ceTaskId'], ['serverUrl'], ['dashboardUrl']])('refuses a report with no %s', (key) => {
    const text = REPORT.split('\n')
      .filter((l) => !l.startsWith(`${key}=`))
      .join('\n');
    expect(() => parseReportTask(text)).toThrow(`sonar-verdict: the scan's report-task.txt has no ${key}; the scan did not finish`);
  });
});

describe('verdict', () => {
  it('passes OK', () => {
    expect(verdict({ status: 'OK', conditions: [] })).toEqual({ ok: true, lines: ['quality gate: OK'] });
  });

  it('fails ERROR, naming each failed condition with its value and threshold', () => {
    expect(
      verdict({
        status: 'ERROR',
        conditions: [
          { status: 'ERROR', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '85', actualValue: '82.5' },
          { status: 'OK', metricKey: 'new_bugs', comparator: 'GT', errorThreshold: '0', actualValue: '0' },
          { status: 'ERROR', metricKey: 'new_violations', comparator: 'GT', actualValue: '3' },
        ],
      }),
    ).toEqual({
      ok: false,
      lines: ['quality gate: ERROR', 'new_coverage is 82.5, which fails LT 85', 'new_violations is 3, which fails GT (no threshold given)'],
    });
  });

  it('fails ERROR even when no condition is listed', () => {
    expect(verdict({ status: 'ERROR' })).toEqual({ ok: false, lines: ['quality gate: ERROR'] });
  });

  it.each([['WARN'], ['NONE'], [undefined]])('fails the status %s, which is not a pass', (status) => {
    expect(verdict(status === undefined ? { conditions: [] } : { status, conditions: [] })).toEqual({
      ok: false,
      lines: [`quality gate: ${String(status)}, not OK`],
    });
  });
});

describe('main', () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let fetched: string[];
  beforeEach(() => {
    waited.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'sonar-verdict-'));
    writeFileSync(join(dir, 'report-task.txt'), REPORT);
    out = [];
    err = [];
    fetched = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((t) => (out.push(String(t)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((t) => (err.push(String(t)), true));
    // Every variable the reader reads is set here: CI sets GITHUB_STEP_SUMMARY in every job,
    // and a test that inherits it judges (and writes to) the runner's own summary.
    vi.stubEnv('SONAR_TOKEN', 'tok');
    vi.stubEnv('SONAR_PULL_REQUEST', '7');
    vi.stubEnv('SONAR_CEILING_SECONDS', '');
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Answers each GET in turn with the given status and JSON body, recording the URL and the token sent. */
  const answer = (...replies: [number, unknown][]) => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: { headers: { Authorization: string } }) => {
        fetched.push(`${url} ${init.headers.Authorization}`);
        const [status, body] = replies.shift() as [number, unknown];
        return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(body) });
      }),
    );
  };
  const task = (status: string, over: object = {}) =>
    [200, { task: { id: 'AX1', status, analysisId: 'AN1', pullRequest: '7', ...over } }] as [number, unknown];
  const gate = (status: string, conditions: object[] = []) => [200, { projectStatus: { status, conditions } }] as [number, unknown];
  const run = () => main([join(dir, 'report-task.txt')]);

  it.each([[[]], [['a', 'b']]])('refuses the arguments %j', async (args) => {
    await expect(main(args)).rejects.toThrow('usage: node scripts/sonar-verdict.ts <.scannerwork/report-task.txt>');
  });

  it('fails, naming the key and where it is set, when the token is missing', async () => {
    vi.stubEnv('SONAR_TOKEN', '');
    await expect(run()).rejects.toThrow(
      'sonar-verdict: SONAR_TOKEN is empty; set it in the sonarcloud environment, and as a Dependabot secret for Dependabot pull requests (docs/sonarcloud.md)',
    );
  });

  // Issue shyden-labs/repo-template#193: the token goes to SonarCloud alone, whatever server
  // report-task.txt names; a rewritten report cannot send it elsewhere.
  it.each(['https://evil.example', 'http://sonarcloud.io', 'https://sonarcloud.io.evil.example', 'https://sonarcloud.io/', ''])(
    'refuses the server %j before sending the token anywhere',
    async (server) => {
      writeFileSync(join(dir, 'report-task.txt'), REPORT.replace('serverUrl=https://sonarcloud.io', `serverUrl=${server}`));
      answer(task('SUCCESS'), gate('OK'));
      await expect(run()).rejects.toThrow(
        `sonar-verdict: report-task.txt names the server ${JSON.stringify(server)}, not https://sonarcloud.io; the token is sent to SonarCloud only`,
      );
      expect(fetched).toEqual([]);
    },
  );

  it("reads this scan's task, then the gate of the analysis it made, and passes OK", async () => {
    answer(task('SUCCESS'), gate('OK'));
    expect(await run()).toBe(0);
    expect(fetched).toEqual([
      'https://sonarcloud.io/api/ce/task?id=AX1 Bearer tok',
      'https://sonarcloud.io/api/qualitygates/project_status?analysisId=AN1 Bearer tok',
    ]);
    expect(out).toEqual(['sonar-verdict: quality gate: OK\n', 'sonar-verdict: https://sonarcloud.io/dashboard?id=x&pullRequest=7\n']);
  });

  it('fails closed, saying the scan did not run, when it wrote no report', async () => {
    await expect(main([join(dir, 'missing.txt')])).rejects.toThrow(
      `sonar-verdict: no report-task.txt at ${join(dir, 'missing.txt')}: the scan did not run`,
    );
  });

  it("writes the verdict and the link to the job's summary", async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(dir, 'summary.md'));
    answer(task('SUCCESS'), gate('OK'));
    await run();
    expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toBe(
      '### SonarCloud\n\nThe scan ran. quality gate: OK\n\nhttps://sonarcloud.io/dashboard?id=x&pullRequest=7\n',
    );
  });

  it("writes why there is no verdict to the job's summary, then fails", async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', join(dir, 'summary.md'));
    answer(task('FAILED', { errorMessage: 'boom' }));
    await expect(run()).rejects.toThrow('ended FAILED');
    expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toBe(
      '### SonarCloud\n\nNo verdict: sonar-verdict: task AX1 ended FAILED (boom); no verdict to read\n',
    );
  });

  it('waits for a pending task within the ceiling, five seconds at a time', async () => {
    answer(task('PENDING'), task('IN_PROGRESS'), task('SUCCESS'), gate('OK'));
    expect(await run()).toBe(0);
    expect(waited.mock.calls).toEqual([[5000], [5000]]);
  });

  it('fails closed, naming the status, when the task is still pending at the ceiling', async () => {
    vi.stubEnv('SONAR_CEILING_SECONDS', '10');
    answer(task('PENDING'), task('PENDING'), task('PENDING'));
    await expect(run()).rejects.toThrow('sonar-verdict: task AX1 is still PENDING after 10 s; no verdict to read');
  });

  it('fails ERROR, naming each failed condition', async () => {
    answer(
      task('SUCCESS'),
      gate('ERROR', [{ status: 'ERROR', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '85', actualValue: '82.5' }]),
    );
    expect(await run()).toBe(1);
    expect(err).toEqual(['sonar-verdict: quality gate: ERROR\n', 'sonar-verdict: new_coverage is 82.5, which fails LT 85\n']);
  });

  it('fails closed on a task that failed or was cancelled', async () => {
    answer(task('FAILED', { errorMessage: 'Fail to extract report' }));
    await expect(run()).rejects.toThrow('sonar-verdict: task AX1 ended FAILED (Fail to extract report); no verdict to read');
  });

  it('fails closed on a task cancelled with no message', async () => {
    answer(task('CANCELED'));
    await expect(run()).rejects.toThrow('sonar-verdict: task AX1 ended CANCELED; no verdict to read');
  });

  it('fails closed on a task with no analysis', async () => {
    answer(task('SUCCESS', { analysisId: undefined }));
    await expect(run()).rejects.toThrow('sonar-verdict: task AX1 made no analysis; no verdict to read');
  });

  it("fails closed on a task for another pull request's analysis", async () => {
    answer(task('SUCCESS', { pullRequest: '6' }));
    await expect(run()).rejects.toThrow('sonar-verdict: task AX1 analysed pull request 6, not 7: a verdict for another commit');
  });

  // A branch analysis (a push to develop) is the whole project, so it must have indexed source files.
  // A pull request analysis counts only the files the PR changed (PR 189 counted 1), so a docs-only
  // PR has no `files` measure at all and is judged by its gate alone (shyden-labs/repo-template#191).
  const branchTask = () => task('SUCCESS', { pullRequest: undefined, componentKey: 'shyden-labs_x', branch: 'develop' });
  const files = (value?: string) =>
    [200, { component: { measures: value === undefined ? [] : [{ metric: 'files', value }] } }] as [number, unknown];

  it('passes a branch analysis that indexed source files, reading the files of that branch', async () => {
    vi.stubEnv('SONAR_PULL_REQUEST', '');
    answer(branchTask(), files('22'), gate('OK'));
    expect(await run()).toBe(0);
    expect(fetched[1]).toBe(
      'https://sonarcloud.io/api/measures/component?component=shyden-labs_x&branch=develop&metricKeys=files Bearer tok',
    );
  });

  it.each([
    ['0', 'files is 0'],
    [undefined, 'no files measure'],
  ])('fails closed on a branch analysis that indexed no source files (files %s)', async (value, why) => {
    vi.stubEnv('SONAR_PULL_REQUEST', '');
    answer(branchTask(), files(value));
    await expect(run()).rejects.toThrow(
      `sonar-verdict: analysis AN1 of branch develop indexed no source files (${why}); check sonar.sources, the gate passes on nothing`,
    );
  });

  it('judges a pull request analysis by its gate alone, as a docs-only PR has no files measure', async () => {
    answer(task('SUCCESS'), gate('OK'));
    expect(await run()).toBe(0);
    expect(fetched.some((f) => f.includes('/api/measures/'))).toBe(false);
  });

  it('fails closed on an API error reading the files of a branch', async () => {
    vi.stubEnv('SONAR_PULL_REQUEST', '');
    answer(branchTask(), [500, {}]);
    await expect(run()).rejects.toThrow(
      'sonar-verdict: GET https://sonarcloud.io/api/measures/component?component=shyden-labs_x&branch=develop&metricKeys=files answered 500; no verdict to read',
    );
  });

  it.each([
    ['the task', [[401, {}]], 'sonar-verdict: GET https://sonarcloud.io/api/ce/task?id=AX1 answered 401; no verdict to read'],
    [
      'the gate',
      [task('SUCCESS'), [404, {}]],
      'sonar-verdict: GET https://sonarcloud.io/api/qualitygates/project_status?analysisId=AN1 answered 404; no verdict to read',
    ],
  ])('fails closed on an API error reading %s', async (_what, replies, message) => {
    answer(...(replies as [number, unknown][]));
    await expect(run()).rejects.toThrow(message);
  });
});

// Issue shyden-labs/repo-template#193: the scan job runs no npm, so the reader holding the token
// loads Node's built-ins and this repository's own files, never an installed package.
describe('what the reader loads', () => {
  // Every form that loads a module: `import … from`, a bare `import '…'`, and `import('…')`.
  const importsOf = (file: string) =>
    [...readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'|^import\s+'([^']+)'|\bimport\(\s*'([^']+)'/gm)].map(
      (m) => m[1] ?? m[2] ?? m[3],
    );

  it.each(['scripts/sonar-verdict.ts', 'scripts/cli.ts'])('%s imports only node: built-ins and the reader itself', (file) => {
    expect(importsOf(file).filter((spec) => !spec?.startsWith('node:') && spec !== './cli.ts')).toEqual([]);
  });
});
