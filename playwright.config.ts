/**
 * The device suite: every mobile test is ONE test, run on Android AND iOS in
 * parallel (issue #26; Shyden 2026-10-16: "the suite should be exactly the
 * same, run in parallel ... if it's mobile, it's Android AND iOS. not separate
 * tests for each"). Write each test once in `tests/devices/`; both phones run
 * that same file.
 *
 * A plain object, so the template needs no Playwright to hold it. A repository
 * with an app adds `@playwright/test`, its phone harness and its tests, and
 * keeps this shape: `tests/unit/device-suite.test.ts` holds it to it.
 * `metadata.input` says how a phone's input reaches the page: "real" (real
 * taps) or "stand-in" (anything weaker, marked in every report, with a ticket
 * for the harness that would make it real). docs/devices.md has the rest.
 */
export default {
  testDir: 'tests/devices',
  fullyParallel: true,
  projects: [
    { name: 'android-chrome', metadata: { phone: 'android', input: 'real' } },
    { name: 'ios-safari', metadata: { phone: 'ios', input: 'real' } },
  ],
};
