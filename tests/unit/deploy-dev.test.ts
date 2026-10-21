import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutYamlComments, withoutYamlQuotes, yamlBlock as topLevel } from './source-text.ts';

/**
 * A merge into `develop` deploys to dev by a workflow trigger (#12; operator
 * 2026-10-14). Read from comment-stripped, quote-free text, so a comment
 * describing the trigger cannot stand in for it, and compared exactly, so a
 * widened trigger fails as surely as a missing one.
 */

const WORKFLOW = '.github/workflows/deploy-dev.yml';
const workflow = () =>
  withoutYamlQuotes(withoutYamlComments(readFileSync(WORKFLOW, 'utf8')));

describe('deploy-dev', () => {
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
