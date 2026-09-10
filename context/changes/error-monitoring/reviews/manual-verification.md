# S-13 Phase 6 — live verification record

> Plan: `../plan.md` §Phase 6 (§4 smoke cases, §5 this record). Started 2026-09-10.
>
> **No account identifiers.** This is a real-environment pass against a public repository: accounts
> are described by role ("the operator's account"), never by email or UUID. Local checks used a
> throwaway synthetic account on the local stack, created for the check and deleted after it.

## Status

| Row | Check | Result |
| --- | --- | --- |
| 6.1 | All three CI jobs pass | **pass** — on the `master` push of merge `f785450` (user decision: no PR), run `34475037695`: `ci`, `integration`, `e2e` and `deploy` all `success` |
| 6.2 | Build succeeds locally without either DSN | **pass** |
| 6.3 | No DSN in a non-deploy build's output | **pass** |
| 6.4 | Browser smoke event arrives under its own issue | **pass** — `10XMEDIA-2`, `SENTRY_BROWSER_SINK` |
| 6.5 | Worker smoke event arrives; trigger gone afterwards | **pass** — `10XMEDIA-3`, `SENTRY_WORKER_SINK`; reverted in `2661947`, re-checked live |
| 6.6 | One notification per issue, not per event | **pass** — two issues, three events, exactly two emails |
| 6.7 | Four negative checks recorded with observed results | **pass** — integration, Worker (two-sided), browser (e2e counter), local dev (by hand) |
| 6.8 | No account identifiers in this record | **pass** — swept at close over this file plus the lines this phase added to `plan.md` and `roadmap.md`: no emails, UUIDs, Sentry org slug or org/project ids, DSN key, IP values (only the local `127.0.0.1` stand-in), alert-rule ids, operator name, city or time-zone values, tokens or keys |
| 6.9 | Roadmap and Linear reflect the closed slice | **pass** — roadmap S-13 `done` in the At a glance row, the slice body and the Backlog Handoff row; Linear MAR-24 phase-6 comment posted and description corrected, state kept **In Progress** until `/10x-impl-review` (operator decision: Done means reviewed and merged). _Updated 2026-09-10 (impl-review F4): moved to **Done** at the end of review triage, with a review-verdict comment, by operator decision._ |

## Automated (local)

- **6.2** — `npm run build` with no DSN in `.env`, `.dev.vars` or the shell (checked by counting active
  `SENTRY_DSN` / `PUBLIC_SENTRY_DSN` lines: 0 in each). Exit 0.
- **6.3** — `grep -r "ingest.*sentry.io" dist/` on that build: no output. `dist/server/.dev.vars` carries
  no `SENTRY_DSN` line. Purity sentinel re-checked on the same build: `SENTRY_WORKER_SINK` found only in
  `dist/server/chunks/reporting-sink.server_*.mjs`, absent from `dist/client/_astro/`, and
  `SENTRY_BROWSER_SINK` present in `dist/client/_astro/reporting-sink.client.*.js`.
- **Re-run after every other local check**, so the output being judged is the one from the committed
  tree rather than from the e2e build or the smoke pre-flight: `npm run build`, exit 0. `ingest.*sentry.io`
  — no match; `E2E_FAKE_SUMMARIZER` — no match; `sentry-smoke` — 0 files (the temporary trigger is not in
  the tree); `SENTRY_DSN` lines in `dist/server/.dev.vars` — 0.

## Negative checks (6.7)

### Integration — observed

`npm run test:integration`: **9 files, 108 tests, all passed.** `src/test/fetch-firewall.ts` throws on
every non-loopback `fetch` in that project, so an escaping event would have been a failing test rather
than a silent one.

### Worker — observed, two-sided (replaces the plan's boot-log check)

**Deviation, user decision 2026-09-10.** The plan asked for the e2e `webServer` boot log to show
`worker.ts` declining to initialise. No such line can exist: `worker.ts` passes no `debug` option, so
with no DSN the SDK writes nothing. Recording that check would have been an absence of noticing, which
6.7 forbids. Replaced with a loopback stand-in for Sentry ingest (a local HTTP listener on
`127.0.0.1:9999` that records every request), observed in both directions against the same build.

Build: `CLOUDFLARE_ENV=e2e npm run build` with the §4 smoke trigger applied locally. That bakes
`.dev.vars.e2e` — the local stack's demo keys and the vendor non-credentials — into
`dist/server/.dev.vars`, so no real key was in play. Baked binding names: `SUPABASE_URL`,
`SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPADATA_API_KEY`, `OPENROUTER_API_KEY` (no `SENTRY_DSN`).

| Run | Binding | Requests to `/api/summaries` (signed in) | Envelopes at the listener |
| --- | --- | --- | --- |
| A | no `SENTRY_DSN` | 2 × `?sentry-smoke=worker`, both `200` | **0** |
| B | `SENTRY_DSN` → loopback listener, appended to the built `dist/server/.dev.vars` | 1 × plain → `200` | **0** |
| B | same | 1 × `?sentry-smoke=worker` → `200` | **1** |

Run A is the negative check: the trigger fired and nothing left the Worker. Run B proves that result
comes from the missing DSN rather than a broken trigger or transport — the same code, given a DSN, sends
exactly one envelope, and only when an event is emitted.

**Pre-flight finding, not in the plan.** The trigger emits its event at the *tail* of the request,
immediately before the response. That placement was deliberate: the Worker sink loads through a dynamic
`import()`, so a tail event is the one most likely to lose the race against `withSentry`'s end-of-request
flush. It did not lose it. The envelope recorded in run B:

- endpoint `POST /api/1/envelope/`, client `sentry.javascript.cloudflare/10.74.0`
- message `[smoke:worker] warn`, level `warning`, fingerprint `["[smoke:worker]","warn"]`
- tag `sink: SENTRY_WORKER_SINK`, environment `production`
- `contexts.report` = `{ key, severity, payload: { trigger } }`, the payload carried as context, not text
- data collection as decision D8 intends: no `request.cookies`, no `cookie` header, no `request.data`,
  no `user`. Header names sent: `accept`, `accept-encoding`, `accept-language`, `connection`, `host`,
  `sec-fetch-mode`, `user-agent`, `x-forwarded-host`

After the check, the synthetic account was deleted (admin lookup `404`), the preview and the listener
were stopped, and the orphaned `node.exe` that kept holding `:4321` after the first stop was killed by
PID (`lessons.md`, dev-server port rule).

### Browser — observed

`npm run test:e2e`, no DSN in the shell (the config-load guard would have refused otherwise): exit 0,
**5 passed** — both `charged-refusal` cases, `generate-summary`, and both `long-video-confirmation` cases.

The counter reached every one of the five, not just the spec that clicks: all three spec files import
`test` from `fixtures/test.ts`, which extends `accountTest` (`fixtures/account.ts`), which extends
`noSentryTest` (`fixtures/no-sentry.ts`), whose `sentryIngestGuard` is `auto: true`. That guard aborts and
counts every request to a `sentry.io` host on the browser context and throws after the test on a
non-zero count — so five passes are five observed counts of **0**, not five tests that happened not to
look. The seam was actually walked: `generate-summary.spec.ts:155` clicks the top-up menu item and
`:156` asserts the Polish notice, which is the `[unsupported-feature]` path the browser transport exists
for.

### Local dev — observed (by hand)

`npm run dev` with no DSN set — the tree carried no active `SENTRY_DSN` / `PUBLIC_SENTRY_DSN` line in `.env`
or `.dev.vars` (checked at the start of the phase). The operator signed in locally, opened DevTools →
Network filtered on `sentry`, and clicked the top-up button: the notice appeared and **no request to a
`sentry.io` host** was made (operator-reported). The dev server was stopped afterwards and `:4321`
re-checked, per the dev-server port rule.

## Production secrets (§1)

As of 2026-09-10, before the push: **neither exists.** GitHub repository secrets list `SUPABASE_URL`,
`SUPABASE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; Worker secrets list the five app keys.
Set by the operator the same day, then confirmed **by name only** (no value was read back):
`gh secret list` now includes `PUBLIC_SENTRY_DSN`, and `npx wrangler secret list` now includes
`SENTRY_DSN`. The `ci`, `integration` and `e2e` jobs still set neither (`ci.yml` parsed: `SENTRY`
appears only in the `deploy` job's build env).

## Alert rule and spend cap (§3)

**Baseline, read through the Sentry MCP before any production event (2026-09-10):**

- Unresolved issues in the project over the last 7 days: **none**. Any issue that appears during the smoke
  cases is therefore new, not a pre-existing one being re-counted.
- Issue alert rules: **one**, Sentry's project-creation default, "Send a notification for high priority
  issues" — enabled, never triggered. Metric alert rules: none.

**Finding: the default rule does not implement decision D3.** Its triggers are "new *high priority*
issue" and "existing issue escalates to *high priority*", with an email action. It has no regression
trigger, and priority is Sentry's own judgement per issue — `warning`-level message events such as
`[supadata-budget] warn` and both `[smoke:*]` events are not expected to be rated high. Left as-is, those
issues would reach the dashboard and notify nobody, which is exactly the "discovered by checking a
dashboard" outcome this slice exists to remove, and 6.6 could not be observed at all.

Required shape (§3): trigger on **a new issue being created** OR **an issue changing from resolved to
unresolved** (regression), with no priority or level filter, and a notification action. Per-event
triggers stay off, so a recurring condition accumulates on its fingerprinted issue without notifying
again.

**After the operator's edit (2026-09-10), re-read through the MCP, not taken on report:**

- A new issue alert rule, enabled: triggers **"first seen event" OR "regression event"** (any-match), **no
  filters**, one action — an email to the operator's own user. Matches the required shape.
- The project-creation default rule is now **disabled**, so the priority-gated trigger cannot fire alongside
  it and double-notify on a high-priority issue.
- Neither rule has triggered yet (`lastTriggered: null`), so the smoke cases below are the rule's first
  firing — which is what makes 6.6 observable.

Spend cap: **confirmed by the operator** (2026-09-10) — the client-key rate limit and the pay-as-you-go
budget both checked in the Sentry UI before the trigger was pushed. Operator-reported, not machine-read:
the project has a single client key, so both DSNs are the same key, and the MCP lists that key but does
not expose its rate limit.

## Smoke events (§4)

### Browser (6.4)

- Action: signed in on production as the operator's account, clicked the top-up button once
  (2026-09-10, against the `f785450` deploy)
- Event id / issue: event `cd7de4ff17d743749be0bf8aa6b867ad`, issue `10XMEDIA-2` — the only issue first
  seen in the project that day, so a new issue and not a re-count. Read back through the MCP:
  - title `[unsupported-feature] warn`, level `warning`, 1 occurrence, environment `production`
  - tag `sink: SENTRY_BROWSER_SINK`, SDK `sentry.javascript.astro` — the browser transport, not the Worker's
  - `contexts.report` = `{ key: "[unsupported-feature]", severity: "warn", payload: { feature: "top-up" } }`
    — payload carried as context, message text is key and severity only
  - no cookies, no request body, no user id or email on the event (`user.id`, `user.email`, `user.ip`
    queried explicitly: all empty; "users impacted" 0)
  - breadcrumbs, 3: two `ui.click` entries carrying only the clicked elements' CSS selectors, and one
    `console` warning — the seam's own `[unsupported-feature] {"feature":"top-up"}` line. No URLs with
    query strings, no input values, no page text
  - this event also proves `PUBLIC_SENTRY_DSN` was inlined by the `deploy` job's build: the browser has
    no other way to know where to send it
- Notification: the issue alert rule's `lastTriggered` moved from `null` to 14 s after the issue's first
  seen — the rule fired on first seen. _Pending: operator confirms the email arrived._

**Finding (data collection):** the event carries a `user.geo` (country and city) that Sentry derives
**server-side from the client IP** at ingestion. `dataCollection.userInfo: false` stops the SDK from
populating user fields, but it cannot stop the server from resolving the connecting IP. Values are
deliberately not recorded here. Closing it would be a Sentry project setting ("Prevent Storing of IP
Addresses"), not code. **Operator decision (2026-09-10): left as-is, deliberately.**

**6.6, first attempt — inconclusive, and why.** The operator confirmed **exactly one** email for the issue.
A second top-up click in the same page session then produced **no second event**: the issue stayed at 1
occurrence, the rule's `lastTriggered` did not move, and a repeat `search_events` a minute later still
found one event, so this was not indexing lag. The component is not the cause —
`TopUpAction.tsx:17-21` reports on every click, unconditionally.

**Finding (event counts): the SDKs' default `Dedupe` integration drops repeats of one condition.**
`@sentry/core`'s `dedupeIntegration` drops an event when the *immediately previous* event from the same
client has the same message, the same fingerprint and the same stack trace (`integrations/dedupe.js`,
`_isSameMessageEvent`). This seam's design makes every repeat of a condition exactly that: message
`key severity`, fingerprint `[key, severity]`, no stack trace. Both SDKs enable it by default —
`@sentry/browser` `sdk.js` lists `dedupeIntegration()`, and `@sentry/cloudflare` `sdk.js` includes it
unless `enableDedupe: false` — and neither `sentry.client.config.ts` (which filters only Replay,
BrowserTracing and Feedback) nor `worker.ts` turns it off. What it costs differs by runtime:

- **Browser:** one client per page load, so a repeated condition is sent **once per page session**. The
  issue's event count reads as "page sessions in which it happened", not "times it happened".
- **Worker:** `@sentry/cloudflare` `request.js` calls `init()` per request, so every request gets a fresh
  client and a fresh `Dedupe`. Repeats **across** requests are all sent — the budget near-miss that
  re-fires per reading keeps counting. Only an identical repeat **inside one request** is dropped.

Alerting is unaffected: the notification is per issue, and the first event of an issue is never a
duplicate. What it contradicts is plan decision D3's "every event is still sent, so the dashboard shows the
full stream" — true for the Worker across requests, not for the browser. **Operator decision
(2026-09-10): accepted and documented, no code change.** The only browser family is
`[unsupported-feature]`, whose repeat count within one page session carries no operational meaning. 6.6 is
re-run after a page reload, which starts a new client.

### Worker (6.5)

- Trigger commit (sha): `23d68ad`, pushed to `master` as the commit immediately after merge `f785450`;
  CI run `34476690211` — `ci`, `integration`, `e2e` and `deploy` all `success`. The same code passed the
  local two-sided loopback check above before it was pushed.
- Fired: `GET /api/summaries?sentry-smoke=worker`, once, signed in as the operator's account
  (2026-09-10, against the `23d68ad` deploy)
- Event id / issue: event `453b1521baf841348e02b1761f2782b3`, issue `10XMEDIA-3` — its own issue, first
  seen at the firing, separate from the browser's `10XMEDIA-2`. Read back through the MCP:
  - title `[smoke:worker] warn`, level `warning`, 1 occurrence, environment `production`
  - tag `sink: SENTRY_WORKER_SINK`, SDK `sentry.javascript.cloudflare`, runtime `cloudflare` — the Worker
    transport, which proves the production `SENTRY_DSN` Worker secret reaches `worker.ts` at runtime
  - `contexts.report` = `{ key: "[smoke:worker]", severity: "warn", payload: { trigger: "s13-phase-6" } }`
  - request recorded as method and URL only: no cookies, no headers, no body
  - delivered although it was emitted at the very tail of the request, matching the local pre-flight
- Notification: the rule's `lastTriggered` moved to 14 s after this issue's first seen — the rule fired on
  first seen. _Email count: pending operator confirmation (6.6 below)._
- Revert commit (sha): `2661947` — reverts `23d68ad` alone, the immediately following commit on `master`;
  CI run `34478715666` — `ci`, `integration`, `e2e` and `deploy` all `success`
- Post-revert re-check against production: baseline read through the MCP after `2661947` deployed and
  **before** the flag URL was re-opened — `10XMEDIA-3` at **1 occurrence**, last seen at the original
  firing. The operator then re-opened `GET /api/summaries?sentry-smoke=worker` once, signed in, against
  the `2661947` deploy. Re-read afterwards: `10XMEDIA-3` still **1 occurrence**, last seen still the
  original firing, no new issue. The trigger is gone from production — re-checked, not assumed.

**Finding (Worker events): "users impacted" and `user.ip` describe Cloudflare, not the user.** The Worker
event carries a `user.ip` inside Cloudflare's own address range, with a matching non-local geo — the
address Sentry saw the envelope arrive from, which is the Worker's egress, not the operator's browser. So
every Worker-emitted issue will show "users impacted: 1" (or more, across egress addresses), and the figure
means nothing; the payload, not that field, is where an event says anything about an account. The event
also carries the client's time zone (`culture.timezone`), apparently from Cloudflare's per-request data —
coarse, and no identifier. Recorded without values. Not a code change: no account identifier travels.

### 6.6 — one notification per issue, not per event

- Second attempt, after a page reload (a new browser client, so `Dedupe` cannot drop it): event 2 on
  `10XMEDIA-2` arrived at 12:39:33, taking the issue to **2 occurrences** on the same issue.
- The rule's `lastTriggered` only records the latest firing — which by the time of the read was the
  `10XMEDIA-3` first seen — so it cannot by itself prove the second `10XMEDIA-2` event did *not* notify.
  The operator's inbox is the authority: **exactly two Sentry emails in total** — one for `10XMEDIA-2`'s first
  seen, one for `10XMEDIA-3`'s — and none for `10XMEDIA-2`'s second event (operator-reported). Two issues,
  three events, two notifications: one per issue, not one per event.

## Deviations from the plan

1. **Worker negative check** — replaced by the two-sided loopback check above (user decision).
2. **No PR** — the change merges to `master` directly (user decision), so 6.1's three CI jobs are
   observed on the `master` push run that also gates the deploy, not on a PR.
3. **Rollback is two steps, not one.** The plan's Migration Notes say rollback is unsetting the Worker
   secret. That stops the Worker only: `PUBLIC_SENTRY_DSN` is baked into the deployed browser bundle, so
   the browser keeps reporting until the repository secret is deleted **and** a deploy runs. README
   §Error monitoring documents both steps.
4. **Client asset path.** Plan Phase 3's purity criterion names `dist/_astro/`; with adapter v13 the
   client assets are under `dist/client/_astro/`. The check above uses the real path.
