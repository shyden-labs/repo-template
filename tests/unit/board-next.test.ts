import { describe, it, expect } from "vitest";
import {
  nextTicket,
  parseNextItems,
  type NextItem,
} from "../../scripts/board-next";

/**
 * The board, not a handover file, names the next ticket (operator
 * 2026-10-12): the highest Priority among open issues; within a level, In
 * Progress first, then unblocked, then the oldest. A blocker inherits the
 * level of what waits on it, and an epic waits for its stories (operator
 * 2026-10-13, repo-template#6).
 */
const REPO = "shyden-labs/app";
const ref = (number: number, repo = REPO) => ({ repo, number });
const item = (over: Partial<NextItem> & { number: number }): NextItem => ({
  repo: REPO,
  title: `ticket ${over.number}`,
  state: "OPEN",
  createdAt: "2026-10-01T00:00:00Z",
  status: "Todo",
  priority: "P3",
  blockedBy: [],
  openSubIssues: 0,
  ...over,
});

describe("nextTicket", () => {
  it("takes the highest priority, however new it is", () => {
    const next = nextTicket([
      item({ number: 1, priority: "P2", createdAt: "2026-01-01T00:00:00Z" }),
      item({ number: 2, priority: "P0", createdAt: "2026-10-12T00:00:00Z" }),
    ]);
    expect(next?.number).toBe(2);
  });

  it("finishes what is In Progress before starting anything else at its level", () => {
    const next = nextTicket([
      item({ number: 1, createdAt: "2026-01-01T00:00:00Z" }),
      item({
        number: 2,
        status: "In Progress",
        createdAt: "2026-10-12T00:00:00Z",
      }),
    ]);
    expect(next?.number).toBe(2);
  });

  it("skips a ticket whose blocker is still open for one that can start", () => {
    const next = nextTicket([
      item({
        number: 1,
        blockedBy: [ref(9)],
        createdAt: "2026-01-01T00:00:00Z",
      }),
      item({ number: 2, createdAt: "2026-10-12T00:00:00Z" }),
      item({ number: 9, createdAt: "2026-10-13T00:00:00Z" }),
    ]);
    expect(next?.number).toBe(2);
  });

  it("takes the oldest among equals", () => {
    const next = nextTicket([
      item({ number: 7, createdAt: "2026-10-05T00:00:00Z" }),
      item({ number: 3, createdAt: "2026-10-02T00:00:00Z" }),
      item({ number: 5, createdAt: "2026-10-09T00:00:00Z" }),
    ]);
    expect(next?.number).toBe(3);
  });

  it("never names a closed ticket", () => {
    const next = nextTicket([
      item({ number: 1, state: "CLOSED", priority: "P0" }),
      item({ number: 2, priority: "P4" }),
    ]);
    expect(next?.number).toBe(2);
  });

  it("answers nothing for a board with nothing open", () => {
    expect(nextTicket([item({ number: 1, state: "CLOSED" })])).toBeNull();
  });

  it("refuses while an open ticket has no priority, naming every one", () => {
    expect(() =>
      nextTicket([
        item({ number: 4, priority: null }),
        item({ number: 2, priority: "P1" }),
        item({ number: 8, priority: null }),
      ]),
    ).toThrow(
      "2 open tickets have no Priority: #4, #8. Score them on the board first.",
    );
  });

  it("refuses a priority that is not one of the six levels", () => {
    expect(() => nextTicket([item({ number: 4, priority: "High" })])).toThrow(
      '#4 has Priority "High", which is not one of P0, P1, P2, P3, P4, P5',
    );
  });

  it("refuses while a blocker sits below what it blocks, naming every pair", () => {
    expect(() =>
      nextTicket([
        item({ number: 1, priority: "P1", blockedBy: [ref(5)] }),
        item({ number: 2, priority: "P2", blockedBy: [ref(5), ref(6)] }),
        item({ number: 5, priority: "P3" }),
        item({ number: 6, priority: "P2" }),
      ]),
    ).toThrow(
      "Raise each blocker to at least the Priority of what waits on it: #5 (P3) blocks #1 (P1); #5 (P3) blocks #2 (P2).",
    );
  });

  it("accepts a blocker at or above the level of what it blocks", () => {
    const next = nextTicket([
      item({ number: 1, priority: "P1", blockedBy: [ref(5)] }),
      item({ number: 2, priority: "P3", blockedBy: [ref(6)] }),
      item({ number: 5, priority: "P1", createdAt: "2026-10-12T00:00:00Z" }),
      item({ number: 6, priority: "P0" }),
    ]);
    expect(next?.number).toBe(6);
  });

  it("refuses an open blocker the board does not hold, since its Priority cannot be read", () => {
    expect(() =>
      nextTicket([item({ number: 1, blockedBy: [ref(9)] })]),
    ).toThrow(
      "Raise each blocker to at least the Priority of what waits on it: #9 (not on this board) blocks #1 (P3).",
    );
  });

  it("reads a blocker in another repository as that repository's issue, not this one's namesake", () => {
    expect(() =>
      nextTicket([
        item({
          number: 1,
          priority: "P1",
          blockedBy: [ref(3, "shyden-labs/other")],
        }),
        item({ number: 3, priority: "P0" }),
      ]),
    ).toThrow(
      "Raise each blocker to at least the Priority of what waits on it: shyden-labs/other#3 (not on this board) blocks #1 (P1).",
    );
  });

  it("passes over an epic while it has open sub-issues", () => {
    const next = nextTicket([
      item({ number: 1, priority: "P0", openSubIssues: 2 }),
      item({ number: 2, priority: "P2" }),
    ]);
    expect(next?.number).toBe(2);
  });

  it("names an epic once its sub-issues are closed", () => {
    const next = nextTicket([
      item({ number: 1, priority: "P0", openSubIssues: 0 }),
      item({ number: 2, priority: "P2" }),
    ]);
    expect(next?.number).toBe(1);
  });

  it("refuses when only epics with open sub-issues remain, naming them, rather than calling the board empty", () => {
    expect(() =>
      nextTicket([
        item({ number: 1, openSubIssues: 2 }),
        item({ number: 4, openSubIssues: 1 }),
      ]),
    ).toThrow(
      "Every open issue is an epic with open sub-issues: #1, #4. Put their stories on this board.",
    );
  });
});

/** One board page as `gh api graphql` returns it. */
const page = (content: Record<string, unknown>) => [
  {
    data: {
      node: {
        title: "Board",
        items: {
          nodes: [
            { status: { name: "Todo" }, priority: { name: "P2" }, content },
          ],
        },
      },
    },
  },
];
const issue = (over: Record<string, unknown> = {}) => ({
  __typename: "Issue",
  number: 4,
  title: "ticket 4",
  state: "OPEN",
  createdAt: "2026-10-01T00:00:00Z",
  repository: { nameWithOwner: REPO },
  blockedBy: {
    totalCount: 2,
    nodes: [
      {
        number: 3,
        state: "OPEN",
        repository: { nameWithOwner: "shyden-labs/other" },
      },
      { number: 2, state: "CLOSED", repository: { nameWithOwner: REPO } },
    ],
  },
  subIssues: {
    totalCount: 3,
    nodes: [{ state: "OPEN" }, { state: "CLOSED" }, { state: "OPEN" }],
  },
  ...over,
});

describe("parseNextItems", () => {
  it("keeps each open blocker with its repository, and counts the open sub-issues", () => {
    expect(parseNextItems(page(issue()))).toEqual([
      {
        repo: REPO,
        number: 4,
        title: "ticket 4",
        state: "OPEN",
        createdAt: "2026-10-01T00:00:00Z",
        status: "Todo",
        priority: "P2",
        blockedBy: [ref(3, "shyden-labs/other")],
        openSubIssues: 2,
      },
    ]);
  });

  it("refuses a blocker list longer than one page, rather than judging part of it", () => {
    expect(() =>
      parseNextItems(page(issue({ blockedBy: { totalCount: 51, nodes: [] } }))),
    ).toThrow("#4 has 51 blockers and one page read 0");
  });

  it("refuses a sub-issue list longer than one page, rather than judging part of it", () => {
    expect(() =>
      parseNextItems(
        page(issue({ subIssues: { totalCount: 101, nodes: [] } })),
      ),
    ).toThrow("#4 has 101 sub-issues and one page read 0");
  });
});
