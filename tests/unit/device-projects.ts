/**
 * Checks for a repository's device suite (issue #26; Shyden 2026-10-16:
 * "the suite should be exactly the same, run in parallel. Treat it as every
 * mobile test is mobile. this means if it's mobile, it's Android AND iOS. not
 * separate tests for each."). A mobile test is written once and every phone
 * runs that same file, so the phone projects of `playwright.config.ts` must
 * resolve to exactly the same files, no test may be named for one platform,
 * and each phone says how its input reaches the page: real taps, or a marked
 * stand-in. `tests/unit/device-suite.test.ts` applies these to the repository.
 */
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, matchesGlob, relative, sep } from 'node:path';
import { withoutTsComments } from './source-text';

export interface DeviceProject {
  name: string;
  testDir?: string;
  testMatch?: string | string[];
  testIgnore?: string | string[];
  metadata?: { phone?: string; input?: string };
}

export interface DeviceConfig {
  testDir?: string;
  testMatch?: string | string[];
  testIgnore?: string | string[];
  projects?: DeviceProject[];
}

/** Playwright's default test match, as a glob. */
const DEFAULT_MATCH = '**/*.{spec,test}.{ts,mts,cts,tsx,js,mjs,cjs,jsx}';
/** A platform named as a word. */
const PLATFORM = /\b(?:android|ios|iphone)\b/i;
/** A test's or a group's title: `test(`, `it(`, `describe(`, `test.describe(` and the like, then a quoted title. */
const TITLE = /\b(?:test|it|describe)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

const list = (value: string | string[] | undefined): string[] => (value === undefined ? [] : [value].flat());

/** The projects that run on a phone: each says which in `metadata.phone`. */
export function phoneProjects(config: DeviceConfig): DeviceProject[] {
  return (config.projects ?? []).filter((p) => p.metadata?.phone !== undefined);
}

/** The test files a project runs, relative to `root` and sorted, read from the filesystem. */
export function projectFiles(config: DeviceConfig, project: DeviceProject, root: string): string[] {
  const dir = join(root, project.testDir ?? config.testDir ?? '.');
  if (!existsSync(dir)) return [];
  const match = list(project.testMatch ?? config.testMatch ?? DEFAULT_MATCH);
  const ignore = list(project.testIgnore ?? config.testIgnore);
  return globSync(match, { cwd: dir })
    .filter((f) => !ignore.some((g) => matchesGlob(f, g)))
    .map((f) => relative(root, join(dir, f)).split(sep).join('/'))
    .sort();
}

/** Each file one phone does not run that another does: the sets must be equal, both ways. */
export function unequalSets(sets: Map<string, string[]>): string[] {
  const all = new Set([...sets.values()].flat());
  return [...sets.entries()].flatMap(([name, files]) =>
    [...all].filter((f) => !files.includes(f)).sort().map((f) => `${name} does not run ${f}, which another phone runs`),
  );
}

/** Each file whose path, or a test or group title in it, names one platform. Titles are read from comment-stripped text. */
export function platformNamed(files: Map<string, string>): string[] {
  return [...files.entries()].flatMap(([path, text]) => {
    if (PLATFORM.test(path.split('/').join(' ').replace(/[._-]/g, ' '))) return [`${path}: its path is named for one platform`];
    return [...withoutTsComments(text).matchAll(TITLE)]
      .map((m) => m[2] as string)
      .filter((title) => PLATFORM.test(title))
      .map((title) => `${path}: the test "${title}" is named for one platform`);
  });
}

/** Each file's text, by path relative to `root`. */
export function readAll(files: string[], root: string): Map<string, string> {
  return new Map(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
}

/** The findings no exemption covers: an exemption names a file by its whole path. */
export function unexempted(findings: string[], exempt: string[]): string[] {
  return findings.filter((f) => !exempt.some((e) => f.startsWith(`${e}:`)));
}

/** Each phone that does not say how input reaches the page. */
export function inputProblems(projects: DeviceProject[]): string[] {
  return projects
    .filter((p) => p.metadata?.input !== 'real' && p.metadata?.input !== 'stand-in')
    .map((p) => `${p.name} must say metadata.input: "real" (real taps) or "stand-in" (anything weaker, marked)`);
}

/** The files Shyden let be named for one platform; each entry carries his name, the date and his words. */
export function parseExemptions(text: string): string[] {
  const entries = JSON.parse(text) as unknown;
  if (!Array.isArray(entries)) throw new Error('device-projects: the exemptions file must be a JSON list');
  return entries.map((e: Record<string, unknown>, i) => {
    if (
      typeof e.path !== 'string' ||
      e.path === '' ||
      e.grantedBy !== 'Shyden' ||
      typeof e.on !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(e.on) ||
      typeof e.words !== 'string' ||
      e.words.trim() === ''
    ) {
      throw new Error(`device-projects: entry ${i + 1} must be granted by Shyden, with the date and his words`);
    }
    return e.path;
  });
}
