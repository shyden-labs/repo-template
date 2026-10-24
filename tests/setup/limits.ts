import type { RunnerTestFile, RunnerTestSuite, TestContext } from 'vitest';
import type { TestModule } from 'vitest/node';

// The unit limits (docs/unit-limits.md, #92). Each test runs in under 1 s
// (the unit config's testTimeout and hookTimeout), uses at most 0.1 s of its
// own thread's CPU, and its file takes at most 0.1 s of CPU to load. None is
// ever raised (hooks/unit-limit-never-raised.py): a case that cannot fit is
// cut, or moves to tests/integration with a stand-in of its logic left here.
// The judges take Vitest's hooks as arguments, so the setup shims beside this
// file wire them and a unit test can hand them stand-ins.

/** The most CPU one unit test's own thread may use. */
export const CPU_LIMIT_MICROSECONDS = 100_000;
/** A test whose heaviest run passes this is cut: one test's CPU varies up to 2x run to run. */
export const CPU_CUT_MICROSECONDS = 70_000;
/** The most CPU one unit test file may take to load: its imports and module-scope work. */
export const LOAD_CPU_LIMIT_MICROSECONDS = 100_000;

declare module 'vitest' {
  interface TaskMeta {
    ownCpuMicroseconds?: number;
    loadCpuMicroseconds?: number;
    loadWallMilliseconds?: number;
  }
}

/** Starts a clock on this thread's CPU; the function it returns gives the microseconds used since. */
export type CpuClock = () => () => number;

export const startOwnCpu: CpuClock = () => {
  const start = process.threadCpuUsage();
  return () => {
    const used = process.threadCpuUsage(start);
    return used.user + used.system;
  };
};

const ms = (microseconds: number): string => `${(microseconds / 1_000).toFixed(1)} ms`;
const MOVE = 'Cut its work, or move the case to tests/integration and leave a stand-in of its logic here (#92).';

export function cpuBreach(microseconds: number, test: string): string | undefined {
  if (microseconds <= CPU_LIMIT_MICROSECONDS) return undefined;
  return `unit test "${test}" used ${ms(microseconds)} of its own CPU, over the 0.1 s limit. ${MOVE}`;
}

export function loadBreach(microseconds: number, file: string): string | undefined {
  if (microseconds <= LOAD_CPU_LIMIT_MICROSECONDS) return undefined;
  return `unit test file ${file} used ${ms(microseconds)} of CPU to load, over the 0.1 s limit. ${MOVE}`;
}

type TestTask = Pick<TestContext['task'], 'fullTestName' | 'concurrent' | 'meta'>;
type FileTask = Pick<RunnerTestSuite | RunnerTestFile, 'name' | 'meta'>;
/** A hook narrowed to the arguments a judge reads: Vitest's own hooks fit it, and so does a stand-in. */
type Hook<Args extends unknown[]> = (fn: (...args: Args) => unknown) => void;

/** Times each test's own CPU, stamps it on the test's meta and fails a test over the limit. */
export function judgeOwnCpu(
  hooks: { beforeEach: Hook<[{ task: TestTask }]>; afterEach: Hook<[{ task: TestTask }]> },
  clock: CpuClock = startOwnCpu,
): void {
  let stop: () => number = () => 0;
  hooks.beforeEach(({ task }) => {
    if (task.concurrent) {
      throw new Error(
        `unit test "${task.fullTestName}" runs concurrently: its own CPU cannot be measured apart from the tests beside it. Run it on its own (#92).`,
      );
    }
    stop = clock();
  });
  hooks.afterEach(({ task }) => {
    const used = stop();
    task.meta.ownCpuMicroseconds = used;
    const breach = cpuBreach(used, task.fullTestName);
    if (breach) throw new Error(breach);
  });
}

type FileHooks = { beforeAll: Hook<[object, FileTask]> };

/** Runs `fn` with the file's suite at its first beforeAll. */
function atFileStart(hooks: FileHooks, fn: (suite: FileTask) => void): void {
  // eslint-disable-next-line no-empty-pattern -- Vitest 5 reads a suite hook's first parameter as fixtures and refuses any but an object pattern; this hook needs only the suite (#92).
  hooks.beforeAll(({}, suite) => {
    fn(suite);
  });
}

/** Starts a clock at the call and stamps the file's load CPU and wall at its first beforeAll. */
export function measureLoad(hooks: FileHooks, clock: CpuClock = startOwnCpu): void {
  const stop = clock();
  const wall = performance.now();
  atFileStart(hooks, (suite) => {
    suite.meta.loadCpuMicroseconds = stop();
    suite.meta.loadWallMilliseconds = performance.now() - wall;
  });
}

/** Fails every test of a file that took over the limit to load, or that carries no figure. */
export function judgeLoad(hooks: FileHooks): void {
  atFileStart(hooks, (suite) => {
    const used = suite.meta.loadCpuMicroseconds;
    if (used === undefined) {
      throw new Error(
        `unit test file ${suite.name} has no load figure: the load measure (tests/setup/load.ts) must run before its judge (#92).`,
      );
    }
    const breach = loadBreach(used, suite.name);
    if (breach) throw new Error(breach);
  });
}

export type CpuRow = { name: string; microseconds: number; wallMilliseconds: number };

/** One heading line counting the rows over each line, then the heaviest `top` rows. */
export function report(
  rows: readonly CpuRow[],
  unmeasured: number,
  heading: string,
  [limit, cut]: readonly [number, number],
  top = 10,
): string[] {
  const over = (line: number) => rows.filter((r) => r.microseconds > line).length;
  const heaviest = [...rows].sort((a, b) => b.microseconds - a.microseconds).slice(0, top);
  return [
    `${heading}: ${rows.length} measured, ${unmeasured} unmeasured; ${over(limit)} over ${ms(limit)}, ${over(cut)} over ${ms(cut)}`,
    ...heaviest.map((r) => `  ${ms(r.microseconds)} CPU, ${Math.round(r.wallMilliseconds)} ms wall  ${r.name}`),
  ];
}

/** The two reports for a finished run: each test's own CPU, then each file's load. */
export function summarise(modules: ReadonlyArray<TestModule>): string[] {
  const tests: CpuRow[] = [];
  const files: CpuRow[] = [];
  let unmeasuredTests = 0;
  let unmeasuredFiles = 0;
  for (const module of modules) {
    const { loadCpuMicroseconds, loadWallMilliseconds = 0 } = module.meta();
    if (loadCpuMicroseconds === undefined) unmeasuredFiles++;
    else files.push({ name: module.relativeModuleId, microseconds: loadCpuMicroseconds, wallMilliseconds: loadWallMilliseconds });
    for (const test of module.children.allTests()) {
      if (test.result().state === 'skipped') continue;
      const own = test.meta().ownCpuMicroseconds;
      if (own === undefined) unmeasuredTests++;
      else {
        tests.push({
          name: `${module.relativeModuleId} > ${test.fullName}`,
          microseconds: own,
          wallMilliseconds: test.diagnostic()?.duration ?? 0,
        });
      }
    }
  }
  return [
    ...report(tests, unmeasuredTests, 'Own CPU per test', [CPU_LIMIT_MICROSECONDS, CPU_CUT_MICROSECONDS]),
    ...report(files, unmeasuredFiles, 'Load per file', [LOAD_CPU_LIMIT_MICROSECONDS, CPU_CUT_MICROSECONDS]),
  ];
}
