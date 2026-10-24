import { describe, it, expect, vi } from 'vitest';
import provider, { AllCodeProvider, EXCLUDE } from '../../scripts/coverage-provider.ts';

/**
 * The all-code provider's own logic, on stand-ins for `@vitest/coverage-v8`
 * (#92): loading the real one costs ~200 ms of CPU, over the unit load limit,
 * so what it does with real V8 is judged in
 * tests/integration/coverage-provider.test.ts.
 */

const hooks = vi.hoisted(() => ({ startCoverage: vi.fn(), takeCoverage: vi.fn(), stopCoverage: vi.fn() }));

vi.mock('@vitest/coverage-v8', () => ({ default: hooks }));
vi.mock('@vitest/coverage-v8/dist/provider.js', () => ({
  // V8's initialize, reduced to what the subclass depends on: it sets the options.
  V8CoverageProvider: class {
    options: Record<string, unknown> = {};
    initialize(ctx: { _coverageOptions: Record<string, unknown> }): void {
      this.options = { ...ctx._coverageOptions };
    }
  },
}));

describe('the coverage provider, on stand-ins', () => {
  it('hands Vitest the all-code provider', async () => {
    expect(await provider.getProvider()).toBeInstanceOf(AllCodeProvider);
  });

  it("keeps V8's own hooks for starting and taking coverage in each worker", () => {
    expect(provider.startCoverage).toBe(hooks.startCoverage);
    expect(provider.takeCoverage).toBe(hooks.takeCoverage);
    expect(provider.stopCoverage).toBe(hooks.stopCoverage);
  });

  it('lets V8 set every option first, then replaces only the exclusions, with a copy of its own', () => {
    const p = new AllCodeProvider();
    p.initialize({ _coverageOptions: { include: ['**/*.ts'], exclude: ['**/*.test.ts'] } } as never);
    expect(p.options).toEqual({ include: ['**/*.ts'], exclude: EXCLUDE });
    expect(p.options.exclude).not.toBe(EXCLUDE);
  });

  it('excludes only dependencies, what tools write, and virtual modules', () => {
    expect(EXCLUDE).toEqual(['**/node_modules/**', 'coverage/**', '**/virtual:*', '**/__x00__*']);
  });
});
