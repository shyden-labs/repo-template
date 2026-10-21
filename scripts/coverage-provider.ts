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

export default { ...v8, getProvider: async (): Promise<AllCodeProvider> => new AllCodeProvider() };
