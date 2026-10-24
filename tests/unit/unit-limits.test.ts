import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TestModule } from 'vitest/node';
import {
  CPU_CUT_MICROSECONDS,
  CPU_LIMIT_MICROSECONDS,
  LOAD_CPU_LIMIT_MICROSECONDS,
  cpuBreach,
  judgeLoad,
  judgeOwnCpu,
  loadBreach,
  measureLoad,
  report,
  startOwnCpu,
  summarise,
} from '../setup/limits.ts';
import LimitsReporter from '../setup/limits-reporter.ts';
import { LOAD, UNIT_CPU, UNIT_JUDGES, UNIT_LOAD_LIMIT, UNIT_REFUSAL, UNIT_SETUP } from '../setup/files.ts';
import unit from '../../vitest.unit.config.ts';
import integration from '../../vitest.integration.config.ts';

/**
 * The unit limits (#92, docs/unit-limits.md): 1 s per test and hook, 0.1 s of
 * each test's own thread CPU, 0.1 s of CPU to load each file. The judges are
 * pure functions handed Vitest's hooks, so these tests hand them stand-ins and
 * call what they register; the shims are loaded with `vitest` stood in.
 */

type Registered = { beforeAll: Call[]; beforeEach: Call[]; afterEach: Call[] };
/** What a judge registers, as a stand-in hook receives it, and as these tests call it. */
type Fn = (...args: never[]) => unknown;
type Call = (...args: unknown[]) => unknown;

function standInHooks(): Registered & { hooks: Record<keyof Registered, (fn: Fn) => void> } {
  const registered: Registered = { beforeAll: [], beforeEach: [], afterEach: [] };
  const hooks = {
    beforeAll: (fn: Fn) => void registered.beforeAll.push(fn as Call),
    beforeEach: (fn: Fn) => void registered.beforeEach.push(fn as Call),
    afterEach: (fn: Fn) => void registered.afterEach.push(fn as Call),
  };
  return { ...registered, hooks };
}

/** The one callback a hook registered: a judge that registers none, or two, fails here. */
function only(registered: Call[]): Call {
  const [fn, ...more] = registered;
  if (fn === undefined || more.length > 0) throw new Error(`expected one callback, found ${registered.length}`);
  return fn;
}

/** A clock that reports `microseconds` of CPU whenever it is stopped. */
const fixedClock = (microseconds: number) => () => () => microseconds;

const testContext = (name: string, concurrent = false) => ({
  task: { fullTestName: `suite > ${name}`, concurrent, meta: {} as Record<string, unknown> },
});
const fileSuite = (name: string) => ({ name, meta: {} as Record<string, unknown> });

afterEach(() => {
  vi.doUnmock('vitest');
  vi.resetModules();
});

describe('the limits', () => {
  it('holds each test to 0.1 s of its own CPU', () => {
    expect(CPU_LIMIT_MICROSECONDS).toBe(100_000);
  });

  it('cuts every test whose heaviest run passes 0.07 s', () => {
    expect(CPU_CUT_MICROSECONDS).toBe(70_000);
  });

  it('holds each file to 0.1 s of CPU to load', () => {
    expect(LOAD_CPU_LIMIT_MICROSECONDS).toBe(100_000);
  });
});

describe('cpuBreach', () => {
  it('passes a test at exactly the limit', () => {
    expect(cpuBreach(100_000, 't')).toBeUndefined();
  });

  it('names the test, its CPU and the limit one microsecond over', () => {
    const breach = cpuBreach(100_001, 'suite > t');
    expect(breach).toContain('"suite > t"');
    expect(breach).toContain('100.0 ms');
    expect(breach).toContain('0.1 s');
    expect(breach).toContain('tests/integration');
  });
});

describe('loadBreach', () => {
  it('passes a file at exactly the limit', () => {
    expect(loadBreach(100_000, 'tests/unit/a.test.ts')).toBeUndefined();
  });

  it('names the file, its load CPU and the limit one microsecond over', () => {
    const breach = loadBreach(100_001, 'tests/unit/a.test.ts');
    expect(breach).toContain('tests/unit/a.test.ts');
    expect(breach).toContain('100.0 ms');
    expect(breach).toContain('0.1 s');
    expect(breach).toContain('to load');
  });
});

describe('startOwnCpu', () => {
  it("measures this thread's CPU from the call, in microseconds", () => {
    const stop = startOwnCpu();
    let spin = 0;
    const until = performance.now() + 5;
    while (performance.now() < until) spin++;
    const used = stop();
    expect(spin).toBeGreaterThan(0);
    expect(used).toBeGreaterThanOrEqual(1_000);
    expect(used).toBeLessThan(CPU_LIMIT_MICROSECONDS);
  });
});

describe('judgeOwnCpu', () => {
  it('registers one beforeEach and one afterEach, and nothing else', () => {
    const s = standInHooks();
    judgeOwnCpu(s.hooks, fixedClock(1));
    expect([s.beforeAll.length, s.beforeEach.length, s.afterEach.length]).toEqual([0, 1, 1]);
  });

  it("stamps the test's own CPU on its meta and passes at the limit", () => {
    const s = standInHooks();
    judgeOwnCpu(s.hooks, fixedClock(100_000));
    const ctx = testContext('t');
    only(s.beforeEach)(ctx);
    expect(() => only(s.afterEach)(ctx)).not.toThrow();
    expect(ctx.task.meta.ownCpuMicroseconds).toBe(100_000);
  });

  it('fails a test over the limit, naming it, and still stamps its CPU', () => {
    const s = standInHooks();
    judgeOwnCpu(s.hooks, fixedClock(150_000));
    const ctx = testContext('heavy');
    only(s.beforeEach)(ctx);
    expect(() => only(s.afterEach)(ctx)).toThrow(/"suite > heavy" used 150\.0 ms of its own CPU/);
    expect(ctx.task.meta.ownCpuMicroseconds).toBe(150_000);
  });

  it('refuses a concurrent test, whose CPU cannot be told from its neighbours', () => {
    const s = standInHooks();
    judgeOwnCpu(s.hooks, fixedClock(1));
    expect(() => only(s.beforeEach)(testContext('together', true))).toThrow(
      /"suite > together" runs concurrently: its own CPU cannot be measured/,
    );
  });

  it('times each test from its own start, not the previous one', () => {
    const s = standInHooks();
    let started = 0;
    judgeOwnCpu(s.hooks, () => {
      started++;
      return () => started * 10;
    });
    const first = testContext('first');
    const second = testContext('second');
    only(s.beforeEach)(first);
    only(s.afterEach)(first);
    only(s.beforeEach)(second);
    only(s.afterEach)(second);
    expect([first.task.meta.ownCpuMicroseconds, second.task.meta.ownCpuMicroseconds]).toEqual([10, 20]);
  });
});

describe('measureLoad', () => {
  it('registers one beforeAll, and nothing else', () => {
    const s = standInHooks();
    measureLoad(s.hooks, fixedClock(1));
    expect([s.beforeAll.length, s.beforeEach.length, s.afterEach.length]).toEqual([1, 0, 0]);
  });

  it("stamps the file's load CPU and wall on its meta", () => {
    const s = standInHooks();
    measureLoad(s.hooks, fixedClock(42_000));
    const file = fileSuite('tests/unit/a.test.ts');
    only(s.beforeAll)({}, file);
    expect(file.meta.loadCpuMicroseconds).toBe(42_000);
    expect(file.meta.loadWallMilliseconds).toBeGreaterThanOrEqual(0);
    expect(file.meta.loadWallMilliseconds).toBeLessThan(1_000);
  });
});

describe('judgeLoad', () => {
  it('registers one beforeAll, and nothing else', () => {
    const s = standInHooks();
    judgeLoad(s.hooks);
    expect([s.beforeAll.length, s.beforeEach.length, s.afterEach.length]).toEqual([1, 0, 0]);
  });

  it('passes a file at the limit', () => {
    const s = standInHooks();
    judgeLoad(s.hooks);
    const file = fileSuite('tests/unit/a.test.ts');
    file.meta.loadCpuMicroseconds = 100_000;
    expect(() => only(s.beforeAll)({}, file)).not.toThrow();
  });

  it('fails a file over the limit, naming it', () => {
    const s = standInHooks();
    judgeLoad(s.hooks);
    const file = fileSuite('tests/unit/a.test.ts');
    file.meta.loadCpuMicroseconds = 150_000;
    expect(() => only(s.beforeAll)({}, file)).toThrow(/tests\/unit\/a\.test\.ts used 150\.0 ms of CPU to load/);
  });

  it('fails a file that carries no load figure, so a measure that stopped is seen', () => {
    const s = standInHooks();
    judgeLoad(s.hooks);
    expect(() => only(s.beforeAll)({}, fileSuite('tests/unit/a.test.ts'))).toThrow(/tests\/unit\/a\.test\.ts has no load figure/);
  });
});

describe('the setup shims', () => {
  async function loadShim(shim: () => Promise<unknown>): Promise<Registered> {
    const s = standInHooks();
    vi.resetModules();
    vi.doMock('vitest', () => s.hooks);
    await shim();
    return s;
  }

  it('unit-cpu wires the own-CPU judge into beforeEach and afterEach', async () => {
    const s = await loadShim(() => import('../setup/unit-cpu.ts'));
    expect([s.beforeAll.length, s.beforeEach.length, s.afterEach.length]).toEqual([0, 1, 1]);
    const ctx = testContext('t');
    only(s.beforeEach)(ctx);
    only(s.afterEach)(ctx);
    expect(ctx.task.meta.ownCpuMicroseconds).toBeLessThan(CPU_LIMIT_MICROSECONDS);
  });

  it('load wires the load measure into beforeAll', async () => {
    const s = await loadShim(() => import('../setup/load.ts'));
    expect([s.beforeAll.length, s.beforeEach.length, s.afterEach.length]).toEqual([1, 0, 0]);
    const file = fileSuite('tests/unit/a.test.ts');
    only(s.beforeAll)({}, file);
    expect(file.meta.loadCpuMicroseconds).toBeLessThan(LOAD_CPU_LIMIT_MICROSECONDS);
  });

  it('unit-load-limit wires the load judge into beforeAll', async () => {
    const s = await loadShim(() => import('../setup/unit-load-limit.ts'));
    expect([s.beforeAll.length, s.beforeEach.length, s.afterEach.length]).toEqual([1, 0, 0]);
    expect(() => only(s.beforeAll)({}, fileSuite('tests/unit/a.test.ts'))).toThrow(/has no load figure/);
  });
});

const row = (name: string, microseconds: number) => ({ name, microseconds, wallMilliseconds: 3 });

describe('report', () => {
  it('says how many it measured even when that is none', () => {
    expect(report([], 0, 'Own CPU per test', [100_000, 70_000])).toEqual([
      'Own CPU per test: 0 measured, 0 unmeasured; 0 over 100.0 ms, 0 over 70.0 ms',
    ]);
  });

  it('counts the rows over each line, and lists the heaviest first', () => {
    const rows = [row('a', 10_000), row('b', 120_000), row('c', 80_000), row('d', 70_000)];
    expect(report(rows, 0, 'Own CPU per test', [100_000, 70_000])).toEqual([
      'Own CPU per test: 4 measured, 0 unmeasured; 1 over 100.0 ms, 2 over 70.0 ms',
      '  120.0 ms CPU, 3 ms wall  b',
      '  80.0 ms CPU, 3 ms wall  c',
      '  70.0 ms CPU, 3 ms wall  d',
      '  10.0 ms CPU, 3 ms wall  a',
    ]);
  });

  it('lists only the top N', () => {
    const rows = [row('a', 1), row('b', 3), row('c', 2)];
    expect(report(rows, 0, 'H', [100_000, 70_000], 2).slice(1)).toEqual(['  0.0 ms CPU, 3 ms wall  b', '  0.0 ms CPU, 3 ms wall  c']);
  });

  it('counts what ran with no figure', () => {
    expect(report([], 3, 'H', [100_000, 70_000])[0]).toBe('H: 0 measured, 3 unmeasured; 0 over 100.0 ms, 0 over 70.0 ms');
  });
});

type StandInTest = { state: string; fullName: string; meta: Record<string, unknown>; duration: number };

function standInModule(id: string, meta: Record<string, unknown>, tests: StandInTest[]): TestModule {
  return {
    relativeModuleId: id,
    meta: () => meta,
    children: {
      *allTests() {
        for (const t of tests) {
          yield {
            fullName: t.fullName,
            meta: () => t.meta,
            result: () => ({ state: t.state }),
            diagnostic: () => ({ duration: t.duration }),
          };
        }
      },
    },
  } as unknown as TestModule;
}

describe('summarise', () => {
  const modules = [
    standInModule('tests/unit/a.test.ts', { loadCpuMicroseconds: 20_000, loadWallMilliseconds: 30 }, [
      { state: 'passed', fullName: 'a > one', meta: { ownCpuMicroseconds: 5_000 }, duration: 6 },
      { state: 'failed', fullName: 'a > two', meta: {}, duration: 1 },
      { state: 'skipped', fullName: 'a > three', meta: {}, duration: 0 },
    ]),
    standInModule('tests/unit/b.test.ts', {}, []),
  ];

  it("reports each test's own CPU, counting a test that ran with none and leaving out one skipped", () => {
    expect(summarise(modules).slice(0, 2)).toEqual([
      'Own CPU per test: 1 measured, 1 unmeasured; 0 over 100.0 ms, 0 over 70.0 ms',
      '  5.0 ms CPU, 6 ms wall  tests/unit/a.test.ts > a > one',
    ]);
  });

  it("reports each file's load, counting a file that loaded with none", () => {
    expect(summarise(modules).slice(2)).toEqual([
      'Load per file: 1 measured, 1 unmeasured; 0 over 100.0 ms, 0 over 70.0 ms',
      '  20.0 ms CPU, 30 ms wall  tests/unit/a.test.ts',
    ]);
  });
});

describe('the limits reporter', () => {
  it('writes the summary to stdout when the run ends', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      new LimitsReporter().onTestRunEnd([standInModule('tests/unit/b.test.ts', {}, [])]);
      expect(write.mock.calls.map((c) => c[0])).toEqual([
        'Own CPU per test: 0 measured, 0 unmeasured; 0 over 100.0 ms, 0 over 70.0 ms\n' +
          'Load per file: 0 measured, 1 unmeasured; 0 over 100.0 ms, 0 over 70.0 ms\n',
      ]);
    } finally {
      write.mockRestore();
    }
  });
});

describe('the setup files', () => {
  it('names each shim by its path', () => {
    expect([UNIT_REFUSAL, UNIT_CPU, LOAD, UNIT_LOAD_LIMIT]).toEqual([
      'tests/setup/unit-refusal.ts',
      'tests/setup/unit-cpu.ts',
      'tests/setup/load.ts',
      'tests/setup/unit-load-limit.ts',
    ]);
  });

  it('refuses first, starts the load clock after the CPU judge and judges the load last', () => {
    expect(UNIT_SETUP).toEqual([
      'tests/setup/unit-refusal.ts',
      'tests/setup/unit-cpu.ts',
      'tests/setup/load.ts',
      'tests/setup/unit-load-limit.ts',
    ]);
  });

  it('counts the two judges as the ones a coverage run leaves out', () => {
    expect(UNIT_JUDGES).toEqual(['tests/setup/unit-cpu.ts', 'tests/setup/unit-load-limit.ts']);
  });
});

describe('the unit config', () => {
  it('limits each test and hook to 1 s', () => {
    expect([unit.test.testTimeout, unit.test.hookTimeout]).toEqual([1_000, 1_000]);
  });

  it('runs each file in its own process, so a thread is one file', () => {
    expect(unit.test.pool).toBe('forks');
  });

  it('loads every setup shim, in order', () => {
    expect(unit.test.setupFiles).toEqual([
      'tests/setup/unit-refusal.ts',
      'tests/setup/unit-cpu.ts',
      'tests/setup/load.ts',
      'tests/setup/unit-load-limit.ts',
    ]);
  });

  it('prints the limits report after the default one', () => {
    expect(unit.test.reporters).toEqual(['default', './tests/setup/limits-reporter.ts']);
  });
});

describe('the other configs', () => {
  it('keeps limits out of the integration suite: its one limit is the CI step', () => {
    expect(Object.keys(integration.test)).toEqual(['include']);
  });
});

describe('the README', () => {
  it('finds the unit limits’ files in its file table', () => {
    expect(readFileSync('README.md', 'utf8')).toContain(
      '| `tests/setup/limits.ts`, `tests/setup/refusals.ts`, `vitest.unit.config.ts`, `vitest.integration.config.ts`, `docs/unit-limits.md` |',
    );
  });
});
