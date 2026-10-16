import { defineConfig } from 'vitest/config';

// The logs suite (docs/logs-suite.md): the checks of the code that writes,
// keeps or replays logs and audit trails. It runs in CI before a release
// (.github/workflows/logs.yml), never on a pull request. It holds no
// passWithNoTests: an empty suite fails, so a release cannot pass on nothing.
export default defineConfig({
  test: { include: ['tests/logs/**/*.test.ts'] },
});
