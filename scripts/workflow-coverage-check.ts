/**
 * The live workflow-coverage check (issue #35, AC5; Shyden 2026-10-27:
 * "Compare live", then "a job that waits"):
 *
 *   node scripts/workflow-coverage-check.ts <head-sha> <base-sha> <base-root>
 *
 * `.github/workflows/workflow-coverage.yml` runs it on every pull request, with
 * the head checked out in the working directory and the commit the head
 * branched from checked out at `<base-root>`. With `GITHUB_REPOSITORY`,
 * `GITHUB_TOKEN` and `GITHUB_RUN_ID` (its own run, which it skips: that run is
 * still going while it measures):
 *
 * 1. It waits until every other run on both commits has completed, naming
 *    what it waits for, and fails at the ceiling naming each run still going.
 * 2. It measures both commits (scripts/workflow-coverage.ts) and fails when any
 *    workflow file leaves more lines unrun on the head than on the base.
 *
 * Workflow files get no entry in coverage-record.json: folding a record amends
 * the commit, so a recorded figure could never equal the runs on the commit
 * that carries it (docs/workflow-lines.md).
 */
import { runIfEntry } from './cli.ts';
import { fetchEvidence, githubApi, runsGoing, unrunRise, workflowCoverage, workflowFiles } from './workflow-coverage.ts';
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
 * what it waits for; at the ceiling it fails, naming each run still going.
 * Nothing that failed is tried again: a run still going is waited for.
 */
export async function waitForRuns(
  going: () => Promise<string[]>,
  clock: Clock,
  patience: Patience,
  log: (line: string) => void,
): Promise<void> {
  const start = clock.now();
  for (;;) {
    const still = await going();
    if (still.length === 0) return;
    const waited = clock.now() - start;
    if (waited >= patience.ceilingMs)
      fail(`still going after ${seconds(waited)}, past the ${seconds(patience.ceilingMs)} ceiling: ${still.join('; ')}`);
    log(`workflow-coverage-check: waiting ${seconds(patience.intervalMs)} on ${still.length} run(s): ${still.join('; ')}`);
    await clock.sleep(patience.intervalMs);
  }
}

const isSha = (sha: string) => /^[0-9a-f]{40}$/.test(sha);

export async function main(args: string[], fetchImpl: typeof fetch = fetch, clock: Clock = realClock): Promise<number> {
  const [head, base, baseRoot, ...rest] = args;
  if (head === undefined || base === undefined || baseRoot === undefined || rest.length > 0)
    throw new Error('usage: node scripts/workflow-coverage-check.ts <head-sha> <base-sha> <base-root>');
  for (const sha of [head, base]) if (!isSha(sha)) fail(`${sha} is not a full commit sha`);
  const repo = process.env.GITHUB_REPOSITORY || fail('GITHUB_REPOSITORY is empty: name the repository as owner/name');
  const token = process.env.GITHUB_TOKEN || fail('GITHUB_TOKEN is empty: the runs and artifacts are read with it');
  const runId = process.env.GITHUB_RUN_ID ?? '';
  if (!/^\d+$/.test(runId)) fail('GITHUB_RUN_ID is not a run id: the check skips its own run with it');
  const self = Number(runId);
  const api = githubApi(token, fetchImpl);
  const out = (line: string) => process.stdout.write(`${line}\n`);

  await waitForRuns(
    async () => [...(await runsGoing(api, repo, head, self)), ...(await runsGoing(api, repo, base, self))],
    clock,
    PATIENCE,
    out,
  );
  const bash = await loadBash();
  const headCoverage = workflowCoverage(bash, await fetchEvidence(api, repo, head, workflowFiles(process.cwd()), self));
  const baseCoverage = workflowCoverage(bash, await fetchEvidence(api, repo, base, workflowFiles(baseRoot), self));

  const unrun = (ran: Map<number, boolean> | undefined) => [...(ran ?? new Map<number, boolean>()).values()].filter((hit) => !hit).length;
  for (const file of [...headCoverage.keys()].sort())
    out(
      `workflow-coverage-check: ${file}: ${unrun(headCoverage.get(file))} lines unrun on the head, ${unrun(baseCoverage.get(file))} on the base`,
    );
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
