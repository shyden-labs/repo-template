import { describe, it, expect } from 'vitest';
import coverage from '../../vitest.coverage.config.ts';
import unit from '../../vitest.unit.config.ts';
import { SUITES } from '../../scripts/mutate.ts';

/**
 * Every suite's coverage joins the record (issue #66), so code only a non-unit
 * suite runs is measured, never named unmeasured or excluded. The coverage
 * run is one Vitest run with a project per suite (`vitest.coverage.config.ts`,
 * #92); this holds it to `SUITES` in scripts/mutate.ts, where a new suite
 * joins. The logs suite never runs on a pull request (operator 2026-10-16),
 * so it is the one suite left out, until #111 joins it.
 */

/** Suites the coverage run leaves out, each with the ticket that joins it. Only Shyden adds an entry. */
const NOT_JOINED: Record<string, string> = { logs: '#111' };

interface Project {
  test: { name: string; include: string[] };
}

/** Each way the coverage run's projects fail to join every suite; empty when none. */
function unjoined(projects: Project[], suites: Record<string, string[]>, exempt: Record<string, string>): string[] {
  const names = projects.map((p) => p.test.name);
  const found: string[] = [];
  if (!names.includes('unit')) found.push('no unit project');
  for (const [suite, include] of Object.entries(suites)) {
    const ticket = exempt[suite];
    if (ticket !== undefined) {
      if (names.includes(suite)) found.push(`${suite} is joined, so its ${ticket} exemption goes`);
      continue;
    }
    const project = projects.find((p) => p.test.name === suite);
    if (project === undefined) found.push(`${suite}: in SUITES but not a project of the coverage run, so its files read as unmeasured`);
    else if (JSON.stringify(project.test.include) !== JSON.stringify(include))
      found.push(`${suite}: the coverage project includes ${JSON.stringify(project.test.include)}, its suite ${JSON.stringify(include)}`);
  }
  for (const name of names)
    if (name !== 'unit' && !(name in suites)) found.push(`${name}: a project of the coverage run that SUITES does not name`);
  return found;
}

const projects = coverage.test.projects as Project[];
/** Each suite's own include, read from the config `SUITES` names for it, never written out here. */
const includes: Record<string, string[]> = Object.fromEntries(
  await Promise.all(
    Object.entries(SUITES).map(async ([name, { config }]) => {
      const loaded = (await import(`../../${config}`)) as { default: { test: { include: string[] } } };
      return [name, loaded.default.test.include] as const;
    }),
  ),
);

describe('the coverage run joins every suite', () => {
  it('reads every suite SUITES names, and the coverage run’s projects', () => {
    expect([Object.keys(SUITES).sort(), projects.map((p) => p.test.name)]).toEqual([
      ['integration', 'logs'],
      ['unit', 'integration'],
    ]);
  });

  it('holds a project for unit and for every suite but logs, each with its suite’s own include', () => {
    expect([Object.keys(includes).sort(), unjoined(projects, includes, NOT_JOINED)]).toEqual([['integration', 'logs'], []]);
  });

  it('runs the unit project over the unit suite’s own files', () => {
    expect(projects.find((p) => p.test.name === 'unit')?.test.include).toEqual(unit.test.include);
  });

  it('leaves out logs alone, naming the ticket that joins it', () => {
    expect(NOT_JOINED).toEqual({ logs: '#111' });
  });
});

describe('the guard', () => {
  const unitP = { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } };
  const integrationP = { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] } };
  const suites = { integration: ['tests/integration/**/*.test.ts'], logs: ['tests/logs/**/*.test.ts'] };

  it('names a suite left out of the coverage run', () => {
    expect(unjoined([unitP], suites, NOT_JOINED)).toEqual([
      'integration: in SUITES but not a project of the coverage run, so its files read as unmeasured',
    ]);
  });

  it('names a project that runs other files than its suite', () => {
    const narrow = { test: { name: 'integration', include: ['tests/integration/a.test.ts'] } };
    expect(unjoined([unitP, narrow], suites, NOT_JOINED)).toEqual([
      'integration: the coverage project includes ["tests/integration/a.test.ts"], its suite ["tests/integration/**/*.test.ts"]',
    ]);
  });

  it('names a missing unit project', () => {
    expect(unjoined([integrationP], suites, NOT_JOINED)).toEqual(['no unit project']);
  });

  it('names a project no suite names', () => {
    const stray = { test: { name: 'e2e', include: ['tests/e2e/**'] } };
    expect(unjoined([unitP, integrationP, stray], suites, NOT_JOINED)).toEqual([
      'e2e: a project of the coverage run that SUITES does not name',
    ]);
  });

  it('names an exemption that is no longer needed', () => {
    const logsP = { test: { name: 'logs', include: ['tests/logs/**/*.test.ts'] } };
    expect(unjoined([unitP, integrationP, logsP], suites, NOT_JOINED)).toEqual(['logs is joined, so its #111 exemption goes']);
  });

  it('names a new suite added to SUITES but not to the coverage run', () => {
    expect(unjoined([unitP, integrationP], { ...suites, e2e: ['tests/e2e/**'] }, NOT_JOINED)).toEqual([
      'e2e: in SUITES but not a project of the coverage run, so its files read as unmeasured',
    ]);
  });
});
