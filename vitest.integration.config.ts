import type { ViteUserConfig } from 'vitest/config';

// The integration suite (docs/unit-limits.md, #92): a case that cannot fit the
// unit limits (1 s, 0.1 s of its own CPU, 0.1 s to load its file, no process,
// no connection) moves here, and the unit suite keeps a stand-in of its logic.
// Its one limit is the CI step's (.github/workflows/ci.yml), none inside. It
// holds no passWithNoTests: an empty suite fails. Typed only (#92).
export default {
  test: { include: ['tests/integration/**/*.test.ts'] },
} satisfies ViteUserConfig;
