/**
 * Folds a record run's artifact into the session's still-unpushed commit
 * (issue #30; Shyden 2026-10-20/21: never force-push, and no CI bot pushes).
 * The flow, in the order a session runs it (docs/measure-then-commit.md):
 *
 *   git push origin HEAD:refs/floors/<branch>/<short-sha>
 *   gh workflow run record.yml --ref develop -f ref=refs/floors/<branch>/<short-sha>
 *   node scripts/fold-record.ts <run-id>
 *   git push   (once), then: git push origin :refs/floors/<branch>/<short-sha>
 *
 * It refuses, by name, a dirty tree, a HEAD any remote branch holds (amending
 * that would need a force push), a run that is not a successful record run of
 * exactly this commit, and an artifact made from another commit.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runIfEntry } from './cli.ts';

const fail = (message: string): never => {
  throw new Error(`fold-record: ${message}`);
};

const run = (command: string, args: string[]): string => execFileSync(command, args, { encoding: 'utf8' });

/** Every file under `dir`, relative and sorted. */
function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(dir, path) : [path];
    })
    .sort();
}

export function main(args: string[]): number {
  const [id, ...rest] = args;
  if (id === undefined || !/^\d+$/.test(id) || rest.length > 0) {
    throw new Error('usage: node scripts/fold-record.ts <run-id>');
  }
  if (run('git', ['status', '--porcelain']).trim() !== '') {
    fail('the tree has uncommitted changes; commit or set them aside first');
  }
  const head = run('git', ['rev-parse', 'HEAD']).trim();
  const short = head.slice(0, 7);
  const remote = run('git', ['branch', '-r', '--contains', 'HEAD']).trim();
  if (remote !== '') fail(`HEAD ${short} is already on ${remote}; fold only into a commit no remote branch holds`);
  const view = JSON.parse(run('gh', ['run', 'view', id, '--json', 'workflowName,status,conclusion,headSha'])) as {
    workflowName: string;
    status: string;
    conclusion: string;
    headSha: string;
  };
  if (view.workflowName !== 'record') fail(`run ${id} is ${view.workflowName}, not record`);
  if (view.status !== 'completed' || view.conclusion !== 'success') {
    fail(`run ${id} is ${view.status === 'completed' ? view.conclusion : view.status}, not a success`);
  }
  if (view.headSha !== head) fail(`run ${id} measured ${view.headSha.slice(0, 7)}, but HEAD is ${short}`);
  const dir = join(tmpdir(), `fold-record-${id}`);
  rmSync(dir, { recursive: true, force: true });
  run('gh', ['run', 'download', id, '--name', 'record', '--dir', dir]);
  const made = readFileSync(join(dir, 'sha'), 'utf8').trim();
  if (made !== head) fail(`the artifact was made from ${made.slice(0, 7)}, but HEAD is ${short}`);
  const files = existsSync(join(dir, 'files')) ? filesUnder(join(dir, 'files')) : [];
  if (files.length === 0) fail('the artifact holds no files to fold');
  const root = process.cwd();
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(dir, 'files', file), join(root, file));
  }
  run('git', ['add', '--', ...files]);
  const message = `${run('git', ['log', '-1', '--format=%B']).trimEnd()}\n\n${readFileSync(join(dir, 'message.txt'), 'utf8').trim()}\n`;
  writeFileSync(join(dir, 'commit-message.txt'), message);
  run('git', ['commit', '--amend', '--file', join(dir, 'commit-message.txt')]);
  process.stdout.write(`fold-record: folded ${files.join(', ')} into ${short} from run ${id}\n`);
  process.stdout.write('fold-record: now push the branch once, and delete the scratch ref: git push origin :<scratch ref>\n');
  return 0;
}

runIfEntry(import.meta.url, main);
