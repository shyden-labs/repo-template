import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_DIRS, toolPath } from '../../scripts/tools.ts';

/** A stand-in file system holding only these paths. */
const only =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

const NODE_DIR = '/opt/hostedtoolcache/node/26.3.0/x64/bin';
const savedPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = savedPath;
});

describe('toolPath (SonarCloud S4036: a command never comes from PATH)', () => {
  it('finds gh in the one fixed folder that holds it', () => {
    expect(toolPath('gh', only('/usr/bin/gh'), NODE_DIR)).toBe('/usr/bin/gh');
  });

  it('prefers Homebrew over the system folder, as the Mac does', () => {
    expect(toolPath('git', only('/usr/bin/git', '/opt/homebrew/bin/git'), NODE_DIR)).toBe('/opt/homebrew/bin/git');
  });

  it('takes npm from beside the node that runs the script', () => {
    expect(toolPath('npm', only(`${NODE_DIR}/npm`, '/usr/local/bin/npm'), NODE_DIR)).toBe(`${NODE_DIR}/npm`);
  });

  it('falls back to the fixed folders for npm when none sits beside node', () => {
    expect(toolPath('npm', only('/usr/local/bin/npm'), NODE_DIR)).toBe('/usr/local/bin/npm');
  });

  it('never looks in a folder that only PATH names', () => {
    process.env.PATH = '/tmp/planted';
    expect(() => toolPath('gh', only('/tmp/planted/gh'), NODE_DIR)).toThrow(/no gh in/);
  });

  it('fails naming the tool and every folder it searched', () => {
    expect(() => toolPath('gh', only(), NODE_DIR)).toThrow(`no gh in ${TOOL_DIRS.join(', ')}`);
  });

  it('searches only absolute, fixed folders', () => {
    expect(TOOL_DIRS).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);
  });
});
