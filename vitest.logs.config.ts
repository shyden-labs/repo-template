import type { ViteUserConfig } from 'vitest/config';

// The logs suite (docs/logs-suite.md): the checks of the code that writes,
// keeps or replays logs and audit trails. It runs in CI before a release
// (.github/workflows/logs.yml), never on a pull request. It holds no
// passWithNoTests: an empty suite fails, so a release cannot pass on nothing.
// Typed only, as vitest.unit.config.ts explains (#92).
export default {
  test: { include: ['tests/logs/**/*.test.ts'] },
} satisfies ViteUserConfig;
