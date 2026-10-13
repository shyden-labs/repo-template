# The project board

Every Shyden Labs project has one GitHub Project board for its stories. Every
session close-out states the project's progress **twice**, by tickets and by
effort, each with a % complete and an ETA. The board carries what both need.

## Setting up a new board

1. Create the board under the `shyden-labs` organisation and record its node
   id and title in the repo's `CLAUDE.md`. Every script and every write
   resolves the board from that node id and checks the title first.
2. Give it the Number field `Estimate`:

   ```sh
   node scripts/board-setup.ts <board-node-id> "<board title>"
   ```

   The script refuses a board whose title differs, creates the field only if
   it is missing, and reads it back.

## Estimates

- Points are Fibonacci: **1, 2, 3, 5, 8 or 13**. Anything larger is an epic:
  split it into stories.
- Score from the acceptance criteria against similar closed stories, never
  from felt hours.
- The board's `Estimate` field is the only home for a story's points. Don't
  copy them into the issue body.
- A story is not fully defined until it carries an Estimate. Set it when the
  story is filed (the story form says so).
- Epics carry no Estimate of their own: an epic is the sum of its stories. An
  epic not yet split gets an explicit points guess in its body, labelled as
  one, until its stories exist.
- Work after the release is labelled `post-launch`, and it is left out of the
  release-ready figures.

## Reporting progress

```sh
node scripts/board-progress.ts <board-node-id> "<board title>"
```

This prints the two close-out lines, for example:

```text
By tickets: 13% complete (32 of 254 in-scope stories closed; 9 epics and 2 post-launch left out). Measured pace 8.00 a day over the last 4 days (10, 14, 8, 0). ETA at that pace: 2026-11-01, before outside waits.
By effort: 14% complete (160 of 1114 points closed). Measured pace 40.00 points a day over the last 4 days (64, 53, 43, 0). ETA at that pace: 2026-10-28, before outside waits.
```

- The pace is measured over the last 7 days, or fewer while the board's oldest
  story is younger than that, because days before the project existed are not
  working days.
- A closed story with no Estimate counts at the mean of the scored closed
  stories, and the line says so as an assumption.
- While any open story lacks an Estimate, the effort line reads
  `By effort: unavailable, <n> of <m> open tickets scored`. Scoring them comes
  before any other work.
- The ETA is the pace's alone. A close-out adds what the pace cannot know:
  outside waits (store review, operator sign-offs, devices), any assumed
  change of pace, and which figures are measured and which assumed.

## In Progress means someone is working it

A ticket is In Progress only while a branch or an open pull request is working it
(operator, 2026-10-13: *"if a ticket is not in progress then it should not be
marked as in progress"*). When work stops, its Status goes back to the backlog at
once; when a ticket is picked up, its branch is named `<issue>-<slug>`.

`scripts/board-orphans.ts <board-node-id> "<board title>" <owner/repo>` fails,
naming each, while an open issue is In Progress and no open pull request names it
(`#<n>` in its title or body, a closing reference, or a head branch starting
`<n>-`) and no remote branch starts `<n>-`. A branch counts only while it has no
closed pull request, merged or not (operator: *"Branch counts until its PR
closes"*), so a leftover branch cannot hide an abandoned ticket. It fails closed when it cannot read the
board, the pull requests or the branches. Run it in the repository's required PR
checks, with a token that can read the board (`GITHUB_TOKEN` cannot read an
organisation's project: use the repository's GitHub App token).

## A board new to estimates

The first session on a board that has no Estimates does this before its
other work:

- **Score every open story.**
- **Score a calibration sample of the stories closed in the last 14 days.**
  A pace needs closed points to measure.
- **Check the closed scores against measured size**, for example lines written
  per merged PR, leaving out lock files, generated files and plans.
- **Read a spread of open stories in full**, and correct any score that turns
  out wrong.
