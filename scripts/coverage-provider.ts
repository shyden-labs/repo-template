/**
 * Vitest's V8 coverage, measuring every code file, tests included (issue #32;
 * Shyden 2026-10-22: tests and tool configs are code). Vitest always adds the
 * test files, setup files and config file to `coverage.exclude`, and its source
 * says user config cannot override that, so this provider keeps everything V8
 * does and replaces only that list. `npm run test:coverage` names it with
 * `--coverage.provider=custom --coverage.customProviderModule=...`.
 */
import v8 from '@vitest/coverage-v8';
import { V8CoverageProvider } from '@vitest/coverage-v8/dist/provider.js';

/** What coverage never measures: dependencies, what tools write, and Vite's virtual modules. */
export const EXCLUDE = ['**/node_modules/**', 'coverage/**', '**/virtual:*', '**/__x00__*'];

export class AllCodeProvider extends V8CoverageProvider {
  override initialize(ctx: Parameters<V8CoverageProvider['initialize']>[0]): void {
    super.initialize(ctx);
    this.options.exclude = [...EXCLUDE];
  }
}

// V8 keeps its inspector session on its own module object (`this.session`).
// Vitest can load this module afresh between starting and taking coverage in a
// worker (it does when the run has `projects`), so each hook runs on V8's own
// object, never on a copy of it (#92).
export default {
  ...v8,
  startCoverage: v8.startCoverage?.bind(v8),
  takeCoverage: v8.takeCoverage?.bind(v8),
  stopCoverage: v8.stopCoverage?.bind(v8),
  getProvider: (): Promise<AllCodeProvider> => Promise.resolve(new AllCodeProvider()),
};
