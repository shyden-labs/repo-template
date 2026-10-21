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

/** A stand-in `process` and `main`, each recording what it was given. */
function harness(argv: string[]) {
  const exits: number[] = [];
  const ran: string[][] = [];
  return {
    proc: { argv, exit: (code: number) => void exits.push(code) },
    main: (args: string[]) => (ran.push(args), 3),
    exits,
    ran,
  };
}

describe('runIfEntry', () => {
  it('runs main with the arguments after the script, and exits with its code', () => {
    const h = harness(['node', SCRIPT, 'a', 'b']);
    runIfEntry(URL_OF_SCRIPT, h.main, h.proc);
    expect(h.ran).toEqual([['a', 'b']]);
    expect(h.exits).toEqual([3]);
  });

  it('does nothing when another file is the program (the script was imported)', () => {
    const h = harness(['node', '/repo/node_modules/vitest/vitest.mjs']);
    runIfEntry(URL_OF_SCRIPT, h.main, h.proc);
    expect(h.ran).toEqual([]);
    expect(h.exits).toEqual([]);
  });

  it('does nothing when there is no program path at all', () => {
    const h = harness(['node']);
    runIfEntry(URL_OF_SCRIPT, h.main, h.proc);
    expect(h.ran).toEqual([]);
    expect(h.exits).toEqual([]);
  });

  it('defaults to the real process, which a test file is never the entry of', () => {
    const h = harness([]);
    runIfEntry(URL_OF_SCRIPT, h.main);
    expect(h.ran).toEqual([]);
  });
});
