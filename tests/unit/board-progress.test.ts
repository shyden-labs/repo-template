import { describe, it, expect } from 'vitest';
import {
  assertTitle,
  formatLines,
  inScope,
  parseItems,
  progress,
  type BoardItem,
} from '../../scripts/board-progress';

/**
 * Progress from the board, never from feel: every session close-out states
 * the project's % complete and an ETA twice, by tickets and by story points
 * (the `Estimate` field). These tests pin how both are counted.
 */

const TODAY = '2026-10-04';

function item(over: Partial<BoardItem> & { number: number }): BoardItem {
  return {
    title: `Story ${String(over.number)}`,
    state: 'OPEN',
    createdAt: '2026-09-01T00:00:00Z',
    closedAt: null,
    estimate: 3,
    labels: [],
    ...over,
  };
}

const closedOn = (number: number, day: string, estimate: number | null = 3) =>
  item({
    number,
    state: 'CLOSED',
    closedAt: `${day}T12:00:00Z`,
    estimate,
  });

describe('inScope', () => {
  it('leaves out an epic, which is the sum of its stories', () => {
    expect(inScope(item({ number: 1, title: 'Epic M1: Core' }))).toBe(false);
  });

  it('leaves out a post-launch story', () => {
    expect(inScope(item({ number: 2, labels: ['post-launch'] }))).toBe(false);
  });

  it('keeps an ordinary story', () => {
    expect(inScope(item({ number: 3 }))).toBe(true);
  });
});

describe('progress by tickets', () => {
  it('counts closed of all in-scope stories', () => {
    const p = progress(
      [
        closedOn(1, '2026-10-03'),
        item({ number: 2 }),
        item({ number: 3 }),
        item({ number: 4, title: 'Epic M2' }),
      ],
      TODAY,
    );
    expect(p.tickets).toMatchObject({ closed: 1, total: 3 });
  });

  it('counts closures per UTC day over the 7 days ending today, oldest first', () => {
    const p = progress(
      [
        closedOn(1, '2026-09-28'),
        closedOn(2, '2026-10-03'),
        closedOn(3, '2026-10-03'),
        closedOn(4, '2026-10-04'),
      ],
      TODAY,
    );
    expect(p.tickets.pace).toEqual([1, 0, 0, 0, 0, 2, 1]);
  });

  it('starts the window at the board’s oldest story when that is younger than 7 days', () => {
    const p = progress(
      [
        { ...closedOn(1, '2026-10-03'), createdAt: '2026-10-02T08:00:00Z' },
        item({ number: 2, createdAt: '2026-10-02T09:00:00Z' }),
        item({ number: 3, createdAt: '2026-10-03T09:00:00Z' }),
      ],
      TODAY,
    );
    expect(p.tickets.pace).toEqual([0, 1, 0]);
  });

  it('leaves a closure 7 days before today out of the window', () => {
    const p = progress([closedOn(1, '2026-09-27')], TODAY);
    expect(p.tickets.pace).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('progress by effort', () => {
  it('is unavailable while an open in-scope story has no estimate', () => {
    const p = progress(
      [item({ number: 1 }), item({ number: 2, estimate: null })],
      TODAY,
    );
    expect(p.effort).toEqual({ available: false, scored: 1, open: 2 });
  });

  it('counts closed points of all points', () => {
    const p = progress(
      [closedOn(1, '2026-10-03', 5), item({ number: 2, estimate: 8 })],
      TODAY,
    );
    expect(p.effort).toMatchObject({
      available: true,
      closedPoints: 5,
      openPoints: 8,
      assumedClosed: 0,
    });
  });

  it('counts an unscored closed story at the scored closed mean, as assumed', () => {
    const p = progress(
      [
        closedOn(1, '2026-10-03', 2),
        closedOn(2, '2026-10-03', 4),
        closedOn(3, '2026-09-01', null),
        item({ number: 4, estimate: 5 }),
      ],
      TODAY,
    );
    expect(p.effort).toMatchObject({ closedPoints: 9, assumedClosed: 1 });
  });

  it('ignores an epic’s own estimate', () => {
    const p = progress(
      [item({ number: 1, estimate: 5 }), item({ number: 2, title: 'Epic X', estimate: 40 })],
      TODAY,
    );
    expect(p.effort).toMatchObject({ openPoints: 5 });
  });

  it('counts points closed per day over the same window', () => {
    const p = progress(
      [closedOn(1, '2026-10-03', 5), closedOn(2, '2026-10-04', 8)],
      TODAY,
    );
    expect(p.effort).toMatchObject({ pace: [0, 0, 0, 0, 0, 5, 8] });
  });
});

describe('formatLines', () => {
  const sample = (): BoardItem[] => [
    closedOn(1, '2026-10-03', 5),
    closedOn(2, '2026-10-04', 2),
    item({ number: 3, estimate: 8 }),
    item({ number: 4, estimate: 13 }),
    item({ number: 5, title: 'Epic M1' }),
    item({ number: 6, labels: ['post-launch'] }),
  ];

  it('states tickets complete, the measured pace and the ETA at that pace', () => {
    expect(formatLines(progress(sample(), TODAY), TODAY)[0]).toBe(
      'By tickets: 50% complete (2 of 4 in-scope stories closed; 1 epic and 1 post-launch left out). ' +
        'Measured pace 0.29 a day over the last 7 days (0, 0, 0, 0, 0, 1, 1). ' +
        'ETA at that pace: 2026-10-11, before outside waits.',
    );
  });

  it('states effort complete, the measured pace and the ETA at that pace', () => {
    expect(formatLines(progress(sample(), TODAY), TODAY)[1]).toBe(
      'By effort: 25% complete (7 of 28 points closed). ' +
        'Measured pace 1.00 points a day over the last 7 days (0, 0, 0, 0, 0, 5, 2). ' +
        'ETA at that pace: 2026-10-25, before outside waits.',
    );
  });

  it('names the assumed points of unscored closed stories', () => {
    const lines = formatLines(
      progress(
        [
          closedOn(1, '2026-10-03', 4),
          closedOn(2, '2026-08-01', null),
          item({ number: 3, estimate: 8 }),
        ],
        TODAY,
      ),
      TODAY,
    );
    expect(lines[1]).toContain(
      '1 closed story unscored, counted at the scored mean of 4.0 points (assumed)',
    );
  });

  it('says effort is unavailable, with the count scored, before the backfill', () => {
    expect(
      formatLines(
        progress([item({ number: 1, estimate: null }), item({ number: 2 })], TODAY),
        TODAY,
      )[1],
    ).toBe('By effort: unavailable, 1 of 2 open tickets scored');
  });

  it('gives no date when nothing closed in the window', () => {
    expect(formatLines(progress([item({ number: 1 })], TODAY), TODAY)[0]).toContain(
      'ETA at that pace: none, nothing closed in the last 7 days.',
    );
  });
});

describe('parseItems', () => {
  const page = (nodes: unknown[]) => ({
    data: {
      node: {
        title: 'Example Stories',
        items: { nodes },
      },
    },
  });

  it('reads an issue with its Estimate, state, close time and labels', () => {
    expect(
      parseItems([
        page([
          {
            estimate: { number: 5 },
            content: {
              __typename: 'Issue',
              number: 7,
              title: 'Story',
              state: 'CLOSED',
              createdAt: '2026-10-01T00:00:00Z',
              closedAt: '2026-10-03T01:02:03Z',
              labels: { nodes: [{ name: 'post-launch' }] },
            },
          },
        ]),
      ]),
    ).toEqual([
      {
        number: 7,
        title: 'Story',
        state: 'CLOSED',
        createdAt: '2026-10-01T00:00:00Z',
        closedAt: '2026-10-03T01:02:03Z',
        estimate: 5,
        labels: ['post-launch'],
      },
    ]);
  });

  it('reads an unset Estimate as null', () => {
    const [read] = parseItems([
      page([
        {
          estimate: null,
          content: {
            __typename: 'Issue',
            number: 8,
            title: 'Story',
            state: 'OPEN',
            createdAt: '2026-10-01T00:00:00Z',
            closedAt: null,
            labels: { nodes: [] },
          },
        },
      ]),
    ]);
    expect(read?.estimate).toBeNull();
  });

  it('refuses a draft item by name, never skipping it', () => {
    expect(() =>
      parseItems([page([{ estimate: null, content: { __typename: 'DraftIssue', title: 'Idea' } }])]),
    ).toThrow('draft item "Idea" is not an issue: convert it, or remove it from the board');
  });

  it('reads every page', () => {
    const one = (number: number) => ({
      estimate: null,
      content: {
        __typename: 'Issue',
        number,
        title: 'S',
        state: 'OPEN',
        createdAt: '2026-10-01T00:00:00Z',
        closedAt: null,
        labels: { nodes: [] },
      },
    });
    expect(parseItems([page([one(1)]), page([one(2), one(3)])]).map((i) => i.number)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('assertTitle', () => {
  it('passes the board it was asked for', () => {
    expect(() => assertTitle('Example Stories', 'Example Stories')).not.toThrow();
  });

  it('refuses any other board by name', () => {
    expect(() => assertTitle('ShyTalk Stories', 'Example Stories')).toThrow(
      'the board is "ShyTalk Stories", not "Example Stories": nothing read',
    );
  });
});
