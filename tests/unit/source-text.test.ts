import { describe, it, expect } from 'vitest';
import { withoutCommentLines, withoutPinnedShas, withoutTsComments, yamlBlock } from './source-text';

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
