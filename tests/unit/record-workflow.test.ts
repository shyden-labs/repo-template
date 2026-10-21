import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutPinnedShas, withoutYamlComments, withoutYamlQuotes, yamlBlock } from './source-text';

/**
 * The measure-then-commit workflow (issue #30): it runs only by hand, only on
 * a scratch ref the session pushed, holds no token that can write, and hands
 * back what to commit as an artifact. The session folds that into its
 * unpushed commit with `scripts/fold-record.ts` and pushes once. Read from
 * comment-stripped, quote-free text.
 */

const workflow = () =>
  withoutPinnedShas(withoutYamlQuotes(withoutYamlComments(readFileSync('.github/workflows/record.yml', 'utf8'))));
const steps = () => yamlBlock(workflow(), 'steps', '    ');

describe('record.yml', () => {
  it('runs only by hand, given the scratch ref to measure', () => {
    expect(yamlBlock(workflow(), 'on')).toBe(
      [
        'on:',
        '  workflow_dispatch:',
        '    inputs:',
        '      ref:',
        '        description: The scratch ref holding the commit: refs/floors/<branch>/<sha> or refs/visual/<branch>/<sha>',
        '        required: true',
        '        type: string',
      ].join('\n'),
    );
  });

  it('can only read the repository', () => {
    expect(yamlBlock(workflow(), 'permissions')).toBe('permissions:\n  contents: read');
  });

  it('refuses any ref but a scratch ref before checking anything out, then measures, records and uploads', () => {
    expect(steps().split('\n').filter((line) => /^ {6}- /.test(line))).toEqual([
      '      - name: Refuse any ref but a scratch ref',
      '      - uses: actions/checkout@<sha>',
      '      - uses: actions/setup-node@<sha>',
      '      - run: npm ci',
      '      - run: npm run test:coverage',
      '      - name: Record coverage',
      '      - name: Gather what to commit',
      '      - uses: actions/upload-artifact@<sha>',
    ]);
  });

  it('accepts only refs/floors/* and refs/visual/*, refusing the rest by name', () => {
    expect(steps()).toContain(
      [
        '          case $REF in',
        '            refs/floors/?*|refs/visual/?*) echo recording $REF ;;',
        '            *) echo ::error title=not a scratch ref::record runs only on refs/floors/* or refs/visual/*, never on $REF; exit 1 ;;',
        '          esac',
      ].join('\n'),
    );
  });

  it('sets up node with no cache, so a run of an unreviewed commit cannot poison what develop restores', () => {
    expect(steps()).toContain(
      [
        '      - uses: actions/setup-node@<sha>',
        '        with:',
        '          node-version-file: .nvmrc',
        '      - run: npm ci',
      ].join('\n'),
    );
  });

  it('checks out the scratch ref without keeping a credential', () => {
    expect(steps()).toContain(['        with:', '          ref: ${{ inputs.ref }}', '          persist-credentials: false'].join('\n'));
  });

  it('tells the recorder which scratch ref it records', () => {
    expect(steps()).toContain(
      ['      - name: Record coverage', '        env:', '          RECORD_RUN: ${{ inputs.ref }}', '        run: npm run coverage:record'].join('\n'),
    );
  });

  it('hands back the record, the measured SHA and a commit message line', () => {
    expect(steps()).toContain(
      [
        '          mkdir -p record/files',
        '          cp coverage-record.json record/files/',
        '          git rev-parse HEAD > record/sha',
        '          echo coverage: recorded by run $GITHUB_RUN_ID on $REF > record/message.txt',
      ].join('\n'),
    );
  });

  it('uploads it as the record artifact, failing when there is nothing to upload', () => {
    expect(steps()).toContain(['        with:', '          name: record', '          path: record/', '          if-no-files-found: error'].join('\n'));
  });
});
