import type { ViteUserConfig } from 'vitest/config';
import unit from './vitest.unit.config.ts';
import integration from './vitest.integration.config.ts';

// The coverage run (`npm run test:coverage`, docs/coverage.md): the unit and
// integration suites in one run, each on its own files, so a test or script
// only the integration suite runs is measured too (#92, toward #66). The 1 s
// unit step (`npm run test:unit`) runs without coverage.
export default {
  test: {
    projects: [{ test: { name: 'unit', ...unit.test } }, { test: { name: 'integration', ...integration.test } }],
  },
} satisfies ViteUserConfig;
