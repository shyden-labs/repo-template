/**
 * Comment stripping for the guards that assert against source text. #24.
 *
 * Several suites in this repo read a file as TEXT and assert that something
 * appears in it, or does not. Every one of them is exposed to the same defect,
 * and this repo has now shipped it three times:
 *
 * 1. #23 — `supply-chain.test.ts` asserted `dependabot.yml` contained
 *    `"actions/cache*"`, and the file's own explanatory NOTE spelled that
 *    pattern out verbatim. No group was configured at all; the suite was
 *    green.
 * 2. #21 Stage 4 — `pipeline-wiring.test.ts`'s first dev-sanity check searched
 *    raw text, and pointing the run step at a different config left it green,
 *    because that file's own comment explaining the fix contained the filename
 *    it was looking for.
 * 3. #35 — the pre-push hook guard asserted the hook source contained
 *    `npm run test:unit`. It passed while the hook did NOT run it: the string
 *    survived inside the failure hint the hook prints telling you how to run
 *    it by hand.
 *
 * All three read as obviously correct. None was found by review; each was
 * found by mutation, which is why the standing rule pairs the two: assert on
 * the stripped text, and watch it fail.
 *
 * THE INVERSE IS ALSO A DEFECT and is easier to miss, because nothing goes
 * red. `dead-copy.test.ts` asserts ABSENCE — a key is dead if nothing
 * references it — so a comment naming a key keeps a dead key looking alive and
 * SUPPRESSES a finding rather than satisfying an assertion. Same cause, no
 * symptom.
 */

/**
 * YAML with comments removed, inline ones included, and blank lines dropped.
 *
 * `# vX.Y.Z` beside a pinned action SHA is meaningful data, not prose, so
 * anything checking those version comments must read the RAW text — this is
 * for config bodies where a `#` is always commentary.
 */
export const withoutYamlComments = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');

/**
 * YAML with its scalar quote characters removed.
 *
 * Quoting in YAML is a STYLE, not a meaning: `'actions/cache*'` and
 * `"actions/cache*"` are the same scalar. A guard that greps for one spelling
 * reports a correct config as missing, which is a false ALARM rather than a
 * false pass -- the safe direction, but it reddens CI on config that is right
 * and sends whoever hits it hunting a problem that does not exist.
 *
 * Found by building the org template repository against this repo's own
 * supply-chain guard. The template configured the sub-path group in this
 * repo's own house style (single quotes, as `'npm'` and `'develop'` are
 * written) and the guard called it ungrouped.
 *
 * Only the quote characters go; separators and structure stay, so `['a','b']`
 * becomes `[a,b]` and two scalars cannot merge into one.
 */
export const withoutYamlQuotes = (text: string): string =>
  text.replace(/['"]/g, '');

/**
 * The block a YAML key opens, its own line included, from comment-stripped
 * text: the line `<indent><key>:` up to the next line indented no deeper
 * than it. '' when the key is absent, so a test of a missing block fails.
 */
export function yamlBlock(text: string, key: string, indent = ''): string {
  const lines = text.split('\n');
  const start = lines.indexOf(`${indent}${key}:`);
  if (start === -1) return '';
  const end = lines.findIndex((line, i) => i > start && line.length - line.trimStart().length <= indent.length);
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/**
 * Text with whole-line comments removed, for a given marker.
 *
 * Deliberately leaves trailing comments alone: a GitHub workflow's `run:`
 * blocks are shell, where `#` inside a quoted string is not a comment, and
 * removing those would change the very commands being asserted about.
 */
export const withoutCommentLines = (text: string, marker = '#'): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(marker))
    .join('\n');

/**
 * TypeScript with `//` and block comments removed, STRING LITERALS INTACT.
 *
 * A regex cannot do this correctly and the failures are the ones that matter:
 * `https://…` is not a comment, and `expect(x).toContain('// ')` is a string
 * whose content is the point. Since these guards exist to stop text in the
 * wrong place satisfying an assertion, a stripper that mangles the right place
 * is the same bug wearing the opposite coat — so this scans rather than
 * matches. Quotes, template literals and escapes are tracked; that is the
 * whole of the grammar this needs.
 */
export function withoutTsComments(source: string): string {
  let out = '';
  let quote: string | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (quote) {
      out += char;
      if (char === '\\') {
        out += source[i + 1] ?? '';
        i += 1;
      } else if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/'))
        i += 1;
      i += 1;
      continue;
    }

    out += char;
  }

  return out;
}
