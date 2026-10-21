import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutYamlComments, withoutYamlQuotes } from './source-text';

/**
 * A merge into `develop` deploys to dev by a workflow trigger (#12; operator
 * 2026-10-14). Read from comment-stripped, quote-free text, so a comment
 * describing the trigger cannot stand in for it, and compared exactly, so a
 * widened trigger fails as surely as a missing one.
 */

const WORKFLOW = '.github/workflows/deploy-dev.yml';
const workflow = () =>
  withoutYamlQuotes(withoutYamlComments(readFileSync(WORKFLOW, 'utf8')));

/** A top-level key's block, its own line included; '' when absent (fails closed). */
const topLevel = (text: string, key: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `${key}:`);
  if (start === -1) return '';
  const end = lines.findIndex((line, i) => i > start && /^\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
};

describe('deploy-dev', () => {
  it('reads an absent top-level key as empty, so a missing block fails its test', () => {
    expect(topLevel('on:\n  push:\n', 'jobs')).toBe('');
  });

  it('runs on every push to develop, and otherwise only by hand', () => {
    expect(topLevel(workflow(), 'on')).toBe(
      ['on:', '  push:', '    branches: [develop]', '  workflow_dispatch:'].join('\n'),
    );
  });

  it('queues a deploy behind the running one rather than cancelling it', () => {
    expect(topLevel(workflow(), 'concurrency')).toBe(
      ['concurrency:', '  group: deploy-dev', '  cancel-in-progress: false'].join('\n'),
    );
  });

  it('deploys from the dev environment, where the dev credential lives', () => {
    expect(topLevel(workflow(), 'jobs').split('\n')).toContain('    environment: dev');
  });
});

describe('a new repository', () => {
  it('is told to fill in its dev deploy, or to say why it hosts nothing', () => {
    expect(readFileSync('README.md', 'utf8')).toContain(
      '8. **Fill in `.github/workflows/deploy-dev.yml`.** Every merge into `develop` deploys to dev by this trigger; replace its last step with your own deploy, acting only on the areas in `changed-files.txt`. Until then it fails, naming that step. A repository that hosts nothing deletes the workflow and `tests/unit/deploy-dev.test.ts`, and says why in its README.',
    );
  });
});
