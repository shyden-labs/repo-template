import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import { runIfEntry } from '../../scripts/cli';

/**
 * Every script's command-line entry goes through `runIfEntry`, so the branch
 * that decides "was I started, or imported?" lives in one place and is tested
 * here in-process, with a stand-in for `process` (issue #32: every line runs,
 * and a unit test starts no process).
 */

const SCRIPT = '/repo/scripts/tool.ts';
const URL_OF_SCRIPT = pathToFileURL(SCRIPT).href;

function fakeProcess(argv: string[]) {
  const exits: number[] = [];
  return { proc: { argv, exit: (code: number) => void exits.push(code) }, exits };
}

describe('runIfEntry', () => {
  it('runs main with the arguments after the script, and exits with its code', () => {
    const { proc, exits } = fakeProcess(['node', SCRIPT, 'a', 'b']);
    const seen: string[][] = [];
    runIfEntry(URL_OF_SCRIPT, (args) => (seen.push(args), 3), proc);
    expect(seen).toEqual([['a', 'b']]);
    expect(exits).toEqual([3]);
  });

  it('does nothing when another file is the program (the script was imported)', () => {
    const { proc, exits } = fakeProcess(['node', '/repo/node_modules/vitest/vitest.mjs']);
    let ran = false;
    runIfEntry(URL_OF_SCRIPT, () => ((ran = true), 0), proc);
    expect(ran).toBe(false);
    expect(exits).toEqual([]);
  });

  it('does nothing when there is no program path at all', () => {
    const { proc, exits } = fakeProcess(['node']);
    let ran = false;
    runIfEntry(URL_OF_SCRIPT, () => ((ran = true), 0), proc);
    expect(ran).toBe(false);
    expect(exits).toEqual([]);
  });

  it('defaults to the real process, which a test file is never the entry of', () => {
    let ran = false;
    runIfEntry(URL_OF_SCRIPT, () => ((ran = true), 0));
    expect(ran).toBe(false);
  });
});
