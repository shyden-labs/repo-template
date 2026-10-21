/**
 * The per-phone report of a device run (issue #26; Shyden 2026-10-16: "the
 * suite should be exactly the same, run in parallel"):
 *
 *   npx playwright test --reporter=json > report.json
 *   node scripts/devices-report.ts report.json
 *
 * It prints each phone's totals and fails unless every phone ran the same
 * number of tests with none failed and none skipped: a step one phone cannot
 * take is raised, never silently skipped. A phone whose `metadata.input` is
 * "stand-in" is marked as one on every line, never reported as equal to real
 * taps. It fails closed on a report that names no phone project.
 */
import { readFileSync } from 'node:fs';
import { runIfEntry } from './cli.ts';

interface Test {
  projectName: string;
  status: string;
}
interface Suite {
  specs?: { tests: Test[] }[];
  suites?: Suite[];
}
interface Report {
  config: { projects: { name: string; metadata?: { phone?: string; input?: string } }[] };
  suites: Suite[];
}

export interface PhoneTotal {
  name: string;
  input: string;
  tests: number;
  failed: number;
  skipped: number;
}

const testsIn = (suite: Suite): Test[] => [...(suite.specs ?? []).flatMap((s) => s.tests), ...(suite.suites ?? []).flatMap(testsIn)];

/** Each phone project's totals; a flaky test counts as failed, since it did not pass first time. */
export function phoneTotals(report: Report): PhoneTotal[] {
  const tests = report.suites.flatMap(testsIn);
  return report.config.projects
    .filter((p) => p.metadata?.phone !== undefined)
    .map((p) => {
      const mine = tests.filter((t) => t.projectName === p.name);
      return {
        name: p.name,
        input: p.metadata?.input ?? 'unsaid',
        tests: mine.length,
        failed: mine.filter((t) => t.status === 'unexpected' || t.status === 'flaky').length,
        skipped: mine.filter((t) => t.status === 'skipped').length,
      };
    });
}

export function main(args: string[]): number {
  const [path, ...rest] = args;
  if (path === undefined || rest.length > 0) throw new Error('usage: node scripts/devices-report.ts <playwright-json-report>');
  const totals = phoneTotals(JSON.parse(readFileSync(path, 'utf8')) as Report);
  if (totals.length === 0) throw new Error('devices-report: the report names no phone project (metadata.phone); refusing to judge nothing');
  const most = Math.max(...totals.map((t) => t.tests));
  const problems: string[] = [];
  for (const t of totals) {
    const mode = t.input === 'real' ? 'real taps' : 'STAND-IN, weaker than real taps';
    process.stdout.write(`devices-report: ${t.name} (${mode}): ${t.tests} test(s), ${t.failed} failed, ${t.skipped} skipped\n`);
    if (t.tests === 0) problems.push(`${t.name} ran no tests`);
    else if (t.tests < most) problems.push(`${t.name} ran ${t.tests} test(s), not the ${most} another phone ran`);
    if (t.skipped > 0) problems.push(`${t.name} skipped ${t.skipped} test(s): a step a phone cannot take is raised, never skipped`);
    if (t.failed > 0) problems.push(`${t.name} failed ${t.failed} test(s)`);
  }
  for (const p of problems) process.stderr.write(`devices-report: ${p}\n`);
  return problems.length === 0 ? 0 : 1;
}

await runIfEntry(import.meta.url, main);
