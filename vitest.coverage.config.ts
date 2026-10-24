import type { ViteUserConfig } from 'vitest/config';
import unit from './vitest.unit.config.ts';
import integration from './vitest.integration.config.ts';
import { UNIT_JUDGES } from './tests/setup/files.ts';

// The coverage run (`npm run test:coverage`, docs/coverage.md): the unit and
// integration suites in one run, each on its own files, so a test or script
// only the integration suite runs is measured too (#92, toward #66). The 1 s
// unit step (`npm run test:unit`) runs without coverage. Instrumented code runs
// slower than the unit limits allow, so the unit project here leaves out the
// judges and the 1 s timeouts (docs/unit-limits.md); the judges' own logic is
// covered by tests/unit/unit-limits.test.ts.
export default {
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: unit.test.include,
          pool: unit.test.pool,
          setupFiles: unit.test.setupFiles.filter((file) => !UNIT_JUDGES.includes(file)),
        },
      },
      { test: { name: 'integration', ...integration.test } },
    ],
  },
} satisfies ViteUserConfig;
