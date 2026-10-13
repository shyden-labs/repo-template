import { describe, it, expect } from 'vitest';
import { nextTicket, type NextItem } from '../../scripts/board-next';

/**
 * The board, not a handover file, names the next ticket (operator
 * 2026-10-12): the highest Priority among open issues; within a level, In
 * Progress first, then unblocked, then the oldest.
 */
const item = (over: Partial<NextItem> & { number: number }): NextItem => ({
  title: `ticket ${over.number}`,
  state: 'OPEN',
  createdAt: '2026-10-01T00:00:00Z',
  status: 'Todo',
  priority: 'P3',
  blockedBy: [],
  ...over,
});

describe('nextTicket', () => {
  it('takes the highest priority, however new it is', () => {
    const next = nextTicket([
      item({ number: 1, priority: 'P2', createdAt: '2026-01-01T00:00:00Z' }),
      item({ number: 2, priority: 'P0', createdAt: '2026-10-12T00:00:00Z' }),
    ]);
    expect(next?.number).toBe(2);
  });

  it('finishes what is In Progress before starting anything else at its level', () => {
    const next = nextTicket([
      item({ number: 1, createdAt: '2026-01-01T00:00:00Z' }),
      item({ number: 2, status: 'In Progress', createdAt: '2026-10-12T00:00:00Z' }),
    ]);
    expect(next?.number).toBe(2);
  });

  it('skips a ticket whose blocker is still open for one that can start', () => {
    const next = nextTicket([
      item({ number: 1, blockedBy: [9], createdAt: '2026-01-01T00:00:00Z' }),
      item({ number: 2, createdAt: '2026-10-12T00:00:00Z' }),
    ]);
    expect(next?.number).toBe(2);
  });

  it('takes the oldest among equals', () => {
    const next = nextTicket([
      item({ number: 7, createdAt: '2026-10-05T00:00:00Z' }),
      item({ number: 3, createdAt: '2026-10-02T00:00:00Z' }),
      item({ number: 5, createdAt: '2026-10-09T00:00:00Z' }),
    ]);
    expect(next?.number).toBe(3);
  });

  it('never names a closed ticket', () => {
    const next = nextTicket([
      item({ number: 1, state: 'CLOSED', priority: 'P0' }),
      item({ number: 2, priority: 'P4' }),
    ]);
    expect(next?.number).toBe(2);
  });

  it('answers nothing for a board with nothing open', () => {
    expect(nextTicket([item({ number: 1, state: 'CLOSED' })])).toBeNull();
  });

  it('refuses while an open ticket has no priority, naming every one', () => {
    expect(() =>
      nextTicket([
        item({ number: 4, priority: null }),
        item({ number: 2, priority: 'P1' }),
        item({ number: 8, priority: null }),
      ]),
    ).toThrow('2 open tickets have no Priority: #4, #8. Score them on the board first.');
  });

  it('refuses a priority that is not one of the six levels', () => {
    expect(() => nextTicket([item({ number: 4, priority: 'High' })])).toThrow(
      '#4 has Priority "High", which is not one of P0, P1, P2, P3, P4, P5',
    );
  });
});
