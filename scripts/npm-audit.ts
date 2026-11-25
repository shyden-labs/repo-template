/**
 * CI's dependency audit (issues shyden-labs/repo-template#156 and shyden-labs/repo-template#200):
 *
 *   node scripts/npm-audit.ts
 *
 * Runs `npm audit --json` and fails on every known vulnerability, of any
 * severity and dev dependencies included, except an advisory Shyden excepted
 * by name until its expiry. An exception past its expiry fails, and so does
 * one that matches nothing (the fix landed), so it is removed, not left behind.
 * It runs after the install but imports nothing outside node.
 */
import { spawnSync } from 'node:child_process';
import { runIfEntry } from './cli.ts';
import { toolPath } from './tools.ts';

export interface AuditException {
  /** The GitHub advisory id, e.g. GHSA-fc5q-39xc-vjpf. */
  advisory: string;
  /** The last day (UTC, YYYY-MM-DD) the exception holds. */
  expires: string;
  /** Where Shyden's ruling is recorded. */
  ticket: string;
}

/** An advisory npm reports in a package's `via`; a plain string there names another package. */
interface Advisory {
  url: string;
  title: string;
}

export interface AuditReport {
  vulnerabilities: Record<string, { via: (string | Advisory)[] }>;
}

/**
 * Advisories Shyden excepted by name, each until its expiry. None now: the
 * picomatch exception (GHSA-fc5q-39xc-vjpf) ended when GitHub withdrew that
 * advisory on 2026-11-18 (shyden-labs/repo-template#200).
 */
export const EXCEPTIONS: AuditException[] = [];

/** Each reason the audit fails: an advisory not excepted, an expired exception, or one that matches nothing. */
export function problems(report: AuditReport, exceptions: AuditException[], now: Date): string[] {
  const found = new Map<string, string>();
  for (const { via } of Object.values(report.vulnerabilities)) {
    for (const entry of via) if (typeof entry !== 'string') found.set(entry.url, entry.title);
  }
  const excepted = (url: string) => exceptions.some((e) => url.endsWith(`/${e.advisory}`));
  const today = now.toISOString().slice(0, 10);
  return [
    ...[...found].filter(([url]) => !excepted(url)).map(([url, title]) => `not excepted: ${url} (${title})`),
    ...exceptions.flatMap((e) => {
      if (today > e.expires) return [`exception for ${e.advisory} expired on ${e.expires} (${e.ticket})`];
      if (![...found.keys()].some((url) => url.endsWith(`/${e.advisory}`))) {
        return [`exception for ${e.advisory} matches nothing: remove it (${e.ticket})`];
      }
      return [];
    }),
  ];
}

function readReport(stdout: string): AuditReport {
  try {
    const parsed = JSON.parse(stdout) as Partial<AuditReport>;
    if (parsed.vulnerabilities !== undefined) return parsed as AuditReport;
  } catch {
    // Not JSON: reported below with the same message as JSON without a report.
  }
  throw new Error('npm audit printed no JSON report');
}

export function main(): number {
  const run = spawnSync(toolPath('npm'), ['audit', '--json'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (run.error) throw new Error(`npm audit did not run: ${run.error.message}`);
  const found = problems(readReport(run.stdout), EXCEPTIONS, new Date());
  if (found.length > 0) throw new Error(`npm audit found ${found.length} problem(s):\n${found.join('\n')}`);
  return 0;
}

await runIfEntry(import.meta.url, main);
