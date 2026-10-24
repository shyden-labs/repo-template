import type { Reporter, TestModule } from 'vitest/node';
import { summarise } from './limits.ts';

/** Prints each test's own CPU and each file's load after every unit run (#92, docs/unit-limits.md). */
export default class LimitsReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    process.stdout.write(summarise(modules).join('\n') + '\n');
  }
}
