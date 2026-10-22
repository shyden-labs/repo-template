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
import { parseTrace } from './workflow-trace.ts';
import { executableUnits, layout, lcov, ranLines, type Bash, type LayoutStep, type RunStep } from './workflow-lines.ts';

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
        const took = stepRan.has(`${job.id}#${k}`);
        for (const line of step.lines) ran.set(line, took);
        if (!step.run) return;
        const shell = ranLines(executableUnits(bash, step.run.script), traced.get(`${job.id}/${step.run.action}`) ?? new Set());
        for (const [scriptLine, hit] of shell) {
          const line = step.run.firstLine + scriptLine - 1;
          // A plain `run: x` line is the step's and the script's: both must have run.
          ran.set(line, took && hit);
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
