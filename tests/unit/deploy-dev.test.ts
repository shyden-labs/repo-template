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
const workflow = () => withoutYamlQuotes(withoutYamlComments(readFileSync(WORKFLOW, 'utf8')));

describe('deploy-dev', () => {
  it('runs on every push to develop, and otherwise only by hand', () => {
    expect(topLevel(workflow(), 'on')).toBe(['on:', '  push:', '    branches: [develop]', '  workflow_dispatch:'].join('\n'));
  });

  it('queues a deploy behind the running one rather than cancelling it', () => {
    expect(topLevel(workflow(), 'concurrency')).toBe(['concurrency:', '  group: deploy-dev', '  cancel-in-progress: false'].join('\n'));
  });

  it('deploys from the dev environment, where the dev credential lives', () => {
    expect(topLevel(workflow(), 'jobs').split('\n')).toContain('    environment: dev');
  });

  // The template hosts nothing, so its own develop skips the deploy (#43,
  // Shyden 2026-10-27), and a repository made from it, under any other name,
  // runs it. One job only: a second job (a PR rehearsal, #35) must carry the
  // same condition, so this test is where that is decided.
  it('has one job, deploy-dev, skipped only in the template itself', () => {
    const jobs = topLevel(workflow(), 'jobs').split('\n');
    expect(jobs.filter((line) => /^ {2}\S/.test(line))).toEqual(['  deploy-dev:']);
    expect(jobs.filter((line) => /^ {4}if:/.test(line))).toEqual(['    if: ${{ github.repository != shyden-labs/repo-template }}']);
  });

  // No other job key may skip it or pass it on failure (`continue-on-error`).
  it('gives the job no key but its condition, runner, environment and steps', () => {
    const keys = topLevel(workflow(), 'jobs')
      .split('\n')
      .filter((line) => /^ {4}\S/.test(line))
      .map((line) => line.trim().split(':')[0]);
    expect(keys).toEqual(['if', 'runs-on', 'environment', 'steps']);
  });

  it('still fails in a repository made from the template until it fills in its deploy', () => {
    const jobs = topLevel(workflow(), 'jobs').split('\n');
    const step = jobs.indexOf('      - name: Deploy the changed areas to dev');
    expect(jobs.slice(step, step + 4)).toEqual([
      '      - name: Deploy the changed areas to dev',
      '        run: |',
      '          echo ::error title=deploy-dev is not filled in::Replace this step with the projects own dev deploy, acting only on the areas in changed-files.txt (README, Using it, step 8).',
      '          exit 1',
    ]);
  });
});

describe('a new repository', () => {
  it('is told to fill in its dev deploy, or to say why it hosts nothing', () => {
    expect(readFileSync('README.md', 'utf8')).toContain(
      '8. **Fill in `.github/workflows/deploy-dev.yml`.** Every merge into `develop` deploys to dev by this trigger; replace its last step with your own deploy, acting only on the areas in `changed-files.txt`. Until then it fails, naming that step. A repository that hosts nothing deletes the workflow and `tests/unit/deploy-dev.test.ts`, and says why in its README.',
    );
  });
});
