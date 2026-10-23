# Diagnostic logs

Operator ruling, 2026-10-16, for every Shyden Labs project:

> Do some extebnsive research into different log stores. even better if we can self host one for free on our oracle servers. let's have a look at some options. Because this is becoming a much bigger piece to work on. I no longer what this blocking the release. tell all projects that we will do this after their release but we should design it into the template so that every project will do this thre same way. consistency is key.

And the same day:

> we must make sure there's no private information logged that can be leaked. and nothing that is personally identifiable

> the default should always to be not include, or anonymise personal information unless we need it. if we need it, then we must clearly state it in our privacy policy, including why we need it, what we do with it and when, and how long we can keep it for.

This document is the design every project follows (issue #18). It covers **diagnostic logs** only: what a developer needs to debug an app, with no personal data by default, summarised, and kept a short time. Compliance and anti-fraud records are a separate system with their own store (#24, #25). Three stories build what this document fixes: the logging module (#19), the viewer (#22) and the collector (#23). Each project adds its logs **after** its release. Nothing in this design makes any project's release wait. The `logs` test suite (`docs/logs-suite.md`) still gates each release.

Every figure below cites its source by a tag such as [S3], listed with the date it was read under [Sources](#sources). Where a figure is computed or assumed, it says so.

## The decision

The store was chosen four times, each time after more research:

1. **2026-10-16: Cloudflare R2.** Oracle allows one free account per person ("Creating or attempting to create multiple free accounts is prohibited" [S15]), and the only other always-free server found was one Google e2-micro in a US region [S14]. Shyden chose *"Cloudflare storage (Recommended)"*.
2. **2026-10-16: reopened.** *"I feel like we should be building this logging ourselves. and build our own viewer. we just need a free place to store it."* The module, the collector and the viewer are ours; only the store is bought in, and it must be free.
3. **2026-10-16: Axiom.** After research sized for detail (1 million 500-byte lines a day), Shyden chose Axiom's free "Personal" plan.
4. **2026-10-23: our own on R2.** Axiom's free plan allows 3 datasets, 1 user and US or EU storage only [S1], so no layout fitted four projects. Asked again, Shyden answered: *"consider these options again, look at other providers and what we could possibly build ourselves. also you need to remember that our region is now Indonesia, not the EU/UK"*. After a third research pass, Shyden chose by AskUserQuestion *"Build our own on R2 (Recommended)"*: our collector writes compressed batches to Cloudflare R2 with the Asia-Pacific location hint, a lifecycle rule deletes them, and our viewer searches them.

Cloudflare already serves every project's apps, so R2 adds no new third party. No log store is bought in.

Three more choices were made on 2026-10-23, after the research below:

- **Where the collector runs.** A free account's Worker requests are one allowance shared by every Worker and Pages Function in it [S9][S10], and calls through a Service Binding "do not incur additional request fees" [S11]. Shyden chose by AskUserQuestion *"Same account (Recommended)"*: the collector runs beside the apps, Cloudflare apps reach it through a Service Binding, and only senders outside Cloudflare spend requests. Asked whether every Cloudflare project is in one account, he answered *"All in one account"*.
- **Error bursts.** The collector stores each batch in a Durable Object, whose free writes are shared with the apps' own Durable Objects (yawelo-idle's Roadmap among them) [S12]. Shyden chose by AskUserQuestion *"Fold repeats (Recommended)"*: the first occurrence of an error is sent at once, and identical repeats over the next 60 seconds are counted in the app and sent as one line (count, first and last time) at the end of that minute.
- **Traffic to budget for.** No project had production app logs on 2026-10-23. Shyden chose by AskUserQuestion *"Budget from launch figures (Recommended)"*: the budget is sized from a ceiling of 1 million 500-byte lines a day, and each project records its measured figure when it adopts the module (#19).

## The stores compared

Five candidates in full. Volumes use the ceiling above: 1 million 500-byte lines a day per environment is 500 MB a day, or 15 GB a month, before compression. "10x" is ten times that.

| Criterion | Our own on Cloudflare R2 (chosen) | Axiom Personal | Grafana Cloud Free | New Relic Free | VictoriaLogs, self-hosted |
| --- | --- | --- | --- | --- | --- |
| Licence | Our code, Apache-2.0; R2 is a Cloudflare service | Hosted service; its Workers sender is MIT [S2] | Hosted service | Hosted service | Apache-2.0 [S16] |
| Cost now | $0: every figure under [Budget](#budget) is under half of a free allowance | $0: "500 GB/mo data loading compute", "25 GB storage" [S1] | $0: "Limited to 50 GB ingested per month" [S3] | $0: "100 GB of free data ingest/month" [S5] | $0 on a Google e2-micro, "30 GB-months standard persistent disk" [S14] |
| Cost at 10x volume | About $5.24 a month (computed below): Workers Paid "$5 USD per month" [S13] for Durable Object writes, plus about 16 GB over the free 10 GB at "$0.015 / GB-month" [S6] | 300 GB a month is under the 500 GB loading line; storage at 10x not stated [S1] | 300 GB a month is over the 50 GB; over-limit behaviour and paid rate not read [S3] | Over 100 GB: "Data ingest will cease ... when you exceed your free 100 GB" [S5] | Disk at 10x not measured; "Any usage that exceeds the Free Tier usage limits is billed at standard rates." [S14] |
| Retention and deletion | Ours: a lifecycle rule per bucket deletes after N days, "typically ... within 24 hours" [S7] | "30-day retention", only shorter on Personal [S1] | "14 day retention" [S3], shorter than the 30 days prod needs | "at least 8 days" [S5] | `-retentionPeriod`, default 7 days [S16] |
| Keeping projects apart | One key prefix per project; every read is bounded by it | "Personal Datasets 3" [S1]: fewer than our projects | Labels (not read further) | Attributes (not read further) | Stream fields (not read further) |
| How each sender ships | Cloudflare apps: Service Binding to the collector; other servers: HTTPS to the collector with a secret; device apps send nothing | `POST /v1/ingest/{dataset-id}`, NDJSON, API token [S1] | Loki push, JSON body [S4] | HTTP log API (not read further) | `/insert/jsonline`, NDJSON [S16] |
| arm64 | Not applicable (managed) | Not applicable (hosted) | Not applicable (hosted) | Not applicable (hosted) | arm64 binaries per release [S16] |
| Resources needed | One collector Worker, one Durable Object class, two buckets, one viewer Worker | An account | An account | An account | A server: "It runs smoothly on Raspberry PI" [S16]; e2-micro is US-only [S14] |
| Backup | None: diagnostic logs are short-lived and R2 is the copy; losing them loses debugging history only | Provider's | Provider's | Provider's | Snapshots, ours to copy off the server [S16] |
| Upkeep | Our collector and viewer code, updated by Dependabot like any project | An account and a token | An account and a token | An account and a key | Patching a server and watching its disk |
| Where the data sits | `apac` location hint, best effort [S7] | "US" edge deployment on Personal [S1] | "Indonesia: AWS ap-southeast-3" exists [S3]; free-stack region not stated | No Asia-Pacific region found [S5] | e2-micro: US regions only [S14] |

Also looked at, and ruled out on the figures alone:

| Store | Why not |
| --- | --- |
| Better Stack Free | "3 GB logs retained for 3 days" [S17]: the ceiling writes 15 GB a month per environment |
| LaunchDarkly Developer | "10M logs and 10M traces /mo" [S18]: the ceiling writes 30 million lines a month per environment |
| Grafana Loki, self-hosted | AGPL-3.0 is allowed for a server we only run, but "Grafana Loki does not come with any included authentication layer." [S19], and it needs a server like VictoriaLogs |
| OpenObserve, self-hosted | AGPL-3.0 [S19]; needs a server like VictoriaLogs |
| Quickwit, self-hosted | "Support of aarch64 is currently experimental." [S19]; needs a server |
| Cloudflare Workers Logs | "Workers Free \| 200,000 per day \| 3 Days" [S8], read only in Cloudflare's dashboard; sending them out (Logpush) "is available on the Workers Paid plan" [S8] |
| Cloudflare D1 or Analytics Engine | D1 writes 100,000 rows a day and Analytics Engine 100,000 data points a day on the free plan [S20], one per line: fewer than the ceiling |

## The line format

Every line is one JSON object on one line, with these five fields first, in this order: `ts`, `lvl`, `app`, `env`, `code`.

- `ts`: the time in UTC, ISO 8601 with milliseconds (`2026-10-23T06:41:17.123Z`).
- `lvl`: `debug`, `info`, `warn` or `error`. `debug` is off outside dev.
- `app`: the app's name, declared once by the project (`site`, `api`).
- `env`: `prod` or `dev`.
- `code`: the event code, declared once by the project with its fields (`report.store_failed`).

Every other field has one of seven types, and only these: a code from a closed list, a count, a duration in milliseconds, a boolean, a status number, a content id, or a commit.

| Type | What it holds | Example |
| --- | --- | --- |
| Code | One value from a list declared with the field | `"route":"/api/report"` (a route pattern, never a URL as requested) |
| Count | A whole number, 0 or more | `"count":17` |
| Duration | Whole milliseconds, 0 or more | `"dur_ms":41` |
| Boolean | `true` or `false` | `"cached":true` |
| Status number | An HTTP status or a declared numeric status | `"status":503` |
| Content id | An id of our own content, never of a person, account or device | `"content_id":"c004211"` |
| Commit | The deployed commit, 7 to 40 hex characters | `"commit":"8c19e5c"` |

An `error` line carries the error's name and a code, never its message. The name is a code too, from the error classes the project declares. Free text, error messages, and request or response bodies are refused when the line is written, never redacted afterwards. The module (#19) enforces this: an undeclared code, an undeclared field or a value outside its type is refused before any sink sees it.

Three line shapes are fixed:

- **An event:** `{"ts":"2026-10-23T06:41:17.123Z","lvl":"error","app":"site","env":"prod","code":"report.store_failed","name":"TypeError","status":503,"dur_ms":41,"commit":"8c19e5c"}`
- **A folded repeat:** the same event, with `ts` the time of the first, `count` how many, and `span_ms` the duration from the first to the last, so the last time is `ts` plus `span_ms` and no field leaves the seven types. Identical means the same app, code and fields apart from times and durations.
- **A summary:** routine successes become one line per window: `{"ts":"…","lvl":"info","app":"site","env":"prod","code":"http.summary","route":"/api/report","status":200,"count":2611,"p50_ms":12,"p95_ms":40,"max_ms":88,"window_ms":300000,"commit":"8c19e5c"}`

### Refused by default

None of these is ever logged unless declared as a personal field below: money amounts, holdings, balances, account or customer numbers, messages, page contents, names, login or user names, emails, phone numbers, IP addresses, precise locations, device or advertising IDs, and URLs carrying any of these. Anything a user can copy or export from a log passes the same check.

A project may log a personal field only by declaring it with a pointer to the privacy-policy section that says why it is needed, what is done with it and when, and how long it is kept. The declaration names the field, its pointer (a file path and section heading) and its retention. A test checks that the pointer resolves to that section, and a field with no pointer, or one that resolves to nothing, is refused when declared. The retention is enforced by deleting or anonymising the line, with a `logs`-suite check that a line past it is gone. Because R2's location hint is best effort, the declaration also names the basis for keeping that field outside Indonesia under Pasal 56 of UU 27/2022 [S21], whose paragraph (2) requires the receiving country to have protection "setara atau lebih tinggi" than the law's.

## Where each kind of app keeps its log

Server apps send to the collector. An app on a user's device keeps its log on the device, where the user can read and copy it through the same allow-list check, and sends nothing. That stays so until Shyden decides otherwise.

| Sender | Where its log goes |
| --- | --- |
| Cloudflare Workers and Pages Functions (yawelo-idle, shyden.co.uk, ShyTalk's site) | The collector, through a Service Binding |
| A server outside Cloudflare (ShyTalk's Node server) | The collector over HTTPS, with a secret of its own |
| The browser game and its Electron shell, the Chrome extension, the Android and iOS apps | A ring buffer on the device (#19), readable and copyable by the user |
| A tool run only on a laptop or in CI (steadyhand's Python tool) | Its own console or file, never sent |

## The R2 design

**Buckets.** There is one bucket per environment, `shyden-logs-prod` and `shyden-logs-dev`, each created with the `apac` location hint. Two reasons decide it: each environment has its own retention, which is one lifecycle rule per bucket, and the dev collector is bound only to the dev bucket, so dev code can never write into production's logs. Projects are kept apart by key prefix, and every read is bounded by one. One bucket per project and environment was rejected: eight or more buckets and bindings for the same separation.

The hint is not a promise: "Location Hints are a best effort and not a guarantee", and a hint is "only honored the first time a bucket with a given name is created" [S7]. The buckets are created once, with the hint, and never deleted and recreated.

**Keys.** Each flushed batch is one gzipped NDJSON object at `<project>/<app>/<YYYY-MM-DD>/<HH>/<HHmmssSSS>-<8 hex>.ndjson.gz`, all in UTC. The viewer lists by prefix down to the hour. The random suffix keeps two flushes in the same millisecond on different keys, since R2 allows writes to one key "1 per second" [S7].

**Retention.** A lifecycle rule deletes objects in `shyden-logs-prod` after 30 days and in `shyden-logs-dev` after 7 days. A daily check lists each declared app's day prefix two days past its bucket's retention and opens an issue for ShydenMcM if any object remains.

**Access.** Only the collector writes, through its R2 binding; no app has a binding to a log bucket. Only the viewer reads, through a read-only binding, behind Cloudflare Access with one allowed identity: Shyden. Access is free up to a "50 user limit" [S22]. The viewer is a Worker in the same account, reading both buckets, with the environment as a filter. This document gains the viewer's deploy and open steps with #22.

**Liveness.** Under the rule that nothing we rely on stops silently, one daily scheduled run per environment plants a `log.canary` line through the module and the collector, and the next day's run finds it in R2. A missing canary opens an issue for ShydenMcM. The same run does the retention check and the budget watch, so all three use one of the five free Cron Triggers [S9]. Its daily cost is two collector sends, about 30 R2 list operations and two reads.

**Collector.** Apps send through the module to the collector Worker, which stores each batch in a Durable Object per project, app and environment before answering, and an alarm flushes the object's lines to R2 as one batch per 5-minute window, sooner at 2,000 lines or 1 MiB (#23). Each batch the collector receives is one Durable Object row, never one row per line.

## Budget

Free limits, read 2026-10-23:

- R2: "10 GB-month / month" stored, "1 million requests / month" Class A, "10 million requests / month" Class B [S6]. Writes and lists are Class A ("`ListObjects`, `PutObject`"), reads are Class B ("`GetObject`"), and "`DeleteObject`" is free [S6].
- Workers: "Accounts on the Workers Free plan have a daily request limit of 100,000 requests", over which "Cloudflare returns **Error 1027**" [S9]. Pages Functions share it: "you could use 50,000 Functions requests and 50,000 Workers requests to use your full 100,000 daily request usage" [S10]. Service Bindings "do not incur additional request fees" [S11].
- Durable Objects: "Requests | 100,000 / day", which "Includes HTTP requests, RPC sessions, WebSocket messages, and alarm invocations"; "Rows written | 100,000 / day"; "Each setAlarm() is billed as a single row written."; "Deletes are counted as rows written."; and over any of them "further operations of that type will fail with an error", reset "at 00:00 UTC" [S12]. The pages do not say whether these are per account; this budget assumes they are, the safe reading, so they are shared with every project's own Durable Objects.

The aim is every figure under half of its allowance. Assumed for the ceiling: 1 million lines a day per environment, 500 bytes each, from at most 12 declared streams (project, app, environment) per environment.

### a. Batched sends

Apps never send one request per line. The module holds routine lines for up to 60 seconds and sends them as one batch. It sends the first occurrence of an error or warning at once and folds identical repeats for 60 seconds. The collector flushes each stream once per 5-minute window, so at most 12 × 288 = 3,456 flushes a day per environment, 6,912 in all.

Each send costs one Durable Object request and two rows (stored, then deleted after the flush); each flush costs one alarm invocation and one `setAlarm` row. Logging's share is **20,000 sends a day** across the account:

| Allowance (per day) | Logging's use (computed) | Share |
| --- | --- | --- |
| Durable Object rows written, 100,000 | 20,000 × 2 + 6,912 = 46,912 | 47% |
| Durable Object requests, 100,000 | 20,000 + 6,912 = 26,912 | 27% |
| Worker requests, 100,000 | Service Binding sends 0; outside senders at most 5,000; the viewer at most 1,000; scheduled runs 2 | at most 6% |

shyden.co.uk's Pages Functions used 80,516 requests in the 30 days to 2026-10-23, 2,684 a day on average, with 0 errors (measured by its session). That leaves the apps at least 90% of the Worker requests.

Each stream's Durable Object counts its sends per UTC day. Past its share (20,000 divided by the declared streams), it answers `hold`, and the module then holds routine lines for the whole 5-minute window. Errors still follow the 60-second fold. The count lives in memory, so a restart can under-count it; the budget watch (e) catches any drift.

### b. Fewer lines, same answers

Every error, warning and refusal is kept as its own line. Routine successes become one summary line per window (count by route and status; duration p50, p95 and max). A repeated identical error folds into one line with a count and its first and last times. `debug` is off outside dev. Each project records its measured lines a day when it adopts the module (#19) and adds its streams to the table in (a). A project whose measured figure would take any total over half asks Shyden before it ships.

### c. Storage and retention

A batch is compressed on its own, so the budget uses the ratio measured at its size, not one over a whole day. Measured on 2026-10-23 (seed 18, lines in this format averaging 241 bytes, gzip level 6, each batch compressed alone):

| Lines per batch | 5 | 20 | 100 | 500 | 2,000 | 10,000 |
| --- | --- | --- | --- | --- | --- | --- |
| Median ratio | 3.48x | 5.37x | 7.22x | 8.15x | 8.40x | 8.48x |
| Lowest ratio | 2.85x | 5.13x | 7.07x | 8.10x | 8.37x | 8.44x |

At the ceiling a flush holds about 1,000,000 ÷ 3,456 ≈ 289 lines, so the budget uses 7.07x, the lowest ratio measured at 100 lines. The sample's values were random, and real lines repeat more, so real ratios are likely higher. Each project records its real ratio at adoption (#19).

| Bucket | Compressed per day | Retention | Stored |
| --- | --- | --- | --- |
| `shyden-logs-prod` | 500 MB ÷ 7.07 = 70.7 MB | 30 days | 2.12 GB |
| `shyden-logs-dev` | 500 MB ÷ 7.07 = 70.7 MB | 7 days | 0.50 GB |
| Both | | | 2.62 GB of 10 GB: 26% |

### d. Viewer reads

Every search is bounded by bucket, project and day prefix. The browser decompresses objects with `DecompressionStream("gzip")`, "Widely available" since May 2023 [S23], so the viewer Worker only lists and streams (a free Worker has "10 ms" of CPU [S9]). The viewer's share is 100,000 Class A lists and 4,000,000 Class B reads a month. It shows the month's reads so far and says when a search was cut short.

| Allowance (per month) | Use (computed) | Share |
| --- | --- | --- |
| Class A, 1,000,000 | Flushes 6,912 × 30 = 207,360; viewer lists at most 100,000; daily checks about 900 | 31% |
| Class B, 10,000,000 | Viewer reads at most 4,000,000; daily checks 60 | 40% |

### e. Budget watch

The daily scheduled run reads R2, Workers and Durable Object usage from Cloudflare's GraphQL Analytics API and opens an issue for ShydenMcM at 50% and at 80% of any free allowance above. Which datasets a free account can read is not published per plan ("Higher plans have access to a greater selection of datasets or fields" [S24]), so the run first asks the API's `settings` node, which "shows whether the node is available for a requester or not" [S24], and fails, naming the dataset, if one it needs is missing. The API allows "300 GraphQL queries over 5-minute window" [S24]; the run makes a handful. Over budget, the collector drops `debug` lines first, then routine summaries, never an error or a warning, and counts every drop in the next summary.

### At 10x

Ten times the ceiling is 5 GB a day per environment. Flushes double, because a window then holds about 2,894 lines, more than the 2,000-line cap: 13,824 a day, 414,720 Class A writes a month, still under the free million. Stored at 7.07x: 21.2 GB prod and 4.95 GB dev, 26.2 GB, which is 16.2 GB over the free 10 GB at "$0.015 / GB-month" [S6], about $0.24 a month. Sends rise past the free Durable Object writes, which needs Workers Paid at "$5 USD per month" [S13], whose writes include "First 50 million / month" [S12]. In all, about $5.24 a month. At that volume the apps' own requests would likely need Workers Paid anyway.

## Sources

| Tag | Source | Read |
| --- | --- | --- |
| S1 | axiom.co/pricing; axiom.co/docs/reference/limits; axiom.co/docs/restapi/endpoints/ingestToDataset | 2026-10-16, 2026-10-23 |
| S2 | github.com/axiomhq/axiom-cloudflare-workers (licence) | 2026-10-23 |
| S3 | grafana.com/pricing; Grafana Cloud regions | 2026-10-23 |
| S4 | grafana.com/docs/loki/latest/reference/loki-http-api/ | 2026-10-23 |
| S5 | newrelic.com/pricing | 2026-10-23 |
| S6 | developers.cloudflare.com/r2/pricing/ | 2026-10-23 |
| S7 | developers.cloudflare.com/r2/reference/data-location/; R2 object lifecycles; R2 limits | 2026-10-23 |
| S8 | developers.cloudflare.com/workers/observability/logs/workers-logs/ | 2026-10-23 |
| S9 | developers.cloudflare.com/workers/platform/limits/ | 2026-10-23 |
| S10 | developers.cloudflare.com/pages/functions/pricing/ | 2026-10-23 |
| S11 | developers.cloudflare.com/workers/platform/pricing/ (Service bindings) | 2026-10-23 |
| S12 | developers.cloudflare.com/durable-objects/platform/pricing/ | 2026-10-23 |
| S13 | developers.cloudflare.com/workers/platform/pricing/ (Workers Paid) | 2026-10-23 |
| S14 | docs.cloud.google.com/free/docs/free-cloud-features | 2026-10-16, 2026-10-23 |
| S15 | oracle.com/cloud/free/faq | 2026-10-16 |
| S16 | VictoriaLogs documentation and repository | 2026-10-23 |
| S17 | betterstack.com/pricing | 2026-10-23 |
| S18 | launchdarkly.com/pricing | 2026-10-23 |
| S19 | The Loki, OpenObserve and Quickwit repositories and documentation | 2026-10-23 |
| S20 | developers.cloudflare.com/d1/platform/pricing/; Analytics Engine pricing | 2026-10-23 |
| S21 | UU 27/2022, Pasal 56, official copy at peraturan.go.id, page 24 | 2026-10-23 |
| S22 | www.cloudflare.com/sase/products/access/ | 2026-10-23 |
| S23 | developer.mozilla.org, `DecompressionStream` | 2026-10-23 |
| S24 | developers.cloudflare.com/analytics/graphql-api/limits/ and its `settings` page | 2026-10-23 |
