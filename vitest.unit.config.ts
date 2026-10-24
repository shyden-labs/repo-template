import type { ViteUserConfig } from 'vitest/config';

// The unit suite: tests under tests/unit only. The logs suite
// (vitest.logs.config.ts, docs/logs-suite.md) runs before a release, not here.
// A type-only import: `defineConfig` only types the object, and importing
// `vitest/config` at run time cost every test file that reads this config
// ~100 ms of CPU to load (#92).
export default {
  test: { include: ['tests/unit/**/*.test.ts'] },
} satisfies ViteUserConfig;
