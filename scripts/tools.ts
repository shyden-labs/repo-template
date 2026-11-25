/**
 * The absolute path of each command the scripts run, found only in fixed folders and never through
 * PATH (SonarCloud S4036; shyden-labs/repo-template#217). A planted `gh` early on PATH would
 * otherwise run with the App's token. The folders differ on the Mac and on CI
 * (shyden-labs/repo-template#188), so they are tried in the Mac's own order:
 *   1. beside the node that runs the script, where every Node install puts npm;
 *   2. `~/.local/bin`, where this Mac's `gh` router lives: it runs an agent's calls as the
 *      project's GitHub App, while Homebrew's `gh` is the operator's own login
 *      (shyden-labs/repo-template#219; the same list Shyden chose for playwright-devices);
 *   3. the system folders in `TOOL_DIRS`.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const TOOL_DIRS: readonly string[] = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

export type Tool = 'gh' | 'git' | 'npm';

export function toolPath(
  name: Tool,
  isFile: (path: string) => boolean = existsSync,
  nodeDir: string = dirname(process.execPath),
  home: string = homedir(),
): string {
  const dirs = [nodeDir, join(home, '.local', 'bin'), ...TOOL_DIRS];
  const found = dirs.map((dir) => join(dir, name)).find((path) => isFile(path));
  if (found === undefined) throw new Error(`no ${name} in ${dirs.join(', ')}`);
  return found;
}
