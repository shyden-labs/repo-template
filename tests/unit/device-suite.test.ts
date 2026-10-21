import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import config from '../../playwright.config.ts';
import { inputProblems, parseExemptions, phoneProjects, platformNamed, projectFiles, readAll, unequalSets, unexempted } from './device-projects.ts';

/**
 * This repository's device suite (issue #26; Shyden 2026-10-16: "if it's
 * mobile, it's Android AND iOS. not separate tests for each"): one project per
 * phone over the SAME files, run in parallel, each phone saying how input
 * reaches the page, and no test named for one platform. The checks themselves
 * are pinned on planted configs in `device-projects.test.ts`.
 */

const phones = phoneProjects(config);
const sets = new Map(phones.map((p) => [p.name, projectFiles(config, p, process.cwd())]));
const files = [...new Set([...sets.values()].flat())].sort();

describe('the device suite', () => {
  it('declares one project per phone', () => {
    expect(phones.map((p) => p.name)).toEqual(['android-chrome', 'ios-safari']);
  });

  it('runs its tests in parallel', () => {
    expect(config.fullyParallel).toBe(true);
  });

  it('has every phone say how input reaches the page', () => {
    expect(inputProblems(phones)).toEqual([]);
  });

  // The template ships no device test. A repository that adds one raises this
  // count in the same change, so the check below is never judged over nothing
  // without saying so.
  it('runs exactly the same test files on every phone, judged over every device test', () => {
    expect({ files: files.length, unequal: unequalSets(sets) }).toEqual({ files: 0, unequal: [] });
  });

  it('is a README step, in one paragraph pointing at the docs', () => {
    expect(readFileSync('README.md', 'utf8')).toContain(
      '12. **Every mobile test is one test, run on Android AND iOS.** Write each device test once in `tests/devices/`; the phone projects in `playwright.config.ts` run exactly the same files in parallel, each saying whether its input is real taps or a marked stand-in, and no test is named for one platform. `tests/unit/device-suite.test.ts` holds the repository to it, and `node scripts/devices-report.ts` checks each run (`docs/devices.md`).',
    );
  });

  it('names no test for one platform, outside the exemptions Shyden granted', () => {
    const exempt = parseExemptions(readFileSync('tests/devices/platform-named.json', 'utf8'));
    expect({ exempt, named: unexempted(platformNamed(readAll(files, process.cwd())), exempt) }).toEqual({ exempt: [], named: [] });
  });
});
