import { describe, it, expect } from 'vitest';
import { withoutCommentLines, withoutTsComments } from './source-text';

/**
 * The template's shared text strippers, for guards that read files as text.
 * A repository made from the template uses these rather than writing its own,
 * so each behaviour a guard relies on is pinned here.
 */

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
