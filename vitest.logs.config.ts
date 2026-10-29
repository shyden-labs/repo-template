import type { ViteUserConfig } from 'vitest/config';
import { NODE_WARNINGS } from './tests/setup/files.ts';
import { failOnWarnings } from './tests/setup/warnings.ts';

// The logs suite (docs/logs-suite.md): the checks of the code that writes,
// keeps or replays logs and audit trails. It runs in CI before a release
// (.github/workflows/logs.yml), never on a pull request. An empty suite fails,
// so a release cannot pass on nothing.
//
// In shyden-labs/repo-template alone an empty suite passes: the template has
// no log checks of its own, and a pull request that changes logs.yml runs it
// on its own commit (#35 part 6, Shyden 2026-10-28, "Template passes empty").
// A repository made from the template has another name in GITHUB_REPOSITORY,
// so an empty suite fails there.
// Typed only, as vitest.unit.config.ts explains (#92).
export const TEMPLATE = 'shyden-labs/repo-template';

/** The suite's settings for the repository CI names (`GITHUB_REPOSITORY`; unset off CI). */
export function logsTest(repository: string | undefined) {
  return {
    include: ['tests/logs/**/*.test.ts'],
    ...(repository === TEMPLATE ? { passWithNoTests: true } : {}),
  };
}

export default {
  plugins: [failOnWarnings],
  test: { ...logsTest(process.env.GITHUB_REPOSITORY), setupFiles: [NODE_WARNINGS] },
} satisfies ViteUserConfig;
