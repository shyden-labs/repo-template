/**
 * Turns one commit's runs into lcov for every workflow file (issue #35, AC2;
 * Shyden 2026-10-22: "a changed workflow line counts as run only if a run on
 * that same commit took it"):
 *
 *   node scripts/workflow-coverage.ts <commit-sha> <out.lcov>
 *
 * It reads every run GitHub made on the commit (GITHUB_REPOSITORY, with
 * GITHUB_TOKEN), each run's jobs and steps over every attempt, and the
 * `workflow-trace-<job>` artifacts the runs uploaded (scripts/workflow-trace.ts),
 * and judges every code line of every file under `.github/workflows`
 * (scripts/workflow-lines.ts, `layout`). Shyden's rulings of 2026-10-22:
 *
 * - The top settings ran when any job of the workflow ran; a job's own lines
 *   when the job ran (some step of it concluded success or failure); a step's
 *   lines when it concluded success or failure in any run or attempt. A
 *   skipped or cancelled step is unrun, and a cancelled step's trace is ignored.
 * - A shell line ran when its step ran and its trace shows it (`ranLines`); a
 *   step that ran with no trace has every shell line unrun.
 * - Runs and attempts are joined: a line ran if any of them took it.
 * - Whatever it cannot line up fails closed, naming it: a run, job or step not
 *   completed, a step conclusion it does not model, a run of a file the commit
 *   lacks, an API job or step list that differs from the file, a trace of a
 *   step that did not run, of no run step, or of another script (a `${{ }}`
 *   expression may change the script, but not its line count).
 *
 * A pull request's runs run the workflow of its merge commit, not its head:
 * the step names and trace hashes catch a file that moved under it, and
 * develop's ruleset requires a branch up to date before merging
 * (`strict_required_status_checks_policy`, read 2026-10-22), so at merge the
 * two hold the same workflow files.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIfEntry } from './cli.ts';
import { parseTrace } from './workflow-trace.ts';
import { executableUnits, layout, lcov, loadBash, ranLines, type Bash, type LayoutStep, type RunStep } from './workflow-lines.ts';
import { readZip } from './zip.ts';

export interface ApiStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface ApiJob {
  name: string;
  status: string;
  conclusion: string | null;
  steps: ApiStep[];
}

export interface RunEvidence {
  id: number;
  path: string;
  status: string;
  /** Every attempt's jobs (`filter=all`). */
  jobs: ApiJob[];
  /** Each trace file of the run's artifacts, by `<job>/<GITHUB_ACTION>`. */
  traces: Map<string, string>;
}

export interface Evidence {
  /** Every workflow file of the commit, by its path, as text. */
  workflows: Map<string, string>;
  runs: RunEvidence[];
}

const RAN = new Set(['success', 'failure']);
const NOT_RUN = new Set(['skipped', 'cancelled']);

function fail(message: string): never {
  throw new Error(`workflow-coverage: ${message}`);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** Each workflow file's code lines, and whether a run on the commit took each. */
export function workflowCoverage(bash: Bash, evidence: Evidence): Map<string, Map<number, boolean>> {
  for (const run of evidence.runs) {
    if (!evidence.workflows.has(run.path) && !run.path.startsWith('dynamic/')) {
      fail(`run ${run.id} is of ${run.path}, which this commit has no file for`);
    }
  }
  const result = new Map<string, Map<number, boolean>>();
  for (const [path, text] of [...evidence.workflows].sort(([a], [b]) => a.localeCompare(b))) {
    const { top, jobs } = layout(text);
    const jobRan = new Set<string>();
    /** `<job>#<step index>` of each step that ran. */
    const stepRan = new Set<string>();
    /** The lines each run step's traces show, joined over runs. */
    const traced = new Map<string, Set<number>>();
    for (const run of evidence.runs.filter((r) => r.path === path)) {
      if (run.status !== 'completed') fail(`run ${run.id} of ${path} is ${run.status}, not completed`);
      const at = `run ${run.id}`;
      const ranHere = new Set<string>();
      const cancelledHere = new Set<string>();
      for (const apiJob of run.jobs) {
        if (apiJob.status !== 'completed') fail(`${at}: job ${apiJob.name} is ${apiJob.status}, not completed`);
        const job =
          jobs.find((j) => j.id === apiJob.name) ?? fail(`${at}: the API reports job ${apiJob.name}, which ${path} does not define`);
        if (apiJob.steps.length === 0) continue;
        const steps = [...apiJob.steps].sort((a, b) => a.number - b.number);
        const first = (steps[0] as ApiStep).name;
        const last = (steps.at(-1) as ApiStep).name;
        if (first !== 'Set up job') fail(`${at}: job ${job.id} starts with "${first}", not "Set up job"`);
        if (last !== 'Complete job') fail(`${at}: job ${job.id} ends with "${last}", not "Complete job"`);
        const listed = steps.slice(1, -1);
        listed.forEach((step, k) => {
          const expected = job.steps[k];
          if (expected !== undefined && step.name !== expected.apiName) {
            fail(
              `${at}: job ${job.id} step ${k + 2} is "${step.name}" in the API and "${expected.apiName}" in the file; the reader cannot line them up (name the step, or teach the reader this shape)`,
            );
          }
          if (expected === undefined && !step.name.startsWith('Post ')) {
            fail(
              `${at}: job ${job.id} step ${k + 2} is "${step.name}", after the file’s ${job.steps.length} steps; only Post steps and Complete job may follow`,
            );
          }
        });
        if (listed.length < job.steps.length) {
          fail(`${at}: job ${job.id} lists ${listed.length} steps between Set up job and Complete job; the file has ${job.steps.length}`);
        }
        for (const step of steps) {
          const conclusion = String(step.conclusion);
          if (step.status !== 'completed') fail(`${at}: job ${job.id} step ${step.name} is ${step.status}, not completed`);
          if (!RAN.has(conclusion) && !NOT_RUN.has(conclusion)) {
            fail(
              `${at}: job ${job.id} step ${step.name} concluded ${conclusion}; the reader models success, failure, skipped and cancelled`,
            );
          }
          if (RAN.has(conclusion)) jobRan.add(job.id);
        }
        listed.slice(0, job.steps.length).forEach((step, k) => {
          if (RAN.has(String(step.conclusion))) ranHere.add(`${job.id}#${k}`);
          if (step.conclusion === 'cancelled') cancelledHere.add(`${job.id}#${k}`);
        });
      }
      for (const key of ranHere) stepRan.add(key);
      for (const [key, traceText] of run.traces) {
        const parts = key.split('/');
        if (parts.length !== 2) fail(`${at}: trace ${key} is not <job>/<step>`);
        const [jobId, action] = parts as [string, string];
        const job = jobs.find((j) => j.id === jobId) ?? fail(`${at}: trace ${key} is of job ${jobId}, which ${path} does not define`);
        const k = job.steps.findIndex((s) => s.run?.action === action);
        if (k === -1) fail(`${at}: trace ${key} names no run step of job ${jobId}`);
        const step = job.steps[k] as LayoutStep;
        const runStep = step.run as RunStep;
        if (!ranHere.has(`${jobId}#${k}`)) {
          if (cancelledHere.has(`${jobId}#${k}`)) continue;
          fail(`${at}: trace ${key} is of step ${step.apiName}, which did not run`);
        }
        const parsed = parseTrace(traceText);
        const sameScript =
          parsed.sha === sha256(runStep.text) || (runStep.text.includes('${{') && parsed.lineCount === runStep.script.length);
        if (!sameScript) fail(`${at}: trace ${key} is of another script than step ${k + 1} of job ${jobId} in ${path}`);
        const lines = traced.get(key) ?? new Set<number>();
        for (const line of parsed.traced) lines.add(line);
        traced.set(key, lines);
      }
    }
    const ran = new Map<number, boolean>();
    for (const line of top) ran.set(line, jobRan.size > 0);
    for (const job of jobs) {
      for (const line of job.lines) ran.set(line, jobRan.has(job.id));
      job.steps.forEach((step, k) => {
        for (const line of step.lines) ran.set(line, stepRan.has(`${job.id}#${k}`));
        if (!step.run) return;
        const shell = ranLines(executableUnits(bash, step.run.script), traced.get(`${job.id}/${step.run.action}`) ?? new Set());
        for (const [scriptLine, hit] of shell) {
          const line = step.run.firstLine + scriptLine - 1;
          // A trace is read only from a run in which its step ran, so a traced line's step ran too.
          ran.set(line, hit);
        }
      });
    }
    result.set(path, new Map([...ran].sort(([a], [b]) => a - b)));
  }
  return result;
}

/** The lcov records of every workflow file, in path order. */
export function workflowLcov(coverage: Map<string, Map<number, boolean>>): string {
  return [...coverage]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, ran]) => lcov(file, ran))
    .join('');
}

/** The GitHub REST calls the reader makes: JSON, and the bytes of an artifact's zip. */
export interface Api {
  json(path: string): Promise<unknown>;
  bytes(path: string): Promise<Uint8Array>;
}

const PAGE = 100;
const TRACE_ARTIFACT = 'workflow-trace-';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** One page of a list the API returns; more than one page fails closed rather than reading part of it. */
function onePage(value: unknown, key: string, path: string): Record<string, unknown>[] {
  if (!isObject(value) || typeof value.total_count !== 'number' || !Array.isArray(value[key])) fail(`${path} answered no ${key} list`);
  const items = value[key] as unknown[];
  if (value.total_count > items.length) fail(`${path} lists ${value.total_count} ${key}; one page of ${PAGE} was read`);
  return items.map((item) => (isObject(item) ? item : fail(`${path} lists a ${key} entry that is not an object`)));
}

const field = <T>(item: Record<string, unknown>, key: string, is: (v: unknown) => v is T, path: string): T =>
  is(item[key]) ? item[key] : fail(`${path} lists an entry with no ${key}`);
const isNumber = (v: unknown): v is number => typeof v === 'number';
const isString = (v: unknown): v is string => typeof v === 'string';
const isConclusion = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** Every run GitHub made on `sha`, with every attempt's jobs and steps and the traces its artifacts hold. */
export async function fetchEvidence(api: Api, repo: string, sha: string, workflows: Map<string, string>): Promise<Evidence> {
  const runsPath = `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=${PAGE}`;
  const runs: RunEvidence[] = [];
  for (const item of onePage(await api.json(runsPath), 'workflow_runs', runsPath)) {
    const id = field(item, 'id', isNumber, runsPath);
    const path = field(item, 'path', isString, runsPath);
    const status = field(item, 'status', isString, runsPath);
    if (path.startsWith('dynamic/')) continue;
    const jobsPath = `/repos/${repo}/actions/runs/${id}/jobs?filter=all&per_page=${PAGE}`;
    const jobs = onePage(await api.json(jobsPath), 'jobs', jobsPath).map((job) => ({
      name: field(job, 'name', isString, jobsPath),
      status: field(job, 'status', isString, jobsPath),
      conclusion: field(job, 'conclusion', isConclusion, jobsPath),
      steps: (Array.isArray(job.steps) ? job.steps : fail(`${jobsPath} lists a job with no steps list`)).map((step: unknown) => {
        const s = isObject(step) ? step : fail(`${jobsPath} lists a step that is not an object`);
        return {
          number: field(s, 'number', isNumber, jobsPath),
          name: field(s, 'name', isString, jobsPath),
          status: field(s, 'status', isString, jobsPath),
          conclusion: field(s, 'conclusion', isConclusion, jobsPath),
        };
      }),
    }));
    const artifactsPath = `/repos/${repo}/actions/runs/${id}/artifacts?per_page=${PAGE}`;
    const traces = new Map<string, string>();
    for (const artifact of onePage(await api.json(artifactsPath), 'artifacts', artifactsPath)) {
      const name = field(artifact, 'name', isString, artifactsPath);
      if (!name.startsWith(TRACE_ARTIFACT)) continue;
      if (artifact.expired !== false) fail(`run ${id}: artifact ${name} has expired; re-run the run to measure this commit`);
      const job = name.slice(TRACE_ARTIFACT.length);
      const zip = readZip(await api.bytes(`/repos/${repo}/actions/artifacts/${field(artifact, 'id', isNumber, artifactsPath)}/zip`));
      for (const [entry, text] of zip) {
        const parts = entry.split('/');
        if (parts.length !== 2 || parts[0] !== job) fail(`run ${id}: artifact ${name} holds ${entry}, not ${job}/<step>`);
        if (traces.has(entry)) fail(`run ${id}: two artifacts hold ${entry}`);
        traces.set(entry, text);
      }
    }
    runs.push({ id, path, status, jobs, traces });
  }
  return { workflows, runs };
}

/** The REST API with a token, over `fetchImpl`; anything but a 2xx answer fails, naming it. */
export function githubApi(token: string, fetchImpl: typeof fetch = fetch): Api {
  const get = async (path: string) => {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) fail(`GET ${path} answered ${response.status}`);
    return response;
  };
  return {
    json: async (path): Promise<unknown> => (await get(path)).json(),
    bytes: async (path) => new Uint8Array(await (await get(path)).arrayBuffer()),
  };
}

const WORKFLOWS = '.github/workflows';

/** Every workflow file under `.github/workflows`, read from the filesystem, by its repo path. */
export function workflowFiles(root: string): Map<string, string> {
  const files = readdirSync(join(root, WORKFLOWS))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  return new Map(files.map((name) => [`${WORKFLOWS}/${name}`, readFileSync(join(root, WORKFLOWS, name), 'utf8')]));
}

export async function main(args: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const [sha, out, ...rest] = args;
  if (sha === undefined || out === undefined || rest.length > 0)
    throw new Error('usage: node scripts/workflow-coverage.ts <commit-sha> <out.lcov>');
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`${sha} is not a full commit sha`);
  const repo = process.env.GITHUB_REPOSITORY || fail('GITHUB_REPOSITORY is empty: name the repository as owner/name');
  const token = process.env.GITHUB_TOKEN || fail('GITHUB_TOKEN is empty: the runs and artifacts are read with it');
  const evidence = await fetchEvidence(githubApi(token, fetchImpl), repo, sha, workflowFiles(process.cwd()));
  const coverage = workflowCoverage(await loadBash(), evidence);
  writeFileSync(out, workflowLcov(coverage));
  let ran = 0;
  let lines = 0;
  for (const [file, map] of coverage) {
    const hit = [...map.values()].filter(Boolean).length;
    ran += hit;
    lines += map.size;
    process.stdout.write(`workflow-coverage: ${file}: ${hit} of ${map.size} lines ran\n`);
  }
  process.stdout.write(
    `workflow-coverage: ${ran} of ${lines} workflow lines ran on ${sha}, over ${evidence.runs.length} run(s); lcov in ${out}\n`,
  );
  return 0;
}

await runIfEntry(import.meta.url, main);
