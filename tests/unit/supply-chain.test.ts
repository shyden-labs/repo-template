import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withoutYamlComments, withoutYamlQuotes } from './source-text.ts';
import { leaks, parseGroups } from './dependabot-groups.ts';

/**
 * The CI supply chain is pinned, and something keeps it current.
 *
 * Two failure modes, and they pull in opposite directions:
 *
 * 1. A MUTABLE TAG is not a version. `actions/checkout@v4` resolves to
 *    whatever the tag points at today, and a tag can be repointed by anyone
 *    who can push to that repo. A compromised or coerced maintainer moves the
 *    tag and every workflow in this repo runs their code, with our secrets,
 *    on the next push. Pinning to a full commit SHA is the only form of this
 *    reference that cannot be changed underneath us.
 *
 * 2. A PIN THAT NOBODY BUMPS rots. shyden.co.uk sat three majors behind on
 *    both of its actions with no mechanism to notice. So the SHA is only half
 *    the control — Dependabot is the other half, and the version comment
 *    beside each SHA is what makes a bump reviewable by a human instead of an
 *    opaque hex swap.
 *
 * SOURCE TEXT, not YAML parsing: no YAML parser is available here and none is
 * worth adding ("no new npm dependencies"), matching pipeline-wiring.test.ts.
 *
 * Each check is a function over text, run on this repo's files and on planted
 * text that breaks it, so every check is seen to fail as well as pass.
 */

const WORKFLOWS = '.github/workflows';
const DEPENDABOT = '.github/dependabot.yml';

interface Use {
  where: string;
  text: string;
}

/**
 * Every `uses:` naming a THIRD-PARTY action in one workflow's text.
 *
 * Local references (`./.github/actions/x`, `./.github/workflows/y.yml`) are
 * excluded deliberately: they are this repo's own code, already reviewed at
 * the commit that introduced them, and have no upstream SHA to pin.
 */
const usesIn = (file: string, source: string): Use[] =>
  source
    .split('\n')
    .map((text, i) => ({ where: `${file}:${i + 1}`, text: text.trim() }))
    .filter(({ text }) => /^(-\s*)?uses:\s*[^.\s]/.test(text));

const externalUses = (): Use[] =>
  readdirSync(WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((file) => usesIn(file, readFileSync(join(WORKFLOWS, file), 'utf8')));

const unpinned = (uses: Use[]) =>
  uses.filter(({ text }) => !/@[0-9a-f]{40}(?=\s|$)/.test(text)).map(({ where, text }) => `${where} ${text}`);

const unlabelled = (uses: Use[]) =>
  uses.filter(({ text }) => !/@[0-9a-f]{40}\s+#\s*v\d/.test(text)).map(({ where, text }) => `${where} ${text}`);

/**
 * The config with its YAML comments removed. ASSERT ON THIS, never on the
 * raw text.
 *
 * These checks read source text, and this file DOCUMENTS the very patterns it
 * is checked for. Matched against the raw text, that prose SATISFIES a guard
 * on its own: shyden.co.uk's note spelled out `patterns: ["actions/cache*"]`
 * and passed its sub-path guard with no group configured (issue #23).
 */
const configBody = () => withoutYamlComments(readFileSync(DEPENDABOT, 'utf8'));

/**
 * Every `owner/repo` used at MORE THAN ONE sub-path, with the distinct refs
 * seen for it: the ones Dependabot would otherwise bump one sub-path at a
 * time, leaving the siblings behind.
 */
const subPathRepos = (uses: Use[]): [string, Set<string>][] => {
  const refs = new Map<string, Set<string>>();
  for (const { text } of uses) {
    const ref = /uses:\s*([^@\s]+)@/.exec(text)?.[1];
    if (ref === undefined) continue;
    const [owner, repo] = ref.split('/');
    const key = `${owner}/${repo}`;
    refs.set(key, (refs.get(key) ?? new Set()).add(ref));
  }
  return [...refs.entries()].filter(([, seen]) => seen.size > 1);
};

const ungroupedSubPaths = (uses: Use[], config: string) =>
  subPathRepos(uses)
    .filter(([key]) => !withoutYamlQuotes(config).includes(`${key}*`))
    .map(([key, refs]) => `${key} used at ${refs.size} sub-paths, ungrouped`);

/** How many times `pattern` occurs in `text`. */
const count = (text: string, pattern: RegExp) => text.split(pattern).length - 1;

const SHA = 'a'.repeat(40);

/**
 * Each action pinned at more than one SHA across the workflows: a bump that
 * reached one file and missed another. Named with every SHA and where it is.
 */
const splitPins = (uses: Use[]) => {
  const pins = new Map<string, Map<string, string[]>>();
  for (const { where, text } of uses) {
    const pin = /uses:\s*([^@\s]+)@([0-9a-f]{40})(?![0-9a-f])/.exec(text);
    if (pin === null) continue;
    const [, action, sha] = pin as unknown as [string, string, string];
    const shas = pins.get(action) ?? new Map<string, string[]>();
    shas.set(sha, [...(shas.get(sha) ?? []), where]);
    pins.set(action, shas);
  }
  return [...pins.entries()]
    .filter(([, shas]) => shas.size > 1)
    .map(([action, shas]) => `${action} at ${[...shas].map(([sha, at]) => `${sha.slice(0, 7)} (${at.join(', ')})`).join(' and ')}`);
};

describe('the CI supply chain is pinned', () => {
  it('pins each action at one SHA in every workflow, judged over every pinned use', () => {
    const uses = externalUses();
    expect({ pinned: uses.length, split: splitPins(uses) }).toEqual({ pinned: 15, split: [] });
  });

  it('names an action whose bump reached one workflow and missed another', () => {
    const other = 'b'.repeat(40);
    expect(
      splitPins([
        { where: 'ci.yml:3', text: `uses: actions/setup-node@${SHA} # v7.0.0` },
        { where: 'logs.yml:9', text: `uses: actions/setup-node@${other} # v7.1.0` },
        { where: 'ci.yml:4', text: `uses: actions/setup-node@${SHA} # v7.0.0` },
        { where: 'ci.yml:5', text: 'uses: actions/checkout@v4' },
      ]),
    ).toEqual(['actions/setup-node at aaaaaaa (ci.yml:3, ci.yml:4) and bbbbbbb (logs.yml:9)']);
  });

  it('there is something to check', () => {
    expect(externalUses().length).toBeGreaterThan(0);
  });

  it('reads the uses: lines of a workflow, leaving out local actions', () => {
    expect(usesIn('ci.yml', `steps:\n  - uses: actions/checkout@${SHA}\n  - uses: ./.github/actions/x\n`)).toEqual([
      { where: 'ci.yml:2', text: `- uses: actions/checkout@${SHA}` },
    ]);
  });

  it('every third-party action is pinned to a full commit SHA', () => {
    expect(unpinned(externalUses()), 'a mutable tag can be repointed under us').toEqual([]);
  });

  it('names an action pinned to a tag', () => {
    expect(unpinned([{ where: 'ci.yml:3', text: 'uses: actions/checkout@v4' }])).toEqual([
      'ci.yml:3 uses: actions/checkout@v4',
    ]);
  });

  it('every pinned action names the version its SHA resolves to', () => {
    expect(unlabelled(externalUses()), 'a bare SHA bump is unreviewable by a human').toEqual([]);
  });

  it('names a SHA with no version comment', () => {
    expect(unlabelled([{ where: 'ci.yml:3', text: `uses: actions/checkout@${SHA}` }])).toEqual([
      `ci.yml:3 uses: actions/checkout@${SHA}`,
    ]);
  });
});

describe('Dependabot keeps the pins from rotting', () => {
  /**
   * ShyTalk shipped this bug, so it is guarded here before it can happen.
   *
   * Dependabot treats `actions/cache`, `actions/cache/restore` and
   * `actions/cache/save` as three SEPARATE dependencies. Ungrouped, they
   * arrive as three PRs, each moving one sub-path's SHA while its siblings
   * lag: a one-SHA-per-repo violation by construction (ShyTalk's SHY-0226).
   * This repo uses no sub-path action today, so the planted case below is
   * what shows the check working.
   */
  it('an action repo used at more than one sub-path is grouped into one PR', () => {
    expect(ungroupedSubPaths(externalUses(), configBody())).toEqual([]);
  });

  const cacheUses: Use[] = [
    { where: 'ci.yml:1', text: `uses: actions/cache/restore@${SHA} # v4.0.0` },
    { where: 'ci.yml:2', text: `uses: actions/cache/save@${SHA} # v4.0.0` },
    { where: 'ci.yml:3', text: 'uses: docker://alpine:3' },
    { where: 'ci.yml:4', text: `uses: actions/checkout@${SHA} # v7.0.1` },
  ];

  it('names an action repo used at two sub-paths with no group', () => {
    expect(ungroupedSubPaths(cacheUses, 'groups:\n  patch-updates:\n')).toEqual([
      'actions/cache used at 2 sub-paths, ungrouped',
    ]);
  });

  it('accepts that repo once a group names it', () => {
    expect(ungroupedSubPaths(cacheUses, "groups:\n  cache:\n    patterns:\n      - 'actions/cache*'\n")).toEqual([]);
  });

  /**
   * Declaring the group is not enough: it has to be the ONLY group that can
   * hold the package. Dependabot scores every group that matches, and a group
   * with no patterns outscores any wildcard, so a catch-all must exclude each
   * pattern group's patterns (Shyden 2026-10-20; issue #39). Order decides
   * nothing. The model and its planted cases are in dependabot-groups.test.ts.
   */
  it("each pattern group's packages can land in that group alone, judged over every group read", () => {
    const ecosystems = parseGroups(withoutYamlQuotes(configBody()));
    expect({
      judged: ecosystems.map(({ ecosystem, groups }) => [ecosystem, groups.map(({ name }) => name)]),
      leaks: ecosystems.flatMap(leaks),
    }).toEqual({
      judged: [
        ['npm', ['vitest', 'patch-updates']],
        ['github-actions', ['actions-subpaths', 'patch-updates']],
      ],
      leaks: [],
    });
  });

  it('a Dependabot config exists', () => {
    expect(existsSync(DEPENDABOT)).toBe(true);
  });

  it('watches npm AND the GitHub Actions themselves', () => {
    const config = configBody();

    expect(config, 'npm dependencies unwatched').toMatch(/package-ecosystem:\s*["']?npm["']?/);
    expect(config, 'the actions that run CI are unwatched').toMatch(/package-ecosystem:\s*["']?github-actions["']?/);
  });

  it('opens every PR against develop, never straight at main', () => {
    const config = configBody();
    const ecosystems = count(config, /package-ecosystem:/);

    expect(ecosystems, 'no ecosystems declared').toBeGreaterThan(0);
    expect(
      count(config, /target-branch:\s*["']?develop["']?/),
      'an ecosystem defaults to the default branch, bypassing the develop gate',
    ).toBe(ecosystems);
    expect(config).not.toMatch(/target-branch:\s*["']?main["']?/);
  });
});
