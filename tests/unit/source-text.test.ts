import { describe, it, expect } from 'vitest';
import { withoutCommentLines, withoutPinnedShas, withoutTsComments, withoutYamlComments, yamlBlock } from './source-text';

describe('withoutYamlComments', () => {
  const y = (...lines: string[]) => lines.join('\n');

  it.each([
    ['a whole-line comment, and the blank lines', y('a: 1', '# gone', '', '  # gone', 'b: 2'), y('a: 1', 'b: 2')],
    ['a trailing comment after a space', y('a: 1 # gone', 'b: 2\t# gone'), y('a: 1', 'b: 2')],
    ['nothing in a value where # follows no space', y('url: https://x.example/#top', 'tag: v1#2'), y('url: https://x.example/#top', 'tag: v1#2')],
  ])('drops %s', (_kind, text, stripped) => {
    expect(withoutYamlComments(text)).toBe(stripped);
  });

  // Block scalars and quoted values hold text, not comments (#54).
  it.each([
    ['a literal block scalar', y('run: |', '  echo "step #2"', '  x # stays', 'next: 1 # gone'), y('run: |', '  echo "step #2"', '  x # stays', 'next: 1')],
    ['a folded block scalar', y('note: >', '  Write `Refs #N`.', 'next: 1'), y('note: >', '  Write `Refs #N`.', 'next: 1')],
    ['a block scalar with chomping and indent indicators', y('a: |-', '  # kept', 'b: >+2', '    # kept', 'c: |2-', '    # kept'), y('a: |-', '  # kept', 'b: >+2', '    # kept', 'c: |2-', '    # kept')],
    ['a block scalar whose indicator carries a comment', y('run: | # gone', '  echo #1'), y('run: |', '  echo #1')],
    ['a block scalar in a list item, ending at its next key', y('  - run: |', '      echo #1', '    env: x # gone'), y('  - run: |', '      echo #1', '    env: x')],
    ['a block scalar that ends the file', y('a: 1', 'run: |', '  echo #1'), y('a: 1', 'run: |', '  echo #1')],
    ['a double-quoted value', y('name: "a #b" # gone'), y('name: "a #b"')],
    ['an escaped quote in a double-quoted value', y('x: "a \\" #b" # gone'), y('x: "a \\" #b"')],
    ['a single-quoted value', y("name: 'a #b' # gone"), y("name: 'a #b'")],
    ['a doubled quote in a single-quoted value', y("x: 'it''s #b' # gone"), y("x: 'it''s #b'")],
    ['a quoted list item', y("- 'a #b' # gone"), y("- 'a #b'")],
    ['a quoted value in a flow list', y("on: [push, 'a #b'] # gone"), y("on: [push, 'a #b']")],
  ])('keeps the text of %s', (_kind, text, stripped) => {
    expect(withoutYamlComments(text)).toBe(stripped);
  });

  it('reads an apostrophe inside a plain value as text, so the comment after it still goes', () => {
    expect(withoutYamlComments("x: don't # gone")).toBe("x: don't");
  });

  it('reads an unclosed quote to the end of its line, so the next line is read afresh', () => {
    expect(withoutYamlComments(y('x: "a #b', 'y: 1 # gone'))).toBe(y('x: "a #b', 'y: 1'));
  });
});

/**
 * The template's shared text strippers, for guards that read files as text.
 * A repository made from the template uses these rather than writing its own,
 * so each behaviour a guard relies on is pinned here.
 */

describe('withoutPinnedShas', () => {
  const SHA = '820762786026740c76f36085b0efc47a31fe5020';

  it('reads a full commit SHA after @ as <sha>, so a sound bump changes nothing a shape test sees', () => {
    expect(withoutPinnedShas(`      - uses: actions/setup-node@${SHA} # v7.0.0\n      - uses: a/b@${SHA}`)).toBe(
      '      - uses: actions/setup-node@<sha> # v7.0.0\n      - uses: a/b@<sha>',
    );
  });

  it.each([['a tag', '@v7'], ['a short SHA', `@${SHA.slice(0, 39)}`], ['a longer hex run', `@${SHA}0`], ['upper-case hex', `@${SHA.toUpperCase()}`]])(
    'leaves %s as it is, so it never passes as a pin',
    (_kind, ref) => {
      expect(withoutPinnedShas(`uses: actions/checkout${ref}`)).toBe(`uses: actions/checkout${ref}`);
    },
  );
});

describe('yamlBlock', () => {
  const YAML = ['on:', '  push:', '    branches: [develop]', 'jobs:', '  build:', '    steps:', '      - run: x', '  test:', '    runs-on: y'].join('\n');

  it('reads a top-level block up to the next top-level key', () => {
    expect(yamlBlock(YAML, 'on')).toBe('on:\n  push:\n    branches: [develop]');
  });

  it('reads a nested block up to its next sibling', () => {
    expect(yamlBlock(YAML, 'build', '  ')).toBe('  build:\n    steps:\n      - run: x');
  });

  it('reads a block that ends the file to its end', () => {
    expect(yamlBlock(YAML, 'test', '  ')).toBe('  test:\n    runs-on: y');
  });

  it('reads an absent key as empty, so a test of a missing block fails', () => {
    expect(yamlBlock(YAML, 'permissions')).toBe('');
  });
});

describe('withoutCommentLines', () => {
  it('drops whole-line # comments, indented or not, and keeps trailing ones', () => {
    expect(withoutCommentLines('a: 1 # kept\n  # gone\n# gone\nb: 2')).toBe('a: 1 # kept\nb: 2');
  });

  it('takes another marker', () => {
    expect(withoutCommentLines('x\n  // gone\nz', '//')).toBe('x\nz');
  });
});

describe('withoutTsComments', () => {
  it('removes a line comment, keeping the line break', () => {
    expect(withoutTsComments('a // note\nb')).toBe('a \nb');
  });

  it('removes a line comment that ends the file', () => {
    expect(withoutTsComments('a // note')).toBe('a \n');
  });

  it('removes a block comment', () => {
    expect(withoutTsComments('a /* note */b')).toBe('a b');
  });

  it('removes an unterminated block comment to the end of the file', () => {
    expect(withoutTsComments('a /* note')).toBe('a ');
  });

  it("keeps comment-like text inside ' \" and ` strings", () => {
    const source = "f('// a', \"/* b */\", `// c`);";
    expect(withoutTsComments(source)).toBe(source);
  });

  it('keeps a string past an escaped quote', () => {
    const source = "f('it\\'s // here');";
    expect(withoutTsComments(source)).toBe(source);
  });

  it('keeps a string past an escaped backslash, then strips the comment after it', () => {
    expect(withoutTsComments("f('a\\\\'); // c")).toBe("f('a\\\\'); \n");
  });

  it('keeps an escape that ends the file inside a string', () => {
    expect(withoutTsComments("'abc\\")).toBe("'abc\\");
  });

  it('closes a string only on its own quote', () => {
    expect(withoutTsComments('f("it\'s"); // c')).toBe('f("it\'s"); \n');
  });

  it('keeps a lone slash that starts no comment', () => {
    expect(withoutTsComments('a / b')).toBe('a / b');
  });
});
