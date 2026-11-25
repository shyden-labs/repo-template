/**
 * The absolute path of each command the scripts run, found only in fixed folders and never through
 * PATH (SonarCloud S4036; shyden-labs/repo-template#217). A planted `gh` early on PATH would
 * otherwise run with the App's token. The folders differ on the Mac and on CI
 * (shyden-labs/repo-template#188), so each is tried in the Mac's own order; npm is taken first from
 * beside the node that runs the script, where every Node install puts it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TOOL_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

export type Tool = 'gh' | 'git' | 'npm';

export function toolPath(name: Tool, isFile: (path: string) => boolean = existsSync, nodeDir: string = dirname(process.execPath)): string {
  const dirs = name === 'npm' ? [nodeDir, ...TOOL_DIRS] : TOOL_DIRS;
  const found = dirs.map((dir) => join(dir, name)).find((path) => isFile(path));
  if (found === undefined) throw new Error(`no ${name} in ${dirs.join(', ')}`);
  return found;
}
