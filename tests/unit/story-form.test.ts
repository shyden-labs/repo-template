import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutYamlComments } from './source-text';

/**
 * A story is fully defined at filing: a story line, its context, complete
 * acceptance criteria, and an Estimate on the board. The form asks for each.
 */

const form = () =>
  withoutYamlComments(readFileSync('.github/ISSUE_TEMPLATE/story.yml', 'utf8'));

/** The text of the block that starts at `- type: … id: <id>`. */
function block(id: string): string {
  const parts = form().split(/\n\s*- type: /);
  const found = parts.find((p) => new RegExp(`\\n\\s*id: ${id}\\n`).test(p));
  if (found === undefined) throw new Error(`no block with id ${id}`);
  return found;
}

describe('the story form', () => {
  it.each(['story', 'context', 'acceptance-criteria'])(
    'requires %s',
    (id) => {
      expect(block(id)).toMatch(/\n\s*required: true(\n|$)/);
    },
  );

  it('asks for the board Estimate in Fibonacci points', () => {
    expect(block('estimate-note')).toContain(
      'Set the board’s **Estimate** field: 1, 2, 3, 5, 8 or 13 story points.',
    );
  });

  it('sends anything larger than 13 to an epic', () => {
    expect(block('estimate-note')).toContain(
      'Anything larger is an epic: split it into stories.',
    );
  });
});
