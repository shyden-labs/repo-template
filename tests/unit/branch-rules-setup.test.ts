import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  desiredRuleset,
  main,
  planRulesets,
  auditBranchRules,
  type ExistingRuleset,
} from '../../scripts/branch-rules-setup';

// `gh` is stood in: a unit test starts no process. Each test queues gh's replies in call order.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const gh = vi.mocked(execFileSync);

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
    { type: 'pull_request' },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true } },
  ];

  it('passes a branch that requires pull requests and strict checks', () => {
    expect(auditBranchRules('develop', good)).toEqual([]);
  });

  it('names a branch whose required checks are not strict', () => {
    expect(
      auditBranchRules('develop', [
        { type: 'pull_request' },
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false } },
      ]),
    ).toEqual(['develop: a required-checks rule is not strict']);
  });

  it('names a branch with no required checks at all', () => {
    expect(auditBranchRules('main', [{ type: 'pull_request' }, { type: 'non_fast_forward' }])).toEqual([
      'main: no rule requires status checks',
    ]);
  });

  it('names a branch that does not require pull requests', () => {
    expect(auditBranchRules('main', [good[1]])).toEqual(['main: no rule requires a pull request']);
  });
});

describe('main', () => {
  const REPO = 'shyden-labs/app';
  const CHECKS = ['build-and-test', 'coverage'];
  const strict = [
    { type: 'pull_request' },
    { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true } },
  ];
  const reply = (...values: unknown[]) => {
    for (const value of values) gh.mockReturnValueOnce(JSON.stringify(value));
  };
  /** Each gh call's arguments and the body it sent on stdin, if any. */
  const calls = () => gh.mock.calls.map((c) => [c[1], (c[2] as { input?: string }).input]);
  let out: string[];
  beforeEach(() => {
    gh.mockReset();
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((t) => (out.push(String(t)), true));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([[[]], [['not-a-repo', 'build-and-test']], [[REPO]]])('refuses the arguments %j', (args) => {
    expect(() => main(args)).toThrow('usage: node scripts/branch-rules-setup.ts <owner/repo> <required check>...');
  });

  it('creates both rulesets where there are none, reads both branches back and exits 0', () => {
    reply([], {}, {}, strict, strict);
    expect(main([REPO, ...CHECKS])).toBe(0);
    expect(calls()).toEqual([
      [['api', `repos/${REPO}/rulesets`], undefined],
      [['api', '-X', 'POST', `repos/${REPO}/rulesets`, '--input', '-'], JSON.stringify(desiredRuleset('develop', CHECKS))],
      [['api', '-X', 'POST', `repos/${REPO}/rulesets`, '--input', '-'], JSON.stringify(desiredRuleset('main', CHECKS))],
      [['api', `repos/${REPO}/rules/branches/develop`], undefined],
      [['api', `repos/${REPO}/rules/branches/main`], undefined],
    ]);
    expect(out).toEqual([
      'develop: create\n',
      'main: create\n',
      `${REPO}: develop and main each require pull requests and strict checks.\n`,
    ]);
  });

  it('keeps a ruleset that matches and updates one that differs, by id', () => {
    const developRuleset = { id: 1, ...desiredRuleset('develop', CHECKS) };
    const mainRuleset = { id: 2, ...desiredRuleset('main', ['build-and-test']) };
    reply([{ id: 1 }, { id: 2 }], developRuleset, mainRuleset, {}, strict, strict);
    expect(main([REPO, ...CHECKS])).toBe(0);
    expect(calls().slice(1, 4)).toEqual([
      [['api', `repos/${REPO}/rulesets/1`], undefined],
      [['api', `repos/${REPO}/rulesets/2`], undefined],
      [['api', '-X', 'PUT', `repos/${REPO}/rulesets/2`, '--input', '-'], JSON.stringify(desiredRuleset('main', CHECKS))],
    ]);
    expect(out.slice(0, 2)).toEqual(['develop: keep\n', 'main: update\n']);
  });

  it('fails, naming each shortfall, when the rules read back fall short', () => {
    reply([], {}, {}, strict, [strict[1]]);
    expect(() => main([REPO, ...CHECKS])).toThrow('read back, the rules still fall short:\n  main: no rule requires a pull request');
  });
});
