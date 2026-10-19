import { describe, it, expect } from 'vitest';
import {
  desiredRuleset,
  planRulesets,
  auditBranchRules,
  auditRepoSettings,
  type ExistingRuleset,
} from '../../scripts/branch-rules-setup';

/**
 * Every repository requires pull requests to be up to date with their base
 * ("strict" required checks) on `develop` and `main`, each by a ruleset that
 * names its branch (issue #8). Measured 2026-10-13 in ShyTalk: develop was not
 * strict, and a ruleset named "main" targeted ~DEFAULT_BRANCH, so when develop
 * became the default branch the real `main` kept only no-force-push.
 */

const CHECKS = ['unit', 'PR Gate'];

function ruleTypes(body: { rules: { type: string }[] }): string[] {
  return body.rules.map((r) => r.type).sort();
}

function checksRule(body: { rules: { type: string; parameters?: unknown }[] }) {
  return body.rules.find((r) => r.type === 'required_status_checks')?.parameters as
    | { strict_required_status_checks_policy: boolean; required_status_checks: { context: string }[] }
    | undefined;
}

describe('desiredRuleset', () => {
  it('targets develop by name only', () => {
    expect(desiredRuleset('develop', CHECKS).conditions).toEqual({
      ref_name: { include: ['refs/heads/develop'], exclude: [] },
    });
  });

  it('targets main by name only', () => {
    expect(desiredRuleset('main', CHECKS).conditions).toEqual({
      ref_name: { include: ['refs/heads/main'], exclude: [] },
    });
  });

  it('requires the checks to be run on an up-to-date branch (strict)', () => {
    expect(checksRule(desiredRuleset('develop', CHECKS))?.strict_required_status_checks_policy).toBe(true);
  });

  it('requires exactly the named checks, in order', () => {
    expect(checksRule(desiredRuleset('main', CHECKS))?.required_status_checks).toEqual([
      { context: 'unit' },
      { context: 'PR Gate' },
    ]);
  });

  it('also forbids deletion and force pushes and requires pull requests and signed commits', () => {
    expect(ruleTypes(desiredRuleset('develop', CHECKS))).toEqual([
      'deletion',
      'non_fast_forward',
      'pull_request',
      'required_signatures',
      'required_status_checks',
    ]);
  });

  it('is active, on branches, under the branch name', () => {
    const body = desiredRuleset('main', CHECKS);
    expect([body.name, body.target, body.enforcement]).toEqual(['main', 'branch', 'active']);
  });

  it('refuses an empty check list by name', () => {
    expect(() => desiredRuleset('develop', [])).toThrow(
      'name at least one required check: a strict rule with no checks tests nothing',
    );
  });
});

function existing(id: number, name: string, include: string[], strict = true): ExistingRuleset {
  const body = desiredRuleset(name === 'main' ? 'main' : 'develop', CHECKS);
  const rules = body.rules.map((r) =>
    r.type === 'required_status_checks'
      ? { ...r, parameters: { ...(r.parameters as object), strict_required_status_checks_policy: strict } }
      : r,
  );
  return { ...body, id, name, conditions: { ref_name: { include, exclude: [] } }, rules };
}

describe('planRulesets', () => {
  it('creates both rulesets when the repository has none', () => {
    expect(planRulesets([], CHECKS).map((p) => [p.action, p.body.name])).toEqual([
      ['create', 'develop'],
      ['create', 'main'],
    ]);
  });

  it('updates a same-named ruleset that is not strict, by its id', () => {
    const plan = planRulesets([existing(11, 'develop', ['refs/heads/develop'], false)], CHECKS);
    expect(plan.map((p) => [p.action, p.body.name, p.id])).toEqual([
      ['update', 'develop', 11],
      ['create', 'main', undefined],
    ]);
  });

  it('keeps a ruleset that already matches', () => {
    const plan = planRulesets(
      [existing(11, 'develop', ['refs/heads/develop']), existing(12, 'main', ['refs/heads/main'])],
      CHECKS,
    );
    expect(plan.map((p) => p.action)).toEqual(['keep', 'keep']);
  });

  it('refuses a ruleset that targets the default branch, naming it', () => {
    expect(() => planRulesets([existing(12613584, 'main', ['~DEFAULT_BRANCH'])], CHECKS)).toThrow(
      'ruleset 12613584 "main" targets ~DEFAULT_BRANCH, which moves when the default branch changes: retarget it to refs/heads/<branch> or delete it first',
    );
  });

  it('leaves unrelated rulesets alone', () => {
    const other: ExistingRuleset = {
      id: 3,
      name: 'no-force-push-anywhere',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
      rules: [{ type: 'non_fast_forward' }],
    };
    expect(planRulesets([other], CHECKS).map((p) => p.action)).toEqual(['create', 'create']);
  });
});

describe('auditBranchRules', () => {
  const good = [
    { type: 'deletion' },
    { type: 'pull_request' },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true } },
  ];

  it('passes a branch that forbids deletion and requires pull requests and strict checks', () => {
    expect(auditBranchRules('develop', good)).toEqual([]);
  });

  it('names a branch whose required checks are not strict', () => {
    expect(
      auditBranchRules('develop', [
        { type: 'deletion' },
        { type: 'pull_request' },
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false } },
      ]),
    ).toEqual(['develop: a required-checks rule is not strict']);
  });

  it('names a branch with no required checks at all', () => {
    expect(auditBranchRules('main', [{ type: 'deletion' }, { type: 'pull_request' }, { type: 'non_fast_forward' }])).toEqual([
      'main: no rule requires status checks',
    ]);
  });

  it('names a branch that does not require pull requests', () => {
    expect(auditBranchRules('main', [good[0], good[2]])).toEqual(['main: no rule requires a pull request']);
  });

  // With "Automatically delete head branches" on, merging a develop -> main
  // release pull request deletes develop unless a rule forbids it (#28).
  it('names a branch that can be deleted', () => {
    expect(auditBranchRules('develop', [good[1], good[2]])).toEqual(['develop: no rule forbids deleting it']);
  });
});

describe('auditRepoSettings', () => {
  it('passes a repository that deletes merged head branches', () => {
    expect(auditRepoSettings({ delete_branch_on_merge: true })).toEqual([]);
  });

  it('names a repository that keeps merged head branches', () => {
    expect(auditRepoSettings({ delete_branch_on_merge: false })).toEqual([
      'merged head branches are not deleted (delete_branch_on_merge is false)',
    ]);
  });

  it('names a repository whose answer leaves the setting out', () => {
    expect(auditRepoSettings({})).toEqual([
      'merged head branches are not deleted (delete_branch_on_merge is undefined)',
    ]);
  });
});
