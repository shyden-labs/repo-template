# Device tests

Every mobile test is one test, run on Android AND iOS, in parallel (issue #26).

Shyden, 2026-10-16, verbatim: *"go ahead with the real taps change and make
sure ALL the android tests are the same on iOS. the suite should be exactly the
same, run in parallel. Treat it as every mobile test is mobile. this means if
it's mobile, it's Android AND iOS. not separate tests for each. Global rule.
tell all the other projects, update the template. make sure this can never
happen again."*

What drew it: shyden.co.uk's iPhone ran 80 hand-written twin tests with taps
faked in the page, while the Android ran 1,141 Playwright tests with real
input.

## The shape

- Write each device test **once**, in `tests/devices/`. Never write a copy per
  phone, or a test named for one platform (its path or its title saying
  Android, iOS or iPhone).
- `playwright.config.ts` has one project per phone, each with `metadata.phone`,
  and every phone project runs exactly the same files. Set the folder, match
  and ignore once, on the config, not per phone. Tests run in parallel
  (`fullyParallel`).
- Each phone says how its input reaches the page in `metadata.input`:
  - `"real"`: real taps.
  - `"stand-in"`: anything weaker, such as taps dispatched inside the page. A
    stand-in is marked in every report, and its repository has a ticket for
    the harness that would make the input real.
- A step one phone cannot take is raised at once, never silently skipped.

The template holds the config as a plain object, so it needs no Playwright. A
repository with an app adds `@playwright/test`, its phone harness and its
tests, and keeps this shape.

## What holds it

- `tests/unit/device-suite.test.ts` reads this repository's config. It checks
  that the phones are `android-chrome` and `ios-safari`, that each says its
  input mode, that every phone runs exactly the same files (set equality, both
  ways), and that no test is named for one platform.
  - It pins how many device files it judged: the template has none. A
    repository that adds device tests raises that count in the same change,
    so the guard never quietly judges nothing.
- `tests/unit/device-projects.ts` holds the checks themselves, each tested on
  planted configs and files in `device-projects.test.ts`.
- `tests/devices/platform-named.json` lists the only files allowed a
  platform's name. Only Shyden grants an entry, and each one carries his name,
  the date and his words. The template's list is empty.
- `node scripts/devices-report.ts <report.json>`, given Playwright's JSON
  report, prints each phone's totals. It fails unless every phone ran the
  same number of tests with none failed and none skipped. A stand-in phone is
  marked "STAND-IN, weaker than real taps" on every line.
