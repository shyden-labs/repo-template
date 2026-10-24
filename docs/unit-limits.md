# The unit limits

Every unit test is fast, cheap and on its own: it runs in under 1 s, uses at
most 0.1 s of its own thread's CPU, its file takes at most 0.1 s of CPU to
load, and it starts no process and opens no connection (operator rulings
2026-10-07 to 2026-10-24, every Shyden Labs project; issue #92). No limit is
ever raised: `hooks/unit-limit-never-raised.py` refuses a raised one.

## The limits

| Limit | Where it is set | What it measures |
| --- | --- | --- |
| 1 s per test and hook | `testTimeout`, `hookTimeout` in `vitest.unit.config.ts` | Wall time, by the runner. |
| 0.1 s of own CPU per test | `CPU_LIMIT_MICROSECONDS` in `tests/setup/limits.ts` | The test thread's CPU from its first `beforeEach` to its last `afterEach`, the test's own hooks included. |
| 0.07 s cut line | `CPU_CUT_MICROSECONDS` | Not a failure: a test whose heaviest run passes it is cut, because one test's CPU varies up to 2x run to run and the 0.1 s check must never trip at random. |
| 0.1 s of CPU to load a file | `LOAD_CPU_LIMIT_MICROSECONDS` | From just before the file is imported to its first hook: its imports and module-scope work, which no per-test timer sees. |
| No process, no connection | `tests/setup/refusals.ts` | Every way to start a process or reach the network throws, naming the test and the call. |

Each file runs in its own forked process (`pool: 'forks'`), so one thread's
CPU is one file's. A concurrent test (`it.concurrent`) is refused: its CPU
cannot be told from the tests beside it.

## What is refused

The seven `child_process` functions and `ChildProcess#spawn`, which every
start that is not synchronous takes (`cluster.fork` included);
`net.connect`, `net.createConnection`, `net.Socket#connect` (http, https,
http2 and tls connect through it) and `tls.connect`; UDP send and connect;
every `dns` lookup, resolve and reverse function, on `dns`, `dns.promises`
and both resolvers; `fetch` and `WebSocket`. Named, namespace, default,
`createRequire` and dynamic imports are all refused. Loopback and unix
sockets are refused too.

The install fails closed: if an entry it must refuse is missing (a Node
upgrade renamed it), every unit file fails rather than run unguarded.
`tests/unit/unit-refusal.test.ts` pins the full list this run refused.

## When a test does not fit

Cut its work first: build a smaller input, stand in the slow dependency,
read the file once. If the case itself needs the cost, a real process, a
socket or a heavy library, it moves to `tests/integration/` and the unit
suite keeps a stand-in of its logic, in the same pull request. A cut never
drops a real run; it moves. The integration suite
(`vitest.integration.config.ts`, `npm run test:integration`) runs in CI's
`build-and-test` job, with one measured time limit on its step and none
inside. It is also where release-cut's planted cases run against real git
(#87): a case that drives `git` itself starts a process, so unit keeps its
stand-ins and the real runs live here.

## Reading the reports

Every unit run ends with two reports:

```
Own CPU per test: 1181 measured, 0 unmeasured; 0 over 100.0 ms, 0 over 70.0 ms
  24.4 ms CPU, 56 ms wall  tests/unit/workflow-coverage.test.ts > githubApi > ...
Load per file: 38 measured, 0 unmeasured; 0 over 100.0 ms, 0 over 70.0 ms
  28.1 ms CPU, 36 ms wall  tests/unit/board-progress.test.ts
```

Each lists the ten heaviest. **Unmeasured** must be 0: a test or file that
ran with no figure means a judge stopped measuring. Anything over 70.0 ms is
cut in the next change that touches it, and a story is filed when it is not.

## The coverage run

`npm run test:coverage` runs the unit suite with the refusals but without
the two judges and the 1 s limits, because instrumented code runs slower
than the limits allow. The 1 s step, `npm run test:unit`, runs without
coverage. The judges' own logic is covered by `tests/unit/unit-limits.test.ts`.

## How it is set up

| File | Role |
| --- | --- |
| `tests/setup/limits.ts` | The limits, the judges and the report, as functions handed Vitest's hooks and a clock. |
| `tests/setup/refusals.ts` | The refusals, as a function handed Node's modules. |
| `tests/setup/files.ts` | The setup shims in order: refusal, CPU judge, load measure, load judge. |
| `tests/setup/unit-*.ts`, `tests/setup/load.ts` | Two-line shims wiring each into Vitest. |
| `tests/setup/limits-reporter.ts` | Prints both reports after every unit run. |
| `tests/unit/unit-limits.test.ts`, `tests/unit/unit-refusal.test.ts` | Pin all of the above, and try each refusal live. |
