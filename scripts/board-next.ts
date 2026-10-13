/**
 * Names the next ticket from the project board, so the board, not a handover
 * file, decides what is worked on next (operator 2026-10-12):
 *
 *   node scripts/board-next.ts <board-node-id> "<board title>"
 *
 * The highest `Priority` (P0 first) among open issues; within a level, what
 * is In Progress first, then what no open issue blocks, then the oldest. It
 * refuses while any open issue has no Priority, naming them, because a
 * ticket nobody scored would never be chosen and never be noticed.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertTitle } from './board-progress.ts';
import { PRIORITY_OPTIONS } from './board-setup.ts';

export interface NextItem {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  /** The board's Status option, e.g. "Todo" or "In Progress". */
  status: string | null;
  priority: string | null;
  /** The numbers of the OPEN issues this one is blocked by. */
  blockedBy: number[];
}

const LEVELS: readonly string[] = PRIORITY_OPTIONS.map((o) => o.name);

/** The next ticket, or `null` when nothing is open. */
export function nextTicket(items: NextItem[]): NextItem | null {
  const open = items.filter((i) => i.state === 'OPEN');
  const unscored = open.filter((i) => i.priority === null);
  if (unscored.length > 0) {
    throw new Error(
      `${unscored.length} open tickets have no Priority: ${unscored
        .map((i) => `#${i.number}`)
        .join(', ')}. Score them on the board first.`,
    );
  }
  for (const i of open) {
    if (!LEVELS.includes(i.priority as string)) {
      throw new Error(
        `#${i.number} has Priority "${i.priority}", which is not one of ${LEVELS.join(', ')}`,
      );
    }
  }
  const rank = (i: NextItem): number[] => [
    LEVELS.indexOf(i.priority as string),
    i.status === 'In Progress' ? 0 : 1,
    i.blockedBy.length === 0 ? 0 : 1,
    Date.parse(i.createdAt),
    i.number,
  ];
  const sorted = [...open].sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let k = 0; k < ra.length; k++) {
      if (ra[k] !== rb[k]) return ra[k] - rb[k];
    }
    return 0;
  });
  return sorted[0] ?? null;
}

const QUERY = `query($id: ID!, $endCursor: String) {
  node(id: $id) { ... on ProjectV2 { title
    items(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor }
      nodes {
        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
        content { __typename
          ... on DraftIssue { title }
          ... on PullRequest { title }
          ... on Issue { number title state createdAt
            blockedBy(first: 50) { nodes { number state } } }
        } } } } } }`;

interface RawNode {
  status: { name?: string } | null;
  priority: { name?: string } | null;
  content: {
    __typename: string;
    title?: string;
    number?: number;
    state?: 'OPEN' | 'CLOSED';
    createdAt?: string;
    blockedBy?: { nodes: Array<{ number: number; state: string }> };
  } | null;
}

interface RawPage {
  data: { node: { title: string; items: { nodes: RawNode[] } } };
}

/** The board's issues; anything that is not an issue is refused by name. */
export function parseNextItems(pages: RawPage[]): NextItem[] {
  return pages.flatMap((page) =>
    page.data.node.items.nodes.map((node): NextItem => {
      const c = node.content;
      if (
        c?.__typename !== 'Issue' ||
        c.number === undefined ||
        c.title === undefined ||
        c.state === undefined ||
        c.createdAt === undefined
      ) {
        throw new Error(
          `"${c?.title ?? '(no content)'}" is not an issue with a number, title, state and creation time: convert it, or remove it from the board`,
        );
      }
      return {
        number: c.number,
        title: c.title,
        state: c.state,
        createdAt: c.createdAt,
        status: node.status?.name ?? null,
        priority: node.priority?.name ?? null,
        blockedBy: (c.blockedBy?.nodes ?? [])
          .filter((b) => b.state === 'OPEN')
          .map((b) => b.number),
      };
    }),
  );
}

function main(): void {
  const [id, title] = process.argv.slice(2);
  if (id === undefined || title === undefined) {
    throw new Error(
      'usage: node scripts/board-next.ts <board-node-id> "<board title>"',
    );
  }
  const out = execFileSync(
    'gh',
    ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${QUERY}`, '-f', `id=${id}`],
    { encoding: 'utf8' },
  );
  const pages = JSON.parse(out) as RawPage[];
  assertTitle(pages[0]?.data.node.title ?? '', title);
  const next = nextTicket(parseNextItems(pages));
  process.stdout.write(
    next === null
      ? 'Next: nothing is open.\n'
      : `Next: #${next.number} ${next.title} (${next.priority}, ${next.status ?? 'no status'}${
          next.blockedBy.length > 0
            ? `, blocked by ${next.blockedBy.map((n) => `#${n}`).join(', ')}`
            : ''
        }).\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
