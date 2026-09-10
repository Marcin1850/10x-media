# S-13 Phase 6 — live verification record

> Plan: `../plan.md` §Phase 6 (§4 smoke cases, §5 this record). Started 2026-09-10.
>
> **No account identifiers.** This is a real-environment pass against a public repository: accounts
> are described by role ("the operator's account"), never by email or UUID. Local checks used a
> throwaway synthetic account on the local stack, created for the check and deleted after it.

## Status

| Row | Check | Result |
| --- | --- | --- |
| 6.1 | All three CI jobs pass | _pending — observed on the push to `master` (user decision: no PR)_ |
| 6.2 | Build succeeds locally without either DSN | **pass** |
| 6.3 | No DSN in a non-deploy build's output | **pass** |
| 6.4 | Browser smoke event arrives under its own issue | _pending_ |
| 6.5 | Worker smoke event arrives; trigger gone afterwards | _pending_ |
| 6.6 | One notification per issue, not per event | _pending_ |
| 6.7 | Four negative checks recorded with observed results | integration, Worker, browser: **observed**; local dev: _pending (by hand)_ |
| 6.8 | No account identifiers in this record | _checked at close_ |
| 6.9 | Roadmap and Linear reflect the closed slice | _pending_ |

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

### Local dev — _pending_

`npm run dev` with no DSN set: the browser Network tab shows no Sentry request after a top-up click, and
a local generation logs its console lines with nothing sent.

## Production secrets (§1)

As of 2026-09-10, before the push: **neither exists.** GitHub repository secrets list `SUPABASE_URL`,
`SUPABASE_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; Worker secrets list the five app keys.
_Pending: `SENTRY_DSN` as a Worker secret, `PUBLIC_SENTRY_DSN` as a repository secret._

## Alert rule and spend cap (§3) — _pending_

## Smoke events (§4) — _pending_

### Browser (6.4)

- Action: signed in on production as the operator's account, clicked the top-up button
- Event id / issue:
- Notification:

### Worker (6.5)

- Trigger commit (sha):
- Fired: `GET /api/summaries?sentry-smoke=worker`, signed in as the operator's account
- Event id / issue:
- Notification:
- Revert commit (sha):
- Post-revert re-check against production:

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
