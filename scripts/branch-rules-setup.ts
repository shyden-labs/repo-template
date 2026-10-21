/**
 * Gives a repository one ruleset per long-lived branch, `develop` and `main`,
 * each naming its branch, requiring pull requests and the named checks run on
 * an up-to-date branch ("strict"), signed commits, and no deletion or force
 * push (issue #8). Run once per repository, by the operator (rulesets need
 * admin rights), after `develop` becomes the default branch:
 *
 *   node scripts/branch-rules-setup.ts <owner/repo> <required check>...
 *
 * It refuses a ruleset that targets ~DEFAULT_BRANCH: that target moves when the
 * default branch changes, which is how ShyTalk's `main` lost its rules on
 * 2026-10-13. It creates what is missing, updates what differs, and reads both
 * branches' rules back, failing unless both are strict.
 */
import { execFileSync } from 'node:child_process';
import { runIfEntry } from './cli.ts';

export interface Rule {
  type: string;
  parameters?: unknown;
}

export interface RulesetBody {
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Rule[];
}

export interface ExistingRuleset extends RulesetBody {
  id: number;
}

export type Branch = 'develop' | 'main';
const BRANCHES: Branch[] = ['develop', 'main'];

/** The ruleset a branch must carry. */
export function desiredRuleset(branch: Branch, checks: string[]): RulesetBody {
  if (checks.length === 0) {
    throw new Error('name at least one required check: a strict rule with no checks tests nothing');
  }
  return {
    name: branch,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: checks.map((context) => ({ context })),
        },
      },
      { type: 'required_signatures' },
    ],
  };
}

/** Objects with their keys sorted, so two rulesets compare by content alone. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function shape(body: RulesetBody): string {
  const { name, target, enforcement, conditions, rules } = body;
  return canonical({ name, target, enforcement, conditions, rules });
}

/** One branch's ruleset: created, or updated or kept by its id. */
export type RulesetStep =
  | { action: 'create'; body: RulesetBody }
  | { action: 'update' | 'keep'; id: number; body: RulesetBody };

/** What each branch's ruleset needs: created, updated by id, or kept. */
export function planRulesets(
  existing: ExistingRuleset[],
  checks: string[],
): RulesetStep[] {
  for (const r of existing) {
    if (r.conditions.ref_name.include.includes('~DEFAULT_BRANCH')) {
      throw new Error(
        `ruleset ${r.id} "${r.name}" targets ~DEFAULT_BRANCH, which moves when the default branch changes: retarget it to refs/heads/<branch> or delete it first`,
      );
    }
  }
  return BRANCHES.map((branch) => {
    const body = desiredRuleset(branch, checks);
    const found = existing.find((r) => r.name === branch);
    if (found === undefined) return { action: 'create' as const, body };
    return { action: shape(found) === shape(body) ? ('keep' as const) : ('update' as const), id: found.id, body };
  });
}

interface ChecksParameters {
  strict_required_status_checks_policy?: boolean;
}

/** Every way a branch's rules (as `rules/branches/<branch>` reports them) fall short; empty when none. */
export function auditBranchRules(branch: string, rules: Rule[]): string[] {
  const problems: string[] = [];
  // The repository deletes merged head branches (#28), so a deletable
  // develop would go the first time a develop -> main pull request merges.
  if (!rules.some((r) => r.type === 'deletion')) {
    problems.push(`${branch}: no rule forbids deleting it`);
  }
  if (!rules.some((r) => r.type === 'pull_request')) {
    problems.push(`${branch}: no rule requires a pull request`);
  }
  const checks = rules.filter((r) => r.type === 'required_status_checks');
  if (checks.length === 0) {
    problems.push(`${branch}: no rule requires status checks`);
  } else if (checks.some((r) => (r.parameters as ChecksParameters | undefined)?.strict_required_status_checks_policy !== true)) {
    problems.push(`${branch}: a required-checks rule is not strict`);
  }
  return problems;
}

/** Every way the repository's own settings (as `repos/<owner>/<repo>` reports them) fall short; empty when none. */
export function auditRepoSettings(repo: { delete_branch_on_merge?: boolean }): string[] {
  return repo.delete_branch_on_merge === true
    ? []
    : [`merged head branches are not deleted (delete_branch_on_merge is ${String(repo.delete_branch_on_merge)})`];
}

function gh(args: string[], input?: string): unknown {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', input }));
}

export function main(args: string[]): number {
  const [repo, ...checks] = args;
  if (repo === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repo) || checks.length === 0) {
    throw new Error('usage: node scripts/branch-rules-setup.ts <owner/repo> <required check>...');
  }
  const summaries = gh(['api', `repos/${repo}/rulesets`]) as { id: number }[];
  const existing = summaries.map((s) => gh(['api', `repos/${repo}/rulesets/${s.id}`]) as ExistingRuleset);
  for (const step of planRulesets(existing, checks)) {
    if (step.action === 'create') {
      gh(['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'], JSON.stringify(step.body));
    } else if (step.action === 'update') {
      gh(['api', '-X', 'PUT', `repos/${repo}/rulesets/${step.id}`, '--input', '-'], JSON.stringify(step.body));
    }
    process.stdout.write(`${step.body.name}: ${step.action}\n`);
  }
  const problems = BRANCHES.flatMap((b) => auditBranchRules(b, gh(['api', `repos/${repo}/rules/branches/${b}`]) as Rule[]));
  if (problems.length > 0) {
    throw new Error(`read back, the rules still fall short:\n  ${problems.join('\n  ')}`);
  }
  // Only now that neither branch can be deleted: a merged pull request's head
  // branch is deleted with it (#28). A template copies files, not settings.
  gh(['api', '-X', 'PATCH', `repos/${repo}`, '-F', 'delete_branch_on_merge=true']);
  const settings = auditRepoSettings(gh(['api', `repos/${repo}`]) as { delete_branch_on_merge?: boolean });
  if (settings.length > 0) {
    throw new Error(`read back, the repository still falls short:\n  ${settings.join('\n  ')}`);
  }
  process.stdout.write(
    `${repo}: develop and main each forbid deletion and require pull requests and strict checks; merged head branches are deleted.\n`,
  );
  return 0;
}

await runIfEntry(import.meta.url, main);
