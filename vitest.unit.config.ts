import type { ViteUserConfig } from 'vitest/config';
import { UNIT_SETUP } from './tests/setup/files.ts';
import { failOnWarnings } from './tests/setup/warnings.ts';

// The unit suite: tests under tests/unit only. The logs suite
// (vitest.logs.config.ts, docs/logs-suite.md) runs before a release, not here.
// Its limits (docs/unit-limits.md, #92): 1 s per test and hook, and the
// setup shims judge each test's own CPU and each file's load; never raised
// (hooks/unit-limit-never-raised.py). Each file runs in its own forked
// process, so one thread's CPU is one file's. A type-only import:
// `defineConfig` only types the object, and importing `vitest/config` at run
// time cost every test file that reads this config ~100 ms of CPU to load.
export default {
  plugins: [failOnWarnings],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: UNIT_SETUP,
    testTimeout: 1_000,
    hookTimeout: 1_000,
    pool: 'forks',
    reporters: ['default', './tests/setup/limits-reporter.ts'],
  },
} satisfies ViteUserConfig;
