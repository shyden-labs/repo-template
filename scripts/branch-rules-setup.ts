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
import { pathToFileURL } from 'node:url';

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

/** What each branch's ruleset needs: created, updated by id, or kept. */
export function planRulesets(
  existing: ExistingRuleset[],
  checks: string[],
): { action: 'create' | 'update' | 'keep'; id?: number; body: RulesetBody }[] {
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

function gh(args: string[], input?: string): unknown {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', input }));
}

function main(): void {
  const [repo, ...checks] = process.argv.slice(2);
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
  process.stdout.write(`${repo}: develop and main each require pull requests and strict checks.\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
