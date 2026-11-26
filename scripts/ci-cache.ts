/**
 * Keeps a CI download cache to what a run used (issue shyden-labs/repo-template#224; Shyden
 * 2026-11-26: "do the same for any other downloads we do in CI. always make
 * sure we still check for a newer version though"):
 *
 *   node scripts/ci-cache.ts reset <dir>
 *   node scripts/ci-cache.ts keep <dir> <key-prefix> >> "$GITHUB_OUTPUT"
 *
 * The cache is restored by prefix and the tool still fetches what it wants,
 * so a newer version is never blocked. `reset` runs after the restore: every
 * cached file's access time goes to the epoch (its modification time is
 * kept), so the disk stamps a fresh access time on each file the run reads.
 * `keep` runs after the tool: it drops each top-level entry none of whose
 * files was read (an older scanner, a replaced JRE or plugin) and prints
 * `key=<prefix><hash of what is left>`, so the cache is saved only when its
 * contents changed. A run that read nothing fails rather than empty the
 * cache: the disk would then not be recording reads.
 * It runs in the token's job, which installs nothing, so it imports nothing outside node.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, lutimesSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runIfEntry } from './cli.ts';

const USAGE = 'usage: node scripts/ci-cache.ts reset <dir> | keep <dir> <key-prefix>';

/** Each file below `dir`, by its full path. */
const filesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

/** The entries, from each one's latest file access time, that no read touched. */
export function unread(lastRead: Record<string, number>): string[] {
  return Object.entries(lastRead)
    .filter(([, at]) => at === 0)
    .map(([name]) => name);
}

/** The cache key naming exactly these entries, whatever their order. */
export function contentKey(prefix: string, kept: string[]): string {
  return (
    prefix +
    createHash('sha256')
      .update([...kept].sort().join('\n'))
      .digest('hex')
      .slice(0, 16)
  );
}

/** Marks every cached file unread, keeping when it was written. */
export function reset(dir: string): void {
  if (!existsSync(dir)) return;
  for (const file of filesIn(dir)) lutimesSync(file, 0, lstatSync(file).mtime);
}

/** Drops each entry the run did not read and returns the key naming the rest. */
export function keep(dir: string, prefix: string): string {
  if (!existsSync(dir)) throw new Error(`${dir} does not exist after the run`);
  // Every top-level entry starts unread; each file lifts its own entry to the latest read.
  const lastRead: Record<string, number> = Object.fromEntries(readdirSync(dir).map((name) => [name, 0]));
  for (const file of filesIn(dir)) {
    const name = file.slice(dir.length + 1).replace(/\/.*$/s, '');
    lastRead[name] = Math.max(lastRead[name] as number, lstatSync(file).atimeMs);
  }
  const dropped = unread(lastRead);
  const kept = Object.keys(lastRead).filter((name) => !dropped.includes(name));
  if (kept.length === 0) throw new Error(`nothing in ${dir} was read: the disk is not recording reads, so nothing is dropped`);
  for (const name of dropped) rmSync(join(dir, name), { recursive: true, force: true });
  process.stderr.write(`${dir}: kept ${kept.join(', ')}; dropped ${dropped.join(', ') || 'nothing'}\n`);
  return contentKey(prefix, kept);
}

export function main(args: string[] = process.argv.slice(2)): number {
  const [command, dir, prefix] = args;
  if (command === 'reset' && dir !== undefined && args.length === 2) reset(dir);
  else if (command === 'keep' && dir !== undefined && prefix !== undefined && args.length === 3)
    process.stdout.write(`key=${keep(dir, prefix)}\n`);
  else throw new Error(USAGE);
  return 0;
}

await runIfEntry(import.meta.url, main);
