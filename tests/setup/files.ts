// The unit suite's setup shims (#92), named once for the unit config, the
// coverage config and the tests that pin both.

/** Judges each test's own CPU. */
export const UNIT_CPU = 'tests/setup/unit-cpu.ts';
/** Measures each file's load; it stamps the figure the reporter and the load judge read. */
export const LOAD = 'tests/setup/load.ts';
/** Judges each file's load; it runs after LOAD, whose clock starts just before the file is imported. */
export const UNIT_LOAD_LIMIT = 'tests/setup/unit-load-limit.ts';

export const UNIT_SETUP = [UNIT_CPU, LOAD, UNIT_LOAD_LIMIT];
/** The judges a coverage run leaves out: instrumented code runs slower than the limits allow. */
export const UNIT_JUDGES = [UNIT_CPU, UNIT_LOAD_LIMIT];
