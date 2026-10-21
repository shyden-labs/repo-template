import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inputProblems,
  parseExemptions,
  phoneProjects,
  platformNamed,
  projectFiles,
  readAll,
  unequalSets,
  unexempted,
  type DeviceConfig,
} from './device-projects';

/**
 * Every mobile test is one test, run on Android AND iOS (issue #26; Shyden
 * 2026-10-16: "the suite should be exactly the same, run in parallel ... not
 * separate tests for each"). These pin the checks a repository's device suite
 * is held to, on planted configs and files.
 */

const android = { name: 'android-chrome', metadata: { phone: 'android', input: 'real' } };
const ios = { name: 'ios-safari', metadata: { phone: 'ios', input: 'real' } };

describe('phoneProjects', () => {
  it('takes the projects that name a phone, leaving the rest', () => {
    const config: DeviceConfig = { projects: [android, { name: 'desktop-chrome' }, ios] };
    expect(phoneProjects(config).map((p) => p.name)).toEqual(['android-chrome', 'ios-safari']);
  });

  it('reads a config with no projects as having no phones', () => {
    expect(phoneProjects({})).toEqual([]);
  });
});

describe('projectFiles', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'device-projects-'));
    for (const f of ['tests/devices/a.spec.ts', 'tests/devices/deep/b.test.js', 'tests/devices/helper.ts', 'tests/devices/skip.spec.ts', 'other/c.spec.ts']) {
      mkdirSync(join(root, f, '..'), { recursive: true });
      writeFileSync(join(root, f), '');
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("finds the config's test files the way Playwright's default match does", () => {
    expect(projectFiles({ testDir: 'tests/devices' }, android, root)).toEqual([
      'tests/devices/a.spec.ts',
      'tests/devices/deep/b.test.js',
      'tests/devices/skip.spec.ts',
    ]);
  });

  it("lets a project's own folder, match and ignore win over the config's", () => {
    const config: DeviceConfig = { testDir: 'other', testMatch: '**/*.test.js' };
    const project = { ...ios, testDir: 'tests/devices', testMatch: ['**/*.spec.ts'], testIgnore: '**/skip.spec.ts' };
    expect(projectFiles(config, project, root)).toEqual(['tests/devices/a.spec.ts']);
  });

  it("applies the config's ignore when the project has none", () => {
    expect(projectFiles({ testDir: 'tests/devices', testIgnore: ['**/deep/**'] }, android, root)).toEqual([
      'tests/devices/a.spec.ts',
      'tests/devices/skip.spec.ts',
    ]);
  });

  it('reads the root as the folder when neither config nor project names one', () => {
    expect(projectFiles({}, android, root)).toEqual([
      'other/c.spec.ts',
      'tests/devices/a.spec.ts',
      'tests/devices/deep/b.test.js',
      'tests/devices/skip.spec.ts',
    ]);
  });

  it('reads a missing folder as holding no tests', () => {
    expect(projectFiles({ testDir: 'nowhere' }, android, root)).toEqual([]);
  });
});

describe('unequalSets', () => {
  it('passes phones that run exactly the same files', () => {
    expect(unequalSets(new Map([['android-chrome', ['a', 'b']], ['ios-safari', ['b', 'a']]]))).toEqual([]);
  });

  it('names each file a phone does not run, both ways', () => {
    expect(unequalSets(new Map([['android-chrome', ['a', 'b']], ['ios-safari', ['b', 'c']]]))).toEqual([
      'android-chrome does not run c, which another phone runs',
      'ios-safari does not run a, which another phone runs',
    ]);
  });
});

describe('platformNamed', () => {
  it.each([
    ['a file named for one phone', 'tests/devices/login.android.spec.ts', "test('signs in', () => {});"],
    ['a folder named for one phone', 'tests/devices/ios/login.spec.ts', "test('signs in', () => {});"],
    ['a test titled for one phone', 'tests/devices/login.spec.ts', "test('signs in on iPhone', () => {});"],
    ['a describe titled for one phone', 'tests/devices/login.spec.ts', 'test.describe("Android only", () => {});'],
    ['a template-literal title', 'tests/devices/login.spec.ts', 'it(`iOS taps`, () => {});'],
  ])('names %s', (_kind, path, text) => {
    expect(platformNamed(new Map([[path, text]]))).toHaveLength(1);
  });

  it('names the file and the title it found', () => {
    expect(platformNamed(new Map([['tests/devices/login.spec.ts', "test('signs in on iPhone', () => {});"]]))).toEqual([
      'tests/devices/login.spec.ts: the test "signs in on iPhone" is named for one platform',
    ]);
  });

  it.each([
    ['words that only contain a platform name', 'tests/devices/radios.spec.ts', "test('scenarios and radios', () => {});"],
    ['a platform-named title only in a comment', 'tests/devices/a.spec.ts', "// test('android only') was retired\ntest('signs in', () => {});"],
    ['a platform named in a step, not a title', 'tests/devices/a.spec.ts', "test('signs in', () => { expect('ios').toBe('ios'); });"],
  ])('passes %s', (_kind, path, text) => {
    expect(platformNamed(new Map([[path, text]]))).toEqual([]);
  });
});

describe('unexempted', () => {
  it('keeps each finding no exemption covers, matching the exempt file by its whole path', () => {
    expect(
      unexempted(['tests/devices/a.ios.spec.ts: its path is named for one platform', 'tests/devices/b.spec.ts: the test "iOS" is named for one platform'], ['tests/devices/a.ios.spec.ts', 'tests/devices/b']),
    ).toEqual(['tests/devices/b.spec.ts: the test "iOS" is named for one platform']);
  });
});

describe('readAll', () => {
  it('reads each file into a map of path to text', () => {
    const root = mkdtempSync(join(tmpdir(), 'device-read-'));
    writeFileSync(join(root, 'a.spec.ts'), 'x');
    expect(readAll(['a.spec.ts'], root)).toEqual(new Map([['a.spec.ts', 'x']]));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('inputProblems', () => {
  it('passes phones that each say how input reaches the page', () => {
    expect(inputProblems([android, { ...ios, metadata: { phone: 'ios', input: 'stand-in' } }])).toEqual([]);
  });

  it.each([
    ['no input mode', { name: 'ios-safari', metadata: { phone: 'ios' } }],
    ['an unknown input mode', { name: 'ios-safari', metadata: { phone: 'ios', input: 'dom' } }],
  ])('names a phone with %s', (_kind, project) => {
    expect(inputProblems([project])).toEqual([
      'ios-safari must say metadata.input: "real" (real taps) or "stand-in" (anything weaker, marked)',
    ]);
  });
});

describe('parseExemptions', () => {
  const ok = { path: 'tests/devices/x.spec.ts', grantedBy: 'Shyden', on: '2026-10-22', words: 'leave it' };

  it('reads the list of files Shyden let be named for one platform', () => {
    expect(parseExemptions(JSON.stringify([ok]))).toEqual(['tests/devices/x.spec.ts']);
  });

  it.each([
    ['not a list', '{}', 'the exemptions file must be a JSON list'],
    ['an entry not granted by Shyden', JSON.stringify([{ ...ok, grantedBy: 'a session' }]), 'entry 1 must be granted by Shyden, with the date and his words'],
    ['an entry with no date', JSON.stringify([{ ...ok, on: 'today' }]), 'entry 1 must be granted by Shyden, with the date and his words'],
    ['an entry with no words', JSON.stringify([{ ...ok, words: '' }]), 'entry 1 must be granted by Shyden, with the date and his words'],
    ['an entry with no path', JSON.stringify([{ ...ok, path: '' }]), 'entry 1 must be granted by Shyden, with the date and his words'],
  ])('refuses %s', (_kind, text, message) => {
    expect(() => parseExemptions(text)).toThrow(`device-projects: ${message}`);
  });
});
