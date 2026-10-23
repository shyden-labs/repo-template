import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { auditReleaseCut, gatherFacts, main, parseParents, type ReleaseCutFacts } from '../../scripts/release-cut.ts';

// git is stood in: a unit test starts no process. Each test answers git by its arguments.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const git = vi.mocked(execFileSync);

/**
 * A pull request into main merges only a release cut (issue #86): main is not
 * strict, because each release merge lands on main and never on squash-only
 * develop, so release-cut proves what strict did. These cases plant each way
 * a merge into main could land something CI never tested.
 */

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const OLD_MAIN = 'c'.repeat(40);
const OLD_CUT = 'd'.repeat(40);
const STRAY = 'e'.repeat(40);
const TREE = 'f'.repeat(40);
/** The pull request's merge ref, GitHub's merge of HEAD into main's tip. */
const PR_MERGE = '9'.repeat(40);

/** A second cut after one release merge: every fact as it should be. */
const good: ReleaseCutFacts = {
  headRef: 'release/2026-10-23',
  headSha: HEAD,
  headOnDevelop: true,
  mergeParents: [MERGE, HEAD],
  mergeTree: TREE,
  headTree: TREE,
  mainCommits: [{ sha: MERGE, parents: [OLD_MAIN, OLD_CUT], secondParentOnDevelop: true }],
};

describe('auditReleaseCut', () => {
  it('passes the first cut, when main holds nothing develop lacks', () => {
    expect(auditReleaseCut({ ...good, mainCommits: [] })).toEqual([]);
  });

  it('passes a second cut after one release merge', () => {
    expect(auditReleaseCut(good)).toEqual([]);
  });

  it.each(['feature/x', 'releases/2026-10-23', 'release', 'release/', 'xrelease/2026-10-23'])('refuses the head branch %s', (headRef) => {
    expect(auditReleaseCut({ ...good, headRef })).toEqual([`the head branch is ${headRef}, not a release/ branch`]);
  });

  it('refuses a head that is not on develop', () => {
    expect(auditReleaseCut({ ...good, headOnDevelop: false })).toEqual([`the head ${HEAD} is not on origin/develop`]);
  });

  // The tree check means nothing unless the checked-out commit is the merge of this head.
  it.each([
    ['an older head', [MERGE, STRAY]],
    ['no merge at all', [MERGE]],
    ['an octopus', [MERGE, HEAD, STRAY]],
  ])('refuses a checked-out commit that is the merge of %s', (_name, mergeParents) => {
    expect(auditReleaseCut({ ...good, mergeParents })).toEqual([
      `the checked-out commit is not GitHub's merge of the head ${HEAD} into main (its parents: ${mergeParents.join(' ')})`,
    ]);
  });

  it('refuses a merge whose tree is not the head’s', () => {
    expect(auditReleaseCut({ ...good, mergeTree: STRAY })).toEqual([`the merge would land tree ${STRAY}, not the head's tree ${TREE}`]);
  });

  it('refuses a main holding a direct commit', () => {
    const commits = [{ sha: STRAY, parents: [MERGE], secondParentOnDevelop: null }, ...good.mainCommits];
    expect(auditReleaseCut({ ...good, mainCommits: commits })).toEqual([
      `main holds ${STRAY}, which has 1 parent, not a merge of a release cut`,
    ]);
  });

  it('refuses a main holding a squash of a release', () => {
    expect(auditReleaseCut({ ...good, mainCommits: [{ sha: STRAY, parents: [OLD_MAIN], secondParentOnDevelop: null }] })).toEqual([
      `main holds ${STRAY}, which has 1 parent, not a merge of a release cut`,
    ]);
  });

  it('refuses a main holding an octopus merge', () => {
    const octopus = { sha: STRAY, parents: [OLD_MAIN, OLD_CUT, HEAD], secondParentOnDevelop: null };
    expect(auditReleaseCut({ ...good, mainCommits: [octopus] })).toEqual([
      `main holds ${STRAY}, which has 3 parents, not a merge of a release cut`,
    ]);
  });

  it('refuses a main holding a merge whose second parent is not on develop', () => {
    const merge = { sha: MERGE, parents: [OLD_MAIN, STRAY], secondParentOnDevelop: false };
    expect(auditReleaseCut({ ...good, mainCommits: [merge] })).toEqual([
      `main holds the merge ${MERGE}, whose second parent ${STRAY} is not on origin/develop`,
    ]);
  });

  it('names every failure, in the order it judges them', () => {
    const facts: ReleaseCutFacts = {
      headRef: 'feature/x',
      headSha: HEAD,
      headOnDevelop: false,
      mergeParents: [MERGE],
      mergeTree: STRAY,
      headTree: TREE,
      mainCommits: [{ sha: STRAY, parents: [OLD_MAIN], secondParentOnDevelop: null }],
    };
    expect(auditReleaseCut(facts)).toEqual([
      'the head branch is feature/x, not a release/ branch',
      `the head ${HEAD} is not on origin/develop`,
      `the checked-out commit is not GitHub's merge of the head ${HEAD} into main (its parents: ${MERGE})`,
      `the merge would land tree ${STRAY}, not the head's tree ${TREE}`,
      `main holds ${STRAY}, which has 1 parent, not a merge of a release cut`,
    ]);
  });
});

describe('parseParents', () => {
  it('reads each commit with its parents, in order', () => {
    expect(parseParents(`${MERGE} ${OLD_MAIN} ${OLD_CUT}\n${STRAY} ${OLD_MAIN}\n`)).toEqual([
      { sha: MERGE, parents: [OLD_MAIN, OLD_CUT] },
      { sha: STRAY, parents: [OLD_MAIN] },
    ]);
  });

  it('reads no commits from an empty answer', () => {
    expect(parseParents('')).toEqual([]);
  });

  it.each(['', 'xyz', `${MERGE.slice(1)} ${OLD_MAIN}`, `${MERGE.toUpperCase()} ${OLD_MAIN}`, `${MERGE}  ${OLD_MAIN}`, ` ${MERGE}`])(
    'refuses the line %j by name',
    (line) => {
      expect(() => parseParents(`${line}\n`)).toThrow(`unreadable rev-list line: ${line}`);
    },
  );
});

/** An error like the one execFileSync throws when git exits with `status`. */
function exited(status: number, stderr = ''): Error {
  return Object.assign(new Error(`Command failed: git (status ${status})`), { status, stderr });
}

/** Answers git by its arguments, as a real repository would. */
function answer(replies: Record<string, string | Error>): void {
  git.mockImplementation(((_file: string, args: string[]) => {
    const reply = replies[args.join(' ')];
    if (reply === undefined) throw new Error(`unexpected git ${args.join(' ')}`);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as typeof execFileSync);
}

const ancestor = (sha: string) => `merge-base --is-ancestor ${sha} origin/develop`;
const repoReplies = (overrides: Record<string, string | Error> = {}): Record<string, string | Error> => ({
  [ancestor(HEAD)]: '',
  'rev-list --parents -n 1 HEAD': `${PR_MERGE} ${MERGE} ${HEAD}\n`,
  'rev-parse HEAD^{tree}': `${TREE}\n`,
  [`rev-parse ${HEAD}^{tree}`]: `${TREE}\n`,
  'rev-list --parents origin/develop..origin/main': `${MERGE} ${OLD_MAIN} ${OLD_CUT}\n`,
  [ancestor(OLD_CUT)]: '',
  ...overrides,
});

describe('gatherFacts', () => {
  // A braced body: a function returned from beforeEach is run as the test's teardown.
  beforeEach(() => {
    git.mockReset();
  });

  // The stand-in answers only what a case gives it, so a question the code should not ask fails.
  it('stands in a git that refuses a question no case answered', () => {
    answer(repoReplies());
    expect(() => execFileSync('git', ['status'])).toThrow('unexpected git status');
  });

  it('asks git each question once, in order, and reads the answers', () => {
    answer(repoReplies());
    expect(gatherFacts('release/2026-10-23', HEAD)).toEqual(good);
    expect(git.mock.calls.map((c) => [c[0], (c[1] as string[]).join(' ')])).toEqual([
      ['git', ancestor(HEAD)],
      ['git', 'rev-list --parents -n 1 HEAD'],
      ['git', 'rev-parse HEAD^{tree}'],
      ['git', `rev-parse ${HEAD}^{tree}`],
      ['git', 'rev-list --parents origin/develop..origin/main'],
      ['git', ancestor(OLD_CUT)],
    ]);
  });

  it('reads status 1 from --is-ancestor as not on develop', () => {
    answer(repoReplies({ [ancestor(HEAD)]: exited(1), [ancestor(OLD_CUT)]: exited(1) }));
    const facts = gatherFacts('release/2026-10-23', HEAD);
    expect([facts.headOnDevelop, facts.mainCommits[0]?.secondParentOnDevelop]).toEqual([false, false]);
  });

  it('fails, naming the question, when --is-ancestor errors rather than answers', () => {
    const failure = exited(128, 'fatal: Not a valid commit name\n');
    answer(repoReplies({ [ancestor(HEAD)]: failure }));
    expect(() => gatherFacts('release/2026-10-23', HEAD)).toThrow(
      expect.objectContaining({
        message: `git merge-base --is-ancestor ${HEAD} origin/develop failed: fatal: Not a valid commit name`,
        cause: failure,
      }),
    );
  });

  it('asks about the second parent of two-parent commits only', () => {
    answer(repoReplies({ 'rev-list --parents origin/develop..origin/main': `${STRAY} ${OLD_MAIN}\n` }));
    expect(gatherFacts('release/2026-10-23', HEAD).mainCommits).toEqual([{ sha: STRAY, parents: [OLD_MAIN], secondParentOnDevelop: null }]);
    expect(git).toHaveBeenCalledTimes(5);
  });

  it('reads no parents when git names no checked-out commit, so the merge check fails', () => {
    answer(repoReplies({ 'rev-list --parents -n 1 HEAD': '' }));
    expect(gatherFacts('release/2026-10-23', HEAD).mergeParents).toEqual([]);
  });

  it('runs git with its output read as text and nothing on its input', () => {
    answer(repoReplies());
    gatherFacts('release/2026-10-23', HEAD);
    expect(git.mock.calls.map((c) => c[2])).toEqual(Array(6).fill({ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  });
});

describe('main', () => {
  let out: string[];
  beforeEach(() => {
    git.mockReset();
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((t) => (out.push(String(t)), true));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([[[]], [['release/x']], [['release/x', HEAD, 'extra']], [['release/x', HEAD.slice(1)]], [['release/x', `-${HEAD.slice(1)}`]]])(
    'refuses the arguments %j',
    (args) => {
      expect(() => main(args)).toThrow('usage: node scripts/release-cut.ts <head ref> <40-hex head sha>');
    },
  );

  it('says what it judged and exits 0 when the merge is a release cut', () => {
    answer(repoReplies());
    expect(main(['release/2026-10-23', HEAD])).toBe(0);
    expect(out).toEqual([
      `release-cut: release/2026-10-23 at ${HEAD}; judged 1 commit(s) in origin/develop..origin/main; the merge lands the head's tree.\n`,
    ]);
  });

  it('refuses the merge, naming each reason', () => {
    answer(repoReplies());
    expect(() => main(['feature/x', HEAD])).toThrow(
      'release-cut refuses this merge:\n  the head branch is feature/x, not a release/ branch',
    );
    expect(out).toEqual([]);
  });
});
