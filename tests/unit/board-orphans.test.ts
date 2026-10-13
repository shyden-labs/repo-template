import { describe, it, expect } from 'vitest';
import { inProgressIssues, findOrphanIssues, type OpenPullRequest } from '../../scripts/board-orphans';

/**
 * A ticket is In Progress only while a branch or an open pull request is working
 * it (operator 2026-10-13: "if a ticket is not in progress then it should not be
 * marked as in progress"; issue #10). Branches here are named `<issue>-<slug>`.
 * An open pull request always counts; a branch counts only while it has no closed
 * pull request (operator 2026-10-13: "Branch counts until its PR closes").
 */

function page(items: { number: number; state: 'OPEN' | 'CLOSED'; status: string | null }[]) {
  return {
    data: {
      node: {
        title: 'Board',
        items: {
          nodes: items.map((i) => ({
            status: i.status === null ? null : { name: i.status },
            content: { __typename: 'Issue', number: i.number, state: i.state },
          })),
        },
      },
    },
  };
}

const pr = (over: Partial<OpenPullRequest>): OpenPullRequest => ({
  title: 'x',
  body: '',
  headRefName: 'feature',
  closes: [],
  ...over,
});

describe('inProgressIssues', () => {
  it('keeps open issues whose Status is In Progress, across pages', () => {
    expect(
      inProgressIssues([
        page([
          { number: 1, state: 'OPEN', status: 'In Progress' },
          { number: 2, state: 'OPEN', status: 'Todo' },
        ]),
        page([{ number: 3, state: 'OPEN', status: 'In Progress' }]),
      ]),
    ).toEqual([1, 3]);
  });

  it('ignores a closed issue still marked In Progress', () => {
    expect(inProgressIssues([page([{ number: 4, state: 'CLOSED', status: 'In Progress' }])])).toEqual([]);
  });

  it('ignores an issue with no Status', () => {
    expect(inProgressIssues([page([{ number: 5, state: 'OPEN', status: null }])])).toEqual([]);
  });
});

describe('findOrphanIssues', () => {
  it('names an In Progress issue nothing is working', () => {
    expect(findOrphanIssues([7], [pr({})], ['main', 'develop'], [])).toEqual([7]);
  });

  it('a pull request naming #7 in its title claims it', () => {
    expect(findOrphanIssues([7], [pr({ title: 'Fix the board (#7)' })], [], [])).toEqual([]);
  });

  it('a pull request naming #7 in its body claims it', () => {
    expect(findOrphanIssues([7], [pr({ body: 'Refs #7.' })], [], [])).toEqual([]);
  });

  it('a pull request that closes #7 claims it', () => {
    expect(findOrphanIssues([7], [pr({ closes: [7] })], [], [])).toEqual([]);
  });

  it('a pull request whose head branch starts 7- claims it', () => {
    expect(findOrphanIssues([7], [pr({ headRefName: '7-board' })], [], [])).toEqual([]);
  });

  it('a remote branch starting 7- claims it', () => {
    expect(findOrphanIssues([7], [], ['7-board'], [])).toEqual([]);
  });

  it('#17 and #70 do not claim issue 7', () => {
    expect(findOrphanIssues([7], [pr({ title: 'Fix #17', body: 'see #70' })], [], [])).toEqual([7]);
  });

  it('a remote branch whose pull request was closed unmerged does not claim it', () => {
    expect(findOrphanIssues([7], [], ['7-board'], ['7-board'])).toEqual([7]);
  });

  it('an open pull request still claims it when an older branch of the issue had its pull request closed', () => {
    expect(findOrphanIssues([7], [pr({ headRefName: '7-board-take-2' })], ['7-board'], ['7-board'])).toEqual([]);
  });

  it('branches 17-x and 70-x do not claim issue 7', () => {
    expect(findOrphanIssues([7], [pr({ headRefName: '17-x' })], ['70-x'], [])).toEqual([7]);
  });
});
