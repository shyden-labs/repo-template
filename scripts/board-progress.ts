/**
 * Progress from the project board, twice: by tickets and by effort (story
 * points in the board's `Estimate` field), each with its measured pace over
 * the last 7 days and the ETA that pace gives. Every session close-out
 * quotes these two lines, then adds what the pace cannot know: outside waits
 * (store review, operator sign-offs, devices) and any assumed change of pace.
 *
 * Usage: node scripts/board-progress.ts <board-node-id> "<board title>"
 *
 * Epics are left out (an epic is the sum of its stories), and so is anything
 * labelled `post-launch`, which is not part of release-ready. A draft card is
 * planned work, so it counts as an open story. A pull-request card is finished
 * code, not work left, so it is left out, and a third line names every one. A
 * card the token cannot read could be open work, so it stops the read.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface BoardItem {
  /** `null` for a draft card, which has no number. */
  number: number | null;
  title: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  closedAt: string | null;
  estimate: number | null;
  labels: string[];
}

export interface BoardRead {
  /** The issues and draft cards, which both counts include. */
  items: BoardItem[];
  /** The pull-request cards by number, which neither count includes. */
  pullRequests: number[];
}

export interface TicketProgress {
  closed: number;
  total: number;
  epics: number;
  postLaunch: number;
  /** In-scope draft cards, each counted as an open story. */
  drafts: number;
  /**
   * Closures per UTC day over the 7 days ending today, oldest first; fewer
   * days while the board's oldest story is younger than that, because days
   * before the project existed are not working days.
   */
  pace: number[];
}

export type EffortProgress =
  | { available: false; scored: number; open: number }
  | {
      available: true;
      closedPoints: number;
      openPoints: number;
      /** Closed stories with no estimate, counted at the scored closed mean. */
      assumedClosed: number;
      scoredMean: number;
      /** Points closed per UTC day over the same window, oldest first. */
      pace: number[];
    };

export interface Progress {
  tickets: TicketProgress;
  effort: EffortProgress;
}

const WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const isEpic = (item: BoardItem): boolean => /^Epic\b/.test(item.title);
const isDraft = (item: BoardItem): boolean => item.number === null;
const isPostLaunch = (item: BoardItem): boolean =>
  item.labels.includes('post-launch');

/** Whether a board item counts towards release-ready. */
export function inScope(item: BoardItem): boolean {
  return !isEpic(item) && !isPostLaunch(item);
}

/** The UTC days of the window ending `today`, oldest first, none before `since`. */
function windowDays(today: string, since: string): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) =>
    new Date(end - (WINDOW_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
  const kept = days.filter((day) => day >= since);
  return kept.length === 0 ? [today] : kept;
}

function perDay(
  closed: BoardItem[],
  days: string[],
  weight: (item: BoardItem) => number,
): number[] {
  return days.map((day) =>
    closed
      .filter((item) => item.closedAt?.slice(0, 10) === day)
      .reduce((sum, item) => sum + weight(item), 0),
  );
}

export function progress(items: BoardItem[], today: string): Progress {
  const scope = items.filter(inScope);
  const closed = scope.filter((item) => item.state === 'CLOSED');
  const open = scope.filter((item) => item.state === 'OPEN');
  const since = items
    .map((item) => item.createdAt.slice(0, 10))
    .reduce((a, b) => (b < a ? b : a), today);
  const days = windowDays(today, since);
  const tickets: TicketProgress = {
    closed: closed.length,
    total: scope.length,
    epics: items.filter(isEpic).length,
    postLaunch: items.filter((item) => !isEpic(item) && isPostLaunch(item))
      .length,
    drafts: scope.filter(isDraft).length,
    pace: perDay(closed, days, () => 1),
  };
  const scoredOpen = open.filter((item) => item.estimate !== null);
  if (scoredOpen.length < open.length) {
    return {
      tickets,
      effort: { available: false, scored: scoredOpen.length, open: open.length },
    };
  }
  const scoredClosed = closed.filter((item) => item.estimate !== null);
  const scoredMean =
    scoredClosed.length === 0
      ? 0
      : scoredClosed.reduce((sum, item) => sum + (item.estimate ?? 0), 0) /
        scoredClosed.length;
  const points = (item: BoardItem): number => item.estimate ?? scoredMean;
  return {
    tickets,
    effort: {
      available: true,
      closedPoints: closed.reduce((sum, item) => sum + points(item), 0),
      openPoints: open.reduce((sum, item) => sum + points(item), 0),
      assumedClosed: closed.length - scoredClosed.length,
      scoredMean,
      pace: perDay(closed, days, points),
    },
  };
}

const plural = (n: number, word: string, words = `${word}s`): string =>
  `${String(n)} ${n === 1 ? word : words}`;

const meanOf = (pace: number[]): number =>
  pace.reduce((a, b) => a + b, 0) / pace.length;

/** The ETA at the window's mean daily pace, or why there is none. */
function eta(remaining: number, pace: number[], today: string): string {
  const mean = meanOf(pace);
  if (mean === 0) {
    return `ETA at that pace: none, nothing closed in the last ${plural(pace.length, 'day')}.`;
  }
  const days = Math.ceil(remaining / mean);
  const date = new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS);
  return `ETA at that pace: ${date.toISOString().slice(0, 10)}, before outside waits.`;
}

/** The two close-out lines: by tickets, then by effort. */
export function formatLines(p: Progress, today: string): [string, string] {
  const t = p.tickets;
  const tickets =
    `By tickets: ${String(Math.round((100 * t.closed) / t.total))}% complete ` +
    `(${String(t.closed)} of ${String(t.total)} in-scope stories closed` +
    (t.drafts === 0 ? '' : `, counting ${plural(t.drafts, 'open draft')}`) +
    '; ' +
    `${plural(t.epics, 'epic')} and ${String(t.postLaunch)} post-launch left out). ` +
    `Measured pace ${meanOf(t.pace).toFixed(2)} a day over the last ${plural(t.pace.length, 'day')} (${t.pace.join(', ')}). ` +
    eta(t.total - t.closed, t.pace, today);
  const e = p.effort;
  if (!e.available) {
    return [
      tickets,
      `By effort: unavailable, ${String(e.scored)} of ${String(e.open)} open tickets scored`,
    ];
  }
  const total = e.closedPoints + e.openPoints;
  const assumed =
    e.assumedClosed === 0
      ? ''
      : `; ${plural(e.assumedClosed, 'closed story', 'closed stories')} unscored, counted at the scored mean of ${e.scoredMean.toFixed(1)} points (assumed)`;
  const effort =
    `By effort: ${String(Math.round((100 * e.closedPoints) / total))}% complete ` +
    `(${String(Math.round(e.closedPoints))} of ${String(Math.round(total))} points closed${assumed}). ` +
    `Measured pace ${meanOf(e.pace).toFixed(2)} points a day over the last ${plural(e.pace.length, 'day')} ` +
    `(${e.pace.map((n) => String(Math.round(n))).join(', ')}). ` +
    eta(e.openPoints, e.pace, today);
  return [tickets, effort];
}

interface RawNode {
  estimate: { number: number } | null;
  content: {
    __typename: string;
    title?: string;
    number?: number;
    state?: 'OPEN' | 'CLOSED';
    createdAt?: string;
    closedAt?: string | null;
    labels?: { nodes: { name: string }[] };
  } | null;
}
interface RawPage {
  data: { node: { title: string; items: { nodes: RawNode[] } } };
}

/**
 * The issues and draft cards on the board, and the pull-request cards left
 * out, from the GraphQL pages. A card that cannot be read, or a kind this
 * script does not know, stops the read by name.
 */
export function parseItems(pages: unknown[]): BoardRead {
  const read: BoardRead = { items: [], pullRequests: [] };
  for (const node of (pages as RawPage[]).flatMap((page) => page.data.node.items.nodes)) {
    const c = node.content;
    if (c === null) {
      throw new Error(
        'a card on the board came back with no content (this token cannot read it): nothing read, as the count would not be exact',
      );
    } else if (c.__typename === 'PullRequest') {
      if (c.number === undefined) {
        throw new Error('a pull request on the board came back without its number');
      }
      read.pullRequests.push(c.number);
    } else if (c.__typename === 'DraftIssue') {
      read.items.push(parseDraft(node.estimate, c));
    } else if (c.__typename === 'Issue') {
      read.items.push(parseIssue(node.estimate, c));
    } else {
      throw new Error(
        `a "${c.__typename}" card is not one this script knows how to count: nothing read`,
      );
    }
  }
  return read;
}

function parseDraft(
  estimate: RawNode['estimate'],
  c: NonNullable<RawNode['content']>,
): BoardItem {
  if (c.title === undefined || c.createdAt === undefined) {
    throw new Error('a draft card on the board came back without its title or creation time');
  }
  return {
    number: null,
    title: c.title,
    state: 'OPEN',
    createdAt: c.createdAt,
    closedAt: null,
    estimate: estimate?.number ?? null,
    labels: [],
  };
}

function parseIssue(
  estimate: RawNode['estimate'],
  c: NonNullable<RawNode['content']>,
): BoardItem {
  if (
    c.number === undefined ||
    c.title === undefined ||
    c.state === undefined ||
    c.createdAt === undefined
  ) {
    throw new Error(
      'an issue on the board came back without its number, title, state or creation time',
    );
  }
  return {
    number: c.number,
    title: c.title,
    state: c.state,
    createdAt: c.createdAt,
    closedAt: c.closedAt ?? null,
    estimate: estimate?.number ?? null,
    labels: (c.labels?.nodes ?? []).map((l) => l.name),
  };
}

/** The third line, naming every pull-request card left out, or `null` when there are none. */
export function formatLeftOut(pullRequests: number[]): string | null {
  if (pullRequests.length === 0) return null;
  const numbers = pullRequests.map((n) => `#${String(n)}`).join(', ');
  return `Left out, not issues: ${plural(pullRequests.length, 'pull request')} (${numbers}).`;
}

/** Refuse to read a board other than the one asked for. */
export function assertTitle(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error(`the board is "${actual}", not "${expected}": nothing read`);
  }
}

export const QUERY = `query($id: ID!, $endCursor: String) {
  node(id: $id) { ... on ProjectV2 { title
    items(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor }
      nodes {
        estimate: fieldValueByName(name: "Estimate") { ... on ProjectV2ItemFieldNumberValue { number } }
        content { __typename
          ... on DraftIssue { title createdAt }
          ... on PullRequest { number title }
          ... on Issue { number title state createdAt closedAt labels(first: 20) { nodes { name } } }
        } } } } } }`;

function main(): void {
  const [id, title] = process.argv.slice(2);
  if (id === undefined || title === undefined) {
    throw new Error(
      'usage: node scripts/board-progress.ts <board-node-id> "<board title>"',
    );
  }
  const out = execFileSync(
    'gh',
    ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${QUERY}`, '-f', `id=${id}`],
    { encoding: 'utf8' },
  );
  const pages = JSON.parse(out) as RawPage[];
  for (const page of pages) assertTitle(page.data.node.title, title);
  const today = new Date().toISOString().slice(0, 10);
  const { items, pullRequests } = parseItems(pages);
  const leftOutLine = formatLeftOut(pullRequests);
  const lines = [
    ...formatLines(progress(items, today), today),
    ...(leftOutLine === null ? [] : [leftOutLine]),
  ];
  for (const line of lines) process.stdout.write(`${line}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
