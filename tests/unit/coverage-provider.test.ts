import { afterEach, describe, it, expect, vi } from 'vitest';

/**
 * The all-code provider's own logic, on stand-ins for `@vitest/coverage-v8`
 * (#92): loading the real one costs ~200 ms of CPU, over the unit load limit,
 * so what it does with real V8 is judged in
 * tests/integration/coverage-provider.test.ts.
 *
 * The stand-ins are registered only while a test runs (`vi.doMock`), never for
 * the whole file (`vi.mock`): the coverage run takes this worker's coverage
 * through the same module after the file ends, and a stand-in still in place
 * then takes none, so the file would read as never run.
 */

const hooks = { startCoverage: vi.fn(), takeCoverage: vi.fn(), stopCoverage: vi.fn() };

// V8's initialize, reduced to what the subclass depends on: it sets the options.
class V8Provider {
  options: Record<string, unknown> = {};
  initialize(ctx: { _coverageOptions: Record<string, unknown> }): void {
    this.options = { ...ctx._coverageOptions };
  }
}

async function loadOnStandIns() {
  vi.doMock('@vitest/coverage-v8', () => ({ default: hooks }));
  vi.doMock('@vitest/coverage-v8/dist/provider.js', () => ({ V8CoverageProvider: V8Provider }));
  return import('../../scripts/coverage-provider.ts');
}

afterEach(() => {
  vi.doUnmock('@vitest/coverage-v8');
  vi.doUnmock('@vitest/coverage-v8/dist/provider.js');
  vi.resetModules();
});

describe('the coverage provider, on stand-ins', () => {
  it('hands Vitest the all-code provider', async () => {
    const { default: provider, AllCodeProvider } = await loadOnStandIns();
    expect(await provider.getProvider()).toBeInstanceOf(AllCodeProvider);
  });

  // V8 keeps its inspector session on its own module object (`this.session`).
  // Vitest can load this module afresh between starting and taking coverage
  // (it does under `projects`), so a hook run on a copy loses the session.
  it.each(['startCoverage', 'takeCoverage', 'stopCoverage'] as const)(
    'runs V8’s own %s on V8’s own object, where its session lives',
    async (name) => {
      const { default: provider } = await loadOnStandIns();
      const options = { isolate: true, reportsDirectory: 'coverage' };
      void provider[name]?.(options as never);
      expect(hooks[name]).toHaveBeenCalledWith(options);
      expect(hooks[name].mock.contexts.at(-1)).toBe(hooks);
    },
  );

  it('lets V8 set every option first, then replaces only the exclusions, with a copy of its own', async () => {
    const { AllCodeProvider, EXCLUDE } = await loadOnStandIns();
    const p = new AllCodeProvider();
    p.initialize({ _coverageOptions: { include: ['**/*.ts'], exclude: ['**/*.test.ts'] } } as never);
    expect(p.options).toEqual({ include: ['**/*.ts'], exclude: EXCLUDE });
    expect(p.options.exclude).not.toBe(EXCLUDE);
  });

  it('excludes only dependencies, what tools write, and virtual modules', async () => {
    const { EXCLUDE } = await loadOnStandIns();
    expect(EXCLUDE).toEqual(['**/node_modules/**', 'coverage/**', '**/virtual:*', '**/__x00__*']);
  });
});
