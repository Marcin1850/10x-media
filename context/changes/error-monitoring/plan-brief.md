# Error Monitoring (Sentry) — Plan Brief

> Full plan: `context/changes/error-monitoring/plan.md`
> Roadmap slice: `context/foundation/roadmap.md` §S-13 · Linear: MAR-24

## What & Why

The app's operationally important events already flow through one deliberate seam that has never had a
receiver — S-09's decision **D5b** built the seam and explicitly deferred the tool. This change lands
Sentry as that receiver, on both the Worker and the browser, so the two conditions this project has
repeatedly deferred to "we'll notice eventually" — a budget threshold crossed, and a generation whose
credit outcome the app could not determine — become things the operator is told about while they still
matter, rather than discovered from a user complaint.

## Starting Point

`src/lib/services/reporting.ts` exposes one function, `reportEvent(key, severity, payload)`, fed by two
families: the budget thresholds (`stop` / `warn` / `untracked`, emitted from the Worker) and the
unsupported-feature notice (emitted from a hydrated React island, so today it reaches only the user's own
browser console). Around it sit ~50 further `console.error` sites, almost none of which throw — this
codebase resolves failures into outcomes rather than exceptions. Three environment guards already exist
and this plan leans on all of them: the integration suite's non-loopback `fetch` firewall, the committed
`.dev.vars.e2e` that replaces `.dev.vars` wholesale, and the build-time proof pattern that keeps the fake
summarizer out of production.

## Desired End State

An incident, a budget crossing, or an ambiguous charge arrives as a notification with enough in it to act
on — for the ambiguous case, the exact ledger row to reconcile. Locally, in CI, in the integration suite
and in an e2e run, nothing is sent at all, guaranteed by the absence of a DSN rather than by a runtime
flag. Recurring conditions collapse into one issue each, so the alert set stays small enough to keep
being trusted.

## Key Decisions Made

| Decision                | Choice                                                                       | Why (1 sentence)                                                                                                              | Source   |
| ----------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------- |
| Receiver                | Sentry                                                                       | D5b already priced and rejected the alternatives (Workers Logs and an operator script are pull-only; the webhook was dropped for this). | Roadmap  |
| Transport scope         | Two — Worker **and** browser                                                 | The unsupported-feature family is emitted from an island, and server-only reporting would leave it invisible exactly as its own code comment warns. | Plan     |
| Personal data           | Route the **reconciliation family** — `[charge-ambiguous:*]`, `[credit-leak:*]`, `[replay-read:*]` — with `userId` + `requestId`, as a named exception | Each is only actionable because it names the row an operator has to go and fix; the seam's no-identifiers contract is amended rather than contradicted, and a payload field-set test stops the exception spreading. | Plan     |
| Severity routing        | Every seam severity alerts                                                   | Nothing the seam emits should have to be discovered by checking a dashboard.                                                  | Plan     |
| Noise control           | Sentry-side `fingerprint` + first-seen/regression alert rules                 | Every event still reaches the dashboard, but one ongoing condition produces one notification — and no app code owns throttling state, which Workers isolates cannot share anyway. | Plan     |
| Promotion set           | A roster, not a rule of thumb: paid-path integrity, credit leaks, the fail-open replay read, cache/ledger/lock, plus automatic unhandled | These are the failures that cost money or degrade silently; every remaining console site is named in §Promotion Roster with the reason it stays on the console, so nothing is left to the implementer's guess. | Plan     |
| DSN isolation           | Optional `astro:env` keys, absent everywhere but production                  | Matches how all five current secrets work, and fails closed by absence rather than by a flag someone must remember to set.     | Plan     |
| Data collection         | Disable `userInfo`, cookies, HTTP bodies, GenAI; keep headers and query params | The SDK's `dataCollection` defaults are permissive, and this app's cookies are Supabase session tokens.                        | Plan     |
| Tier & sampling         | Free tier, no sampling, `tracesSampleRate: 0`                                | A single-operator MVP should produce a handful of events a week; tracing is out of scope and costs both quota and bundle size. | Plan     |
| Sentry MCP              | Installed at user scope, not committed to `.mcp.json`                        | Keeps the org and project slugs out of a public repo while still honouring the change note's ask.                              | Plan     |
| Verification            | Unit tests on the seam contract, promotion assertions on every promoted site, and **two** deliberate live events — one per runtime | The code contract is cheap to test, and promotion without an oracle would pass just as green if every call were deleted; the account wiring is only provable live, and the two runtimes initialise independently so one event proves only one of them. | Plan     |

## Scope

**In scope:** both DSNs as optional env values; `@sentry/astro` registered as the single owner of both
runtimes, which wraps the Cloudflare entrypoint itself (`wrangler.jsonc` is deliberately untouched);
server and client init files; seam forwarding with a runtime split and per-condition fingerprints;
promotion of the reconciliation, paid-path, cache, ledger and lock sites; Sentry-side alert rules and spend cap; a live verification
record; README/CLAUDE.md/AGENTS.md and tracker updates; a local Sentry MCP install documented in the
change folder.

**Out of scope:** uptime/synthetic monitoring; performance tracing, replay, RUM, profiling; duplicating
S-07's per-summary cost ledger; any user-facing status surface; alerting on product metrics; promoting
the read-path console sites; committing the MCP entry; changing any event's key, payload or wording.

## Architecture / Approach

One seam, two sinks, and a split between logging and forwarding. `captureEvent` is sink-only — it is what
the promoted sites call after their existing `console.*` line, so console output does not double — and
`reportEvent` keeps its signature, its console output, and then calls `captureEvent`. The sink is chosen
between a Worker module (`@sentry/cloudflare`) and a browser module (`@sentry/astro`) via
`import.meta.env.SSR`, which Vite replaces with a literal per bundle, so the Worker SDK is tree-shaken out
of the client build entirely. Each sink module carries its own literal sentinel, and the purity proof
greps for that sentinel in **both** directions — absent from the client assets, present in the server
bundle — because Rollup rewrites package specifiers, so an absence-only grep for a package name proves
nothing. That is the same shape as this repo's existing proof that the fake summarizer cannot ship, which
greps `E2E_FAKE_SUMMARIZER` rather than a module path. The DSN never enters the seam — it is supplied by
the two initialisation sites, which keeps the module reachable from the unit test project — and the sink
itself is swappable through one named `setReportingSink` seam, which is what both the contract tests and
the promotion tests drive. Forwarding is fire-and-forget and swallows its own failure, because
the seam sits immediately before the first paid vendor call in a request whose whole design is that a
user is never charged for work they did not receive.

## Phases at a Glance

| Phase                                        | What it delivers                                                        | Key risk                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. Project, env plumbing, MCP                | Sentry project with a spend cap; both DSNs declared optional; MCP local  | Forgetting the spend cap — a looping bug can burn a free quota in an hour                      |
| 2. Server transport                          | `@sentry/astro` registered for both runtimes; injected server config with data collection locked down | The Worker secret must be **observed** reaching the injected config in a real workerd boot — assuming it does is how Phase 6 fails silently |
| 3. Route the seam                            | Both runtimes forwarding; unit tests for the never-throws contract       | A static SDK import defeats the tree-shake and lands the Worker SDK in the client bundle        |
| 4. Promote the money events                  | The reconciliation family (ambiguous charge, credit leak, replay read) + five paid-path sites | The identifier exception must be documented and test-enforced, not just implemented |
| 5. Promote the degradation events            | Cache, ledger and lock failures, fingerprinted per condition             | ~22 sites — the phase most likely to produce noise; a key per *module* rather than per *condition* silently merges issues |
| 6. Turn it on: calibration, live proof, docs | Production secrets, alert rules, a recorded live pass, docs and trackers | The live half is manual and unrepeatable; without the written record it has no lasting value    |

**Prerequisites:** S-09 and S-06 are done and live (they built the seam and the second event family). A
Sentry account. Nothing else blocks — phases 1–3 are safe to merge before production is wired.

**Estimated effort:** ~3–4 sessions across six phases; phases 1–3 are the bulk, 4–5 are mechanical, 6 is
mostly operator work in the Sentry UI.

## Open Risks & Assumptions

- **Alerting on `warn` too runs against the roadmap's own calibration warning.** `reportNearMiss` fires
  roughly once per reading TTL for as long as the budget sits above the threshold. The whole defence is
  the Phase 3 fingerprint plus the Phase 6 first-seen/regression rule; if either is wrong, one slow month
  becomes a stream of notifications and the receiver starts teaching you to ignore it.
- **The alert calibration lives in the Sentry UI, not in git.** It is not code-reviewed and would have to
  be re-created by hand if the project were ever recreated.
- **A missing DSN is silent by design.** A production deploy that forgets the Worker secret reports
  nothing and looks identical to a healthy one — hence the deliberate live event in Phase 6.
- **The integration owns both runtimes, so there is exactly one initialisation path — by choice.** The
  rejected alternative was a hand-written `withSentry` entrypoint alongside it, which double-wraps the
  handler and lets the build-time public DSN switch on server reporting independently of the Worker
  secret. The residual risk is the opposite one: the injected server config's `astro:env/server` read has
  to be observed working in workerd, which is a Phase 2 verification step rather than an assumption.
- **An e2e run could inherit a developer's `PUBLIC_SENTRY_DSN`.** `.dev.vars.e2e` governs Worker
  bindings, not the client *build*, and Playwright hands the parent environment to its `webServer`. A
  fail-closed config-load guard now refuses to start such a run — that guard is why this is a controlled
  risk rather than an open one.
- **The Phase 6 Worker smoke trigger is temporary code in production.** It is flag-guarded on an
  authenticated route and reverted in the following commit, with the revert re-verified against
  production — but it exists, briefly, and the record has to show it gone.
- **A public browser DSN is abusable** by third parties sending events against the quota. Mitigated by the
  spend cap, not eliminated.

## Success Criteria (Summary)

- A budget crossing, an ambiguous charge, or a paid-path failure in production reaches the operator as a
  notification carrying enough to act on — without anyone checking a dashboard.
- A recurring condition produces one notification, not one per event.
- A local dev run, a CI run, an integration run and an e2e run send nothing at all.
