import { defineConfig } from 'vitest/config';

// The unit suite: tests under tests/unit only. The logs suite
// (vitest.logs.config.ts, docs/logs-suite.md) runs before a release, not here.
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'] },
});
