/**
 * Judges a pull request into `main` (issue #86, docs/release-cut.md): `main`
 * takes only a frozen `release/*` cut, by merge commit. `main` is not strict,
 * because each release merge lands on `main` and never on squash-only
 * `develop`, so this check proves instead what strict proved, that what lands
 * is what CI tested:
 *
 *   (a) the head branch is a `release/` branch;
 *   (b) the head is on `origin/develop`, where CI tested it;
 *   (c) the pull request's merge ref is GitHub's merge of the head into main,
 *       and it lands exactly the head's tree;
 *   (d) every commit `main` holds beyond `develop` is a two-parent merge whose
 *       second parent is on `develop`, so `main` never took anything else.
 *
 * Run by `.github/workflows/check-release-cut.yml` from the default branch's
 * own copy (`pull_request_target`), never the pull request's: it fetches the
 * pull request's merge ref as git data, runs none of its code, and posts its
 * verdict as the `release-cut` commit status on the head, which `main`
 * requires (Shyden's rulings of 2026-10-23 on #86):
 *
 *   node scripts/release-cut.ts <head ref> <40-hex head sha> <pull request number>
 */
import { execFileSync } from 'node:child_process';
import { RELEASE_CUT } from './branch-rules-setup.ts';
import { runIfEntry } from './cli.ts';

/** A commit `main` holds that `develop` lacks. `secondParentOnDevelop` is null unless it has two parents. */
export interface MainCommit {
  sha: string;
  parents: string[];
  secondParentOnDevelop: boolean | null;
}

/** What git says about the pull request, as `gatherFacts` reads it. */
export interface ReleaseCutFacts {
  headRef: string;
  headSha: string;
  headOnDevelop: boolean;
  /** The checked-out commit's parents: main's tip, then the head. */
  mergeParents: string[];
  mergeTree: string;
  headTree: string;
  mainCommits: MainCommit[];
}

const SHA = /^[0-9a-f]{40}$/;
const PULL_NUMBER = /^[1-9][0-9]*$/;
/** Where the pull request's merge commit is fetched to. */
export const MERGE_REF = 'refs/remotes/pull/merge';
/** GitHub refuses a commit status description longer than this. */
const DESCRIPTION_LIMIT = 140;
const DEVELOP = 'origin/develop';
const BEYOND_DEVELOP = 'origin/develop..origin/main';

/** Every reason the merge is not a release cut, in the order (a)-(d); empty when it is one. */
export function auditReleaseCut(facts: ReleaseCutFacts): string[] {
  const problems: string[] = [];
  if (!/^release\/./.test(facts.headRef)) {
    problems.push(`the head branch is ${facts.headRef}, not a release/ branch`);
  }
  if (!facts.headOnDevelop) {
    problems.push(`the head ${facts.headSha} is not on ${DEVELOP}`);
  }
  if (facts.mergeParents.length !== 2 || facts.mergeParents[1] !== facts.headSha) {
    problems.push(
      `the checked-out commit is not GitHub's merge of the head ${facts.headSha} into main (its parents: ${facts.mergeParents.join(' ')})`,
    );
  }
  if (facts.mergeTree !== facts.headTree) {
    problems.push(`the merge would land tree ${facts.mergeTree}, not the head's tree ${facts.headTree}`);
  }
  for (const c of facts.mainCommits) {
    if (c.parents.length !== 2) {
      const n = c.parents.length;
      problems.push(`main holds ${c.sha}, which has ${n} parent${n === 1 ? '' : 's'}, not a merge of a release cut`);
    } else if (c.secondParentOnDevelop !== true) {
      problems.push(`main holds the merge ${c.sha}, whose second parent ${c.parents[1] as string} is not on ${DEVELOP}`);
    }
  }
  return problems;
}

/** Reads `git rev-list --parents` output: each line a commit then its parents, every one 40 lowercase hex. */
export function parseParents(revList: string): { sha: string; parents: string[] }[] {
  if (revList === '') return [];
  // Only git's final newline is dropped: any other empty line is unreadable.
  return revList
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => {
      const shas = line.split(' ');
      if (!shas.every((s) => SHA.test(s))) throw new Error(`unreadable rev-list line: ${line}`);
      const [sha, ...parents] = shas as [string, ...string[]];
      return { sha, parents };
    });
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Whether `sha` is on develop. git answers 0 (yes) or 1 (no); anything else is an error, never a no. */
function onDevelop(sha: string): boolean {
  const args = ['merge-base', '--is-ancestor', sha, DEVELOP];
  try {
    git(args);
    return true;
  } catch (error) {
    const { status, stderr } = error as { status?: number; stderr?: string };
    if (status === 1) return false;
    throw new Error(`git ${args.join(' ')} failed: ${String(stderr).trim()}`, { cause: error });
  }
}

/** Fetches the pull request's merge ref as data, then asks git about it, the head and main. */
export function gatherFacts(headRef: string, headSha: string, pullNumber: number): ReleaseCutFacts {
  git(['fetch', '--no-tags', 'origin', `+refs/pull/${pullNumber}/merge:${MERGE_REF}`]);
  const headOnDevelop = onDevelop(headSha);
  const mergeParents = parseParents(git(['rev-list', '--parents', '-n', '1', MERGE_REF]))[0]?.parents ?? [];
  const mergeTree = git(['rev-parse', `${MERGE_REF}^{tree}`]).trim();
  const headTree = git(['rev-parse', `${headSha}^{tree}`]).trim();
  const mainCommits = parseParents(git(['rev-list', '--parents', BEYOND_DEVELOP])).map(({ sha, parents }) => ({
    sha,
    parents,
    secondParentOnDevelop: parents.length === 2 ? onDevelop(parents[1] as string) : null,
  }));
  return { headRef, headSha, headOnDevelop, mergeParents, mergeTree, headTree, mainCommits };
}

/** The commit status a verdict posts: GitHub shows its description beside the check. */
export interface Status {
  state: 'success' | 'failure' | 'error';
  description: string;
}

function clip(text: string): string {
  return text.length <= DESCRIPTION_LIMIT ? text : `${text.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

/** Success for a release cut; otherwise failure, naming the first reason and how many more the log holds. */
export function statusFor(problems: string[]): Status {
  const [first, ...rest] = problems;
  if (first === undefined) return { state: 'success', description: "a tested release cut: the merge lands the head's tree" };
  return { state: 'failure', description: clip(rest.length === 0 ? first : `${first} (and ${rest.length} more in the log)`) };
}

const ENV = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_API_URL', 'GITHUB_SERVER_URL', 'GITHUB_RUN_ID'] as const;
type Env = Record<(typeof ENV)[number], string>;

/** What GitHub Actions sets for the job, failing by name on the first missing. */
function actionsEnv(): Env {
  const env = {} as Env;
  for (const name of ENV) {
    const value = process.env[name];
    if (!value) throw new Error(`release-cut needs ${name}, which GitHub Actions sets`);
    env[name] = value;
  }
  return env;
}

/** Posts the verdict as the `release-cut` status on the head, failing unless GitHub took it. */
async function post(env: Env, headSha: string, status: Status): Promise<void> {
  const url = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/statuses/${headSha}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({
      ...status,
      context: RELEASE_CUT,
      target_url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    }),
  });
  if (!response.ok) throw new Error(`POST ${url} answered ${response.status}; the pull request has no ${RELEASE_CUT} status`);
}

export async function main(args: string[]): Promise<number> {
  if (args.length !== 3 || !SHA.test(args[1] as string) || !PULL_NUMBER.test(args[2] as string)) {
    throw new Error('usage: node scripts/release-cut.ts <head ref> <40-hex head sha> <pull request number>');
  }
  const [headRef, headSha, pullNumber] = args as [string, string, string];
  const env = actionsEnv();
  let facts: ReleaseCutFacts;
  try {
    facts = gatherFacts(headRef, headSha, Number(pullNumber));
  } catch (error) {
    // A verdict git could not reach is posted as an error, so the pull request says why it waits.
    await post(env, headSha, { state: 'error', description: clip(`could not judge: ${(error as Error).message}`) });
    throw error;
  }
  const problems = auditReleaseCut(facts);
  await post(env, headSha, statusFor(problems));
  if (problems.length > 0) {
    throw new Error(`release-cut refuses this merge:\n  ${problems.join('\n  ')}`);
  }
  process.stdout.write(
    `release-cut: ${headRef} at ${headSha}; judged ${facts.mainCommits.length} commit(s) in ${BEYOND_DEVELOP}; the merge lands the head's tree.\n`,
  );
  return 0;
}

await runIfEntry(import.meta.url, main);
