import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../scripts/fold-record';

/**
 * Folding a record run's artifact into the session's still-unpushed commit
 * (issue #30): the bot measured the commit on a scratch ref and pushed
 * nothing; the session copies the files in, amends its own commit and pushes
 * once. It refuses, by name, a dirty tree, a HEAD any remote branch holds, a
 * run that is not a successful record run of exactly this commit, and an
 * artifact for another SHA. `git` and `gh` are stood in: no process starts.
 */

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const run = vi.mocked(execFileSync);

const HEAD = 'a'.repeat(40);
const RUN = '123';
const DIR = join(tmpdir(), `fold-record-${RUN}`);

let repo: string;
let out: string[];

/** Queue the replies of the reads before the download, in the order the fold makes them. */
function before(over: { status?: string; head?: string; remote?: string; run?: object } = {}) {
  run.mockReturnValueOnce(over.status ?? '');
  run.mockReturnValueOnce(`${over.head ?? HEAD}\n`);
  run.mockReturnValueOnce(over.remote ?? '');
  run.mockReturnValueOnce(
    JSON.stringify({ workflowName: 'record', status: 'completed', conclusion: 'success', headSha: HEAD, ...over.run }),
  );
}

/** The download: writes the artifact the way `gh run download` would. */
function artifact(files: Record<string, string>, sha = HEAD) {
  run.mockImplementationOnce(() => {
    mkdirSync(DIR, { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(DIR, 'files', path, '..'), { recursive: true });
      writeFileSync(join(DIR, 'files', path), text);
    }
    writeFileSync(join(DIR, 'sha'), `${sha}\n`);
    writeFileSync(join(DIR, 'message.txt'), 'coverage: recorded by run 123 on refs/floors/30-x/aaaaaaa\n');
    return '';
  });
}

beforeEach(() => {
  run.mockReset();
  repo = mkdtempSync(join(tmpdir(), 'fold-record-repo-'));
  out = [];
  vi.spyOn(process, 'cwd').mockReturnValue(repo);
  vi.spyOn(process.stdout, 'write').mockImplementation((t) => (out.push(String(t)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
  rmSync(DIR, { recursive: true, force: true });
});

const calls = () => run.mock.calls.map((c) => [c[0], c[1]]);

describe('fold-record', () => {
  it.each([[[]], [['12x']], [['1', '2']]])('refuses the arguments %j', (args) => {
    expect(() => main(args)).toThrow('usage: node scripts/fold-record.ts <run-id>');
  });

  it('refuses a tree with uncommitted changes', () => {
    before({ status: ' M package.json\n' });
    expect(() => main([RUN])).toThrow('fold-record: the tree has uncommitted changes; commit or set them aside first');
  });

  it('refuses a HEAD a remote branch already holds, naming it', () => {
    before({ remote: '  origin/30-x\n' });
    expect(() => main([RUN])).toThrow(
      'fold-record: HEAD aaaaaaa is already on origin/30-x; fold only into a commit no remote branch holds',
    );
  });

  it('refuses a run of another workflow', () => {
    before({ run: { workflowName: 'build-and-test' } });
    expect(() => main([RUN])).toThrow('fold-record: run 123 is build-and-test, not record');
  });

  it('refuses a run that has not finished', () => {
    before({ run: { status: 'in_progress', conclusion: '' } });
    expect(() => main([RUN])).toThrow('fold-record: run 123 is in_progress, not a success');
  });

  it('refuses a run that failed', () => {
    before({ run: { conclusion: 'failure' } });
    expect(() => main([RUN])).toThrow('fold-record: run 123 is failure, not a success');
  });

  it('refuses a run that measured another commit', () => {
    before({ run: { headSha: 'b'.repeat(40) } });
    expect(() => main([RUN])).toThrow('fold-record: run 123 measured bbbbbbb, but HEAD is aaaaaaa');
  });

  it('refuses an artifact that names another commit', () => {
    before();
    artifact({ 'coverage-record.json': '{}\n' }, 'c'.repeat(40));
    expect(() => main([RUN])).toThrow('fold-record: the artifact was made from ccccccc, but HEAD is aaaaaaa');
  });

  it('refuses an artifact with no files', () => {
    before();
    artifact({});
    expect(() => main([RUN])).toThrow('fold-record: the artifact holds no files to fold');
  });

  it('copies the files in, stages them and amends HEAD, adding the run line to its message', () => {
    before();
    artifact({ 'coverage-record.json': '{ "a.ts": 1 }\n', 'docs/floors/x.json': '[]\n' });
    run.mockReturnValueOnce('');
    run.mockReturnValueOnce('feat: a change\n\nGaps checked:\n- none\n');
    run.mockReturnValueOnce('');
    expect(main([RUN])).toBe(0);
    expect(readFileSync(join(repo, 'coverage-record.json'), 'utf8')).toBe('{ "a.ts": 1 }\n');
    expect(readFileSync(join(repo, 'docs/floors/x.json'), 'utf8')).toBe('[]\n');
    expect(calls()).toEqual([
      ['git', ['status', '--porcelain']],
      ['git', ['rev-parse', 'HEAD']],
      ['git', ['branch', '-r', '--contains', 'HEAD']],
      ['gh', ['run', 'view', RUN, '--json', 'workflowName,status,conclusion,headSha']],
      ['gh', ['run', 'download', RUN, '--name', 'record', '--dir', DIR]],
      ['git', ['add', '--', 'coverage-record.json', 'docs/floors/x.json']],
      ['git', ['log', '-1', '--format=%B']],
      ['git', ['commit', '--amend', '--file', join(DIR, 'commit-message.txt')]],
    ]);
    expect(readFileSync(join(DIR, 'commit-message.txt'), 'utf8')).toBe(
      'feat: a change\n\nGaps checked:\n- none\n\ncoverage: recorded by run 123 on refs/floors/30-x/aaaaaaa\n',
    );
    expect(out.join('')).toBe(
      'fold-record: folded coverage-record.json, docs/floors/x.json into aaaaaaa from run 123\n' +
        'fold-record: now push the branch once, and delete the scratch ref: git push origin :<scratch ref>\n',
    );
  });

  it('clears a download left by an earlier fold, so stale files never fold in', () => {
    mkdirSync(join(DIR, 'files'), { recursive: true });
    writeFileSync(join(DIR, 'files', 'stale.json'), 'old\n');
    before();
    artifact({ 'coverage-record.json': '{}\n' });
    run.mockReturnValueOnce('');
    run.mockReturnValueOnce('feat: x\n');
    run.mockReturnValueOnce('');
    main([RUN]);
    expect(calls()[5]).toEqual(['git', ['add', '--', 'coverage-record.json']]);
  });
});
