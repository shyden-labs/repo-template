/**
 * The live workflow-coverage check (issue #35, AC5; Shyden 2026-10-27:
 * "Compare live", then "a job that waits"):
 *
 *   node scripts/workflow-coverage-check.ts <head-sha> <base-sha> <base-root> <head-branch>
 *
 * `.github/workflows/workflow-coverage.yml` runs it on every pull request, with
 * the head checked out in the working directory and the commit the head
 * branched from checked out at `<base-root>`. With `GITHUB_REPOSITORY`,
 * `GITHUB_TOKEN` and `GITHUB_RUN_ID` (its own run, which it skips: that run is
 * still going while it measures):
 *
 * 1. It waits until every other run on both commits has completed, and until
 *    each hand-started workflow the head must run (scripts/coverage-dispatch.ts,
 *    #35 part 6) has a run on it, naming what it waits for and the command
 *    that starts each missing run. At the ceiling it fails, naming each.
 * 2. It measures both commits (scripts/workflow-coverage.ts) and fails when any
 *    workflow file leaves more lines unrun on the head than on the base. A
 *    hand-started workflow new on the head is left out and named: it cannot
 *    run before it is on develop (Shyden 2026-10-28, ruling 2).
 *
 * Workflow files get no entry in coverage-record.json: folding a record amends
 * the commit, so a recorded figure could never equal the runs on the commit
 * that carries it (docs/workflow-lines.md).
 */
import { readFileSync } from 'node:fs';
import { runIfEntry } from './cli.ts';
import { planDispatch, startCommand, type DispatchPlan } from './coverage-dispatch.ts';
import {
  fetchEvidence,
  githubApi,
  listRuns,
  stillGoing,
  unrunRise,
  workflowCoverage,
  workflowFiles,
  type ListedRun,
} from './workflow-coverage.ts';
import { loadBash } from './workflow-lines.ts';

function fail(message: string): never {
  throw new Error(`workflow-coverage-check: ${message}`);
}

/** The time the wait reads and spends; tests stand in a clock that only moves when it waits. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface Patience {
  ceilingMs: number;
  intervalMs: number;
}

/**
 * Forty minutes: mutations.yml's 30-minute job limit, the longest of any
 * pull-request workflow, plus ten for a runner to pick it up (assumed). The
 * workflow's job limit is five minutes more, to measure.
 */
export const PATIENCE: Patience = { ceilingMs: 40 * 60_000, intervalMs: 15_000 };

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/**
 * Waits until `going` names nothing, asking again every interval and saying
 * what it waits for; at the ceiling it fails, naming each run still going and
 * adding what `advice` says of them. Nothing that failed is tried again: a run
 * still going is waited for.
 */
export async function waitForRuns(
  going: () => Promise<string[]>,
  clock: Clock,
  patience: Patience,
  log: (line: string) => void,
  advice: (still: string[]) => string = () => '',
): Promise<void> {
  const start = clock.now();
  for (;;) {
    const still = await going();
    if (still.length === 0) return;
    const waited = clock.now() - start;
    if (waited >= patience.ceilingMs)
      fail(`still going after ${seconds(waited)}, past the ${seconds(patience.ceilingMs)} ceiling: ${still.join('; ')}${advice(still)}`);
    log(`workflow-coverage-check: waiting ${seconds(patience.intervalMs)} on ${still.length} run(s): ${still.join('; ')}`);
    await clock.sleep(patience.intervalMs);
  }
}

const isSha = (sha: string) => /^[0-9a-f]{40}$/.test(sha);

const NO_RUN = ' has no run on ';

/** The repository a pull_request event's head comes from, or undefined when the event does not name one (a deleted fork). */
function headRepository(event: string): string | undefined {
  const name: unknown = (JSON.parse(event) as { pull_request?: { head?: { repo?: { full_name?: unknown } | null } } }).pull_request?.head
    ?.repo?.full_name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * One line per workflow the plan needs on the head with no run there yet,
 * naming the command that starts it on the head's scratch branch. A run that
 * failed is a run: the comparison judges what it left unrun.
 */
export function missingRuns(plan: DispatchPlan, headRuns: ListedRun[], headSha: string, branch: string): string[] {
  return plan.dispatch
    .filter((path) => !headRuns.some((run) => run.path === path))
    .map((path) => `${path}${NO_RUN}${headSha}: start it with ${startCommand(path, branch, headSha)}`);
}

/** The one re-run Shyden allows (2026-10-28, ruling 3): its input changed, so it is not a retry. */
const afterMissing = (still: string[]) =>
  still.some((line) => line.includes(NO_RUN)) ? '. Start each missing run, then re-run this workflow-coverage job once (#35 ruling 3)' : '';

export async function main(args: string[], fetchImpl: typeof fetch = fetch, clock: Clock = realClock): Promise<number> {
  const [head, base, baseRoot, branch, ...rest] = args;
  if (head === undefined || base === undefined || baseRoot === undefined || branch === undefined || rest.length > 0)
    throw new Error('usage: node scripts/workflow-coverage-check.ts <head-sha> <base-sha> <base-root> <head-branch>');
  for (const sha of [head, base]) if (!isSha(sha)) fail(`${sha} is not a full commit sha`);
  if (branch === '') fail('the head branch is empty; pass "$GITHUB_HEAD_REF"');
  const repo = process.env.GITHUB_REPOSITORY || fail('GITHUB_REPOSITORY is empty: name the repository as owner/name');
  const token = process.env.GITHUB_TOKEN || fail('GITHUB_TOKEN is empty: the runs and artifacts are read with it');
  // Unset reads as "undefined", which the pattern refuses like any other non-number.
  const runId = String(process.env.GITHUB_RUN_ID);
  if (!/^\d+$/.test(runId)) fail('GITHUB_RUN_ID is not a run id: the check skips its own run with it');
  const self = Number(runId);
  const eventPath =
    process.env.GITHUB_EVENT_PATH || fail('GITHUB_EVENT_PATH is empty: the check reads from it whether the pull request comes from a fork');
  const headRepo =
    headRepository(readFileSync(eventPath, 'utf8')) ?? fail(`the event at ${eventPath} names no pull_request.head.repo.full_name`);
  const api = githubApi(token, fetchImpl);
  const out = (line: string) => process.stdout.write(`${line}\n`);

  const headFiles = workflowFiles(process.cwd());
  const baseFiles = workflowFiles(baseRoot);
  let plan: DispatchPlan = { dispatch: [], notMeasurable: [] };
  await waitForRuns(
    async () => {
      const headRuns = await listRuns(api, repo, head);
      const baseRuns = await listRuns(api, repo, base);
      // Read again on every ask: a hand-started run can appear on the base while the check waits.
      plan = planDispatch(headFiles, baseFiles, baseRuns);
      if (headRepo !== repo && plan.dispatch.length > 0)
        fail(
          `this pull request comes from the fork ${headRepo}: ${plan.dispatch.join(', ')} would have to run on its commit with this repository's secrets, and a fork's workflows never are (#35, Shyden 2026-10-28, "Fence it"); Shyden decides`,
        );
      return [...stillGoing(headRuns, self), ...stillGoing(baseRuns, self), ...missingRuns(plan, headRuns, head, branch)];
    },
    clock,
    PATIENCE,
    out,
    afterMissing,
  );
  const bash = await loadBash();
  const headCoverage = workflowCoverage(bash, await fetchEvidence(api, repo, head, headFiles, self));
  const baseCoverage = workflowCoverage(bash, await fetchEvidence(api, repo, base, baseFiles, self));
  for (const file of plan.notMeasurable) headCoverage.delete(file);

  const unrun = (ran: Map<number, boolean> | undefined) => [...(ran ?? new Map<number, boolean>()).values()].filter((hit) => !hit).length;
  for (const file of [...headCoverage.keys()].sort())
    out(
      `workflow-coverage-check: ${file}: ${unrun(headCoverage.get(file))} lines unrun on the head, ${unrun(baseCoverage.get(file))} on the base`,
    );
  for (const file of plan.notMeasurable) out(`workflow-coverage-check: ${file}: not measurable until on develop (#35 ruling 2)`);
  const rises = unrunRise(headCoverage, baseCoverage);
  for (const rise of rises)
    process.stderr.write(
      `workflow-coverage-check: ${rise.file} leaves ${rise.head} lines unrun, ${rise.base} on the base: lines ${rise.unrun.join(', ')}\n`,
    );
  if (rises.length > 0) return 1;
  out(`workflow-coverage-check: no workflow file leaves more lines unrun than on the base ${base}`);
  return 0;
}

await runIfEntry(import.meta.url, main);
