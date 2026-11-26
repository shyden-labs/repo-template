import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, lstatSync, lutimesSync, readdirSync, rmSync, type Dirent, type Stats } from 'node:fs';
import { contentKey, keep, main, reset, unread } from '../../scripts/ci-cache.ts';

/**
 * scripts/ci-cache.ts keeps a CI download cache to what a run used (issue
 * shyden-labs/repo-template#224): `reset` marks every cached file unread (its
 * access time set to the epoch, its modification time kept), so any file the
 * run reads gets a fresh access time; `keep` then drops each top-level entry
 * none of whose files was read, and prints a key naming what is left.
 */

// The cache folder is stood in: a unit test reads and writes no real folder.
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  lutimesSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

/** A stood-in folder: each file's path below the cache folder and its access time in ms. */
const folder = (files: Record<string, number>) => {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readdirSync).mockImplementation(((dir: string, options?: { recursive?: boolean }) => {
    const names = Object.keys(files);
    if (options?.recursive) {
      return names.map((name) => {
        const at = name.lastIndexOf('/');
        return { name: name.slice(at + 1), parentPath: `${dir}/${name.slice(0, at)}`.replace(/\/$/, ''), isFile: () => true };
      }) as unknown as Dirent[];
    }
    return [...new Set(names.map((n) => n.split('/')[0]))];
  }) as typeof readdirSync);
  vi.mocked(lstatSync).mockImplementation(((path: string) => {
    const name = path.slice(path.indexOf('/cache/') + '/cache/'.length);
    return { atimeMs: files[name], mtime: new Date(5_000) } as Stats;
  }) as typeof lstatSync);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('unread', () => {
  it('names each entry none of whose files was read', () => {
    expect(unread({ '8.4.0': 1_700, '8.3.0': 0, _tmp: 0 })).toEqual(['8.3.0', '_tmp']);
  });

  it('names nothing when every entry was read', () => {
    expect(unread({ a: 1, b: 2 })).toEqual([]);
  });
});

describe('contentKey', () => {
  it('names the kept entries whatever their order', () => {
    expect(contentKey('p-', ['b', 'a'])).toBe(contentKey('p-', ['a', 'b']));
    expect(contentKey('p-', ['a', 'b'])).toMatch(/^p-[0-9a-f]{16}$/);
  });

  it('changes when an entry changes', () => {
    expect(contentKey('p-', ['a'])).not.toBe(contentKey('p-', ['b']));
  });
});

describe('reset', () => {
  it('sets every file unread and keeps when it was written', () => {
    folder({ 'x/one': 9, 'y/z/two': 9 });
    reset('/r/cache');
    expect(vi.mocked(lutimesSync).mock.calls).toEqual([
      ['/r/cache/x/one', 0, new Date(5_000)],
      ['/r/cache/y/z/two', 0, new Date(5_000)],
    ]);
  });

  it('does nothing when nothing was restored', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    reset('/r/cache');
    expect(readdirSync).not.toHaveBeenCalled();
  });
});

describe('keep', () => {
  it('drops each unread entry and names what is left', () => {
    folder({ 'old/jre/bin/java': 0, 'new/jre/bin/java': 1_700, 'new/jre/lib/x': 0, 'plugin/p.jar': 1_800 });
    expect(keep('/r/cache', 'sonar-')).toBe(contentKey('sonar-', ['new', 'plugin']));
    expect(vi.mocked(rmSync).mock.calls).toEqual([['/r/cache/old', { recursive: true, force: true }]]);
  });

  it('fails naming the folder when the run left none', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => keep('/r/cache', 'sonar-')).toThrow('/r/cache does not exist after the run');
  });

  it('fails when the run read nothing, so an access-time-blind disk is never mistaken for an unused cache', () => {
    folder({ 'a/f': 0 });
    expect(() => keep('/r/cache', 'sonar-')).toThrow('nothing in /r/cache was read');
    expect(rmSync).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  it('resets', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(main(['reset', '/r/cache'])).toBe(0);
  });

  it('keeps, printing the key for GITHUB_OUTPUT', () => {
    folder({ 'a/f': 1 });
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(main(['keep', '/r/cache', 'p-'])).toBe(0);
    expect(out).toHaveBeenCalledWith(`key=${contentKey('p-', ['a'])}\n`);
    out.mockRestore();
  });

  it.each([[[]], [['reset']], [['keep', '/r/cache']], [['other', '/r/cache', 'p-']]])('refuses %j', (args) => {
    expect(() => main(args)).toThrow('usage: node scripts/ci-cache.ts reset <dir> | keep <dir> <key-prefix>');
  });
});
