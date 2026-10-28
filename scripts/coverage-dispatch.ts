/**
 * Which hand-started workflows a pull request runs on its own commit (issue
 * #35, AC4; Shyden 2026-10-27: every one that ran on the base commit, plus
 * every one the pull request changes, and never deploy-dev, whose
 * pull-request rehearsal covers it).
 *
 * A hand-started run is stamped with the commit at the tip of the branch it
 * was started on, so the session pushes its finished commit to the scratch
 * branch `coverage/<branch>/<short-sha>`, which starts no run, and starts each
 * of these workflows there before pushing the pull request
 * (docs/measure-then-commit.md). `scripts/workflow-coverage-check.ts` reads
 * the same plan, waits for those runs and judges them.
 *
 * A workflow new in the pull request cannot be started before it is on the
 * default branch (GitHub answers 404), so a new one that runs only by hand,
 * by schedule or when called is left out of the comparison and named
 * (Shyden 2026-10-28, ruling 2).
 *
 *   node scripts/coverage-dispatch.ts <head-sha> <base-sha> <base-root> <branch>
 *
 * With the head checked out in the working directory, the base at
 * `<base-root>`, and `GITHUB_REPOSITORY` and `GITHUB_TOKEN` to read the base's
 * runs, it prints the `gh workflow run` line for each workflow to start on
 * `coverage/<branch>/<sha7>`, then each new one it cannot start.
 */
import { basename } from 'node:path';
import { runIfEntry } from './cli.ts';
import { githubApi, listRuns, workflowFiles } from './workflow-coverage.ts';

function fail(message: string): never {
  throw new Error(`coverage-dispatch: ${message}`);
}

/** Never started from a pull request: deploy-dev's rehearsal runs on every pull request instead. A project adds its own deploy workflows here. */
export const NEVER_DISPATCHED: readonly string[] = ['.github/workflows/deploy-dev.yml'];

/** The events that start a run by hand or by clock: a base run of either means the head runs it too. */
const HAND_EVENTS = new Set(['workflow_dispatch', 'schedule']);

/** One page of a GitHub list; a longer list fails closed rather than being read in part. */
const PAGE = 100;

/** Triggers that never fire on a pull request: a new workflow with only these cannot run on it. */
const NOT_ON_PR = new Set(['workflow_dispatch', 'schedule', 'workflow_call']);

const isCode = (line: string) => line.trim() !== '' && !line.trimStart().startsWith('#');
const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Each trigger of a workflow, with the lines nested under it. It reads the
 * block style the template writes, an inline `on: name` and an inline
 * `on: [a, b]`, and refuses anything else, naming the file.
 */
export function triggerBlocks(workflow: string, file: string): Map<string, string[]> {
  const lines = workflow.split('\n');
  const at = lines.findIndex((line) => /^on:(?:\s|$)/.test(line));
  if (at === -1) fail(`${file}: no top-level on: line`);
  const rest = (lines[at] as string)
    .slice('on:'.length)
    .replace(/(?:^|\s)#.*$/, '')
    .trim();
  if (rest.startsWith('{')) fail(`${file}: on: is written as a flow mapping`);
  if (rest.startsWith('[')) {
    if (!rest.endsWith(']')) fail(`${file}: on: is a list not closed on its line`);
    const names = rest
      .slice(1, -1)
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== '');
    if (names.length === 0) fail(`${file}: on: names no trigger`);
    return new Map(names.map((name) => [name, []]));
  }
  if (rest !== '') return new Map([[rest, []]]);
  const block = new Map<string, string[]>();
  let child = -1;
  let current: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!isCode(line)) continue;
    const indent = indentOf(line);
    if (indent === 0) break;
    if (child === -1) child = indent;
    if (indent > child) {
      current.push(line);
      continue;
    }
    const key = /^\s*([\w-]+):(?:\s|$)/.exec(line)?.[1];
    if (indent < child || key === undefined) fail(`${file}: on: holds a line it does not read: ${line.trim()}`);
    current = [];
    block.set(key, current);
  }
  if (block.size === 0) fail(`${file}: on: names no trigger`);
  return block;
}

/** The triggers of a workflow, by name. */
export function triggers(workflow: string, file: string): Set<string> {
  return new Set(triggerBlocks(workflow, file).keys());
}

/** A run that GitHub made on the base commit, by its workflow file and the event that started it. */
export interface BaseRun {
  path: string;
  event: string;
}

export interface DispatchPlan {
  /** The workflows that must run on the head, sorted. */
  dispatch: string[];
  /** The workflows new in the pull request that cannot run on it, left out of the comparison (ruling 2), sorted. */
  notMeasurable: string[];
}

/**
 * The plan for one pull request, from every workflow file of the head and of
 * the base (by repository path) and the runs on the base. It fails, naming
 * the file, on a hand-started workflow it could not start safely or at all.
 */
export function planDispatch(head: Map<string, string>, base: Map<string, string>, baseRuns: BaseRun[]): DispatchPlan {
  const dispatch: string[] = [];
  const notMeasurable: string[] = [];
  for (const [path, text] of [...head].sort(([a], [b]) => a.localeCompare(b))) {
    const on = triggerBlocks(text, path);
    if (!on.has('workflow_dispatch') && !on.has('schedule')) continue;
    if (NEVER_DISPATCHED.includes(path)) continue;
    if (text.split('\n').some((line) => isCode(line) && /^\s*environment:/.test(line)))
      fail(
        `${path} is hand-started and names an environment: add it to NEVER_DISPATCHED, where a rehearsal must cover it, or drop the environment`,
      );
    const before = base.get(path);
    if (before === undefined) {
      if ([...on.keys()].every((name) => NOT_ON_PR.has(name))) notMeasurable.push(path);
      continue;
    }
    const ranOnBase = baseRuns.some((run) => run.path === path && HAND_EVENTS.has(run.event));
    if (!ranOnBase && before === text) continue;
    const manual = on.get('workflow_dispatch');
    if (manual === undefined) fail(`${path} must run on the pull request's commit but has no workflow_dispatch: add workflow_dispatch`);
    if (manual.some((line) => /^\s*required:\s*true(?:\s|$)/.test(line)))
      fail(`${path} must run on the pull request's commit but needs a dispatch input: give every input a default`);
    dispatch.push(path);
  }
  return { dispatch, notMeasurable };
}

/**
 * What may be printed into a command a person will paste. A pull request
 * from a fork names its own branch, and git allows `;`, `$`, `|` and
 * backticks in one, so anything else is refused rather than printed.
 */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** The command that starts `path` on the head's scratch branch, `coverage/<branch>/<sha7>`. */
export function startCommand(path: string, branch: string, head: string): string {
  const file = basename(path);
  for (const [what, value, plain] of [
    ['workflow file', file, PLAIN],
    ['branch', branch, PLAIN],
    ['commit', head, /^[0-9a-f]{40}$/],
  ] as const)
    if (!plain.test(value))
      fail(`the ${what} ${JSON.stringify(value)} holds characters a pasted command would run; start its runs by hand`);
  return `gh workflow run ${file} --ref coverage/${branch}/${head.slice(0, 7)}`;
}

/** A pinned action step: the same action, a full commit SHA and its `# vX.Y.Z` comment, and nothing more. */
const PIN = /^(\s*(?:-\s+)?uses:\s+)([\w.-]+\/[\w./-]+)@[0-9a-f]{40} # v[\w.-]+$/;

/**
 * Each line where `after` differs from `before` by more than an action's pin
 * (Shyden 2026-10-28, "Fence it"): a run started on a coverage branch gets
 * this repository's secrets, so a Dependabot commit is started only when it
 * bumps pins alone. Lines are compared in place: one added or removed is a
 * finding of its own.
 */
export function pinOnlyDiff(before: string, after: string, file: string): string[] {
  const was = before.split('\n');
  const now = after.split('\n');
  if (was.length !== now.length) return [`${file}: adds or removes lines (${was.length} before, ${now.length} after)`];
  return now.flatMap((line, i) => {
    const old = was[i] as string;
    if (line === old) return [];
    const [a, b] = [PIN.exec(old), PIN.exec(line)];
    return a && b && a[1] === b[1] && a[2] === b[2] ? [] : [`${file}:${i + 1} changes more than an action pin: ${line.trim()}`];
  });
}

/**
 * What a run started on a coverage branch could reach beyond a pull_request
 * run from Dependabot or a fork, which gets a read-only token and no secret:
 * any secret but the run's own token, a write scope, or no top-level
 * permissions (the token then takes the repository default). A Dependabot
 * commit's code runs under these workflows, so it is started only when this
 * names nothing (Shyden 2026-10-28, "Fence it").
 */
export function reachesBeyondPullRequest(workflow: string, file: string): string[] {
  const lines = workflow.split('\n');
  const found = lines.some((line) => /^permissions:/.test(line))
    ? []
    : [`${file}: names no top-level permissions, so its token takes the repository default`];
  lines.forEach((line, i) => {
    if (!isCode(line)) return;
    if (/\bsecrets\b(?!\.GITHUB_TOKEN\b)/.test(line)) found.push(`${file}:${i + 1} reaches a secret: ${line.trim()}`);
    else if (/:\s*write\b|\bwrite-all\b/.test(line)) found.push(`${file}:${i + 1} asks for a write scope: ${line.trim()}`);
  });
  return found;
}

export async function main(args: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const [head, base, baseRoot, branch, ...rest] = args;
  if (head === undefined || base === undefined || baseRoot === undefined || branch === undefined || rest.length > 0)
    throw new Error('usage: node scripts/coverage-dispatch.ts <head-sha> <base-sha> <base-root> <branch>');
  for (const sha of [head, base]) if (!/^[0-9a-f]{40}$/.test(sha)) fail(`${sha} is not a full commit sha`);
  if (branch === '') fail('the branch is empty; name the branch the pull request is pushed from');
  const repo = process.env.GITHUB_REPOSITORY || fail('GITHUB_REPOSITORY is empty: name the repository as owner/name');
  const token = process.env.GITHUB_TOKEN || fail('GITHUB_TOKEN is empty: the base commit’s runs are read with it');
  const api = githubApi(token, fetchImpl);
  const pullsPath = `/repos/${repo}/commits/${head}/pulls?per_page=${PAGE}`;
  const pulls = await api.json(pullsPath);
  if (!Array.isArray(pulls)) fail(`${pullsPath} answered no list`);
  if (pulls.length >= PAGE) fail(`${pullsPath} lists ${pulls.length} pull requests; one page of ${PAGE} was read`);
  const from: unknown[] = pulls.map((pull: { head?: { repo?: { full_name?: unknown } | null } }) => pull.head?.repo?.full_name);
  const at = from.findIndex((name) => name !== repo);
  if (at !== -1) {
    const name = from[at];
    fail(
      `${head.slice(0, 7)} heads a pull request from ${typeof name === 'string' ? name : 'a deleted fork'}: a fork's commit never goes to a coverage branch (#35, Shyden 2026-10-28, "Fence it")`,
    );
  }
  const baseRuns = await listRuns(api, repo, base);
  const headFiles = workflowFiles(process.cwd());
  const baseFiles = workflowFiles(baseRoot);
  const plan = planDispatch(headFiles, baseFiles, baseRuns);
  if (branch.startsWith('dependabot/')) {
    // A planned path is on both sides: planDispatch starts nothing new.
    const findings = plan.dispatch.flatMap((path) => [
      ...pinOnlyDiff(baseFiles.get(path) as string, headFiles.get(path) as string, path),
      ...reachesBeyondPullRequest(headFiles.get(path) as string, path),
    ]);
    if (findings.length > 0) fail(`${branch} is not started on a coverage branch: ${findings.join('; ')}`);
  }
  const out = (line: string) => process.stdout.write(`${line}\n`);
  for (const path of plan.dispatch) out(startCommand(path, branch, head));
  for (const path of plan.notMeasurable) out(`coverage-dispatch: ${path} is not measurable until on develop (#35 ruling 2)`);
  if (plan.dispatch.length === 0 && plan.notMeasurable.length === 0)
    out(`coverage-dispatch: no hand-started workflow needs a run on ${head}`);
  return 0;
}

await runIfEntry(import.meta.url, main);
