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
| Personal data           | Route `[charge-ambiguous]` **with** `userId` + `requestId`, as a named exception | The event is only actionable because it names the row to reconcile; the seam's no-identifiers contract is amended rather than contradicted. | Plan     |
| Severity routing        | Every seam severity alerts                                                   | Nothing the seam emits should have to be discovered by checking a dashboard.                                                  | Plan     |
| Noise control           | Sentry-side `fingerprint` + first-seen/regression alert rules                 | Every event still reaches the dashboard, but one ongoing condition produces one notification — and no app code owns throttling state, which Workers isolates cannot share anyway. | Plan     |
| Promotion set           | Paid-path integrity + cache/ledger/lock + automatic unhandled                | These are the failures that cost money or degrade silently; read-path and informational sites stay on the console.             | Plan     |
| DSN isolation           | Optional `astro:env` keys, absent everywhere but production                  | Matches how all five current secrets work, and fails closed by absence rather than by a flag someone must remember to set.     | Plan     |
| Data collection         | Disable `userInfo`, cookies, HTTP bodies, GenAI; keep headers and query params | The SDK's `dataCollection` defaults are permissive, and this app's cookies are Supabase session tokens.                        | Plan     |
| Tier & sampling         | Free tier, no sampling, `tracesSampleRate: 0`                                | A single-operator MVP should produce a handful of events a week; tracing is out of scope and costs both quota and bundle size. | Plan     |
| Sentry MCP              | Installed at user scope, not committed to `.mcp.json`                        | Keeps the org and project slugs out of a public repo while still honouring the change note's ask.                              | Plan     |
| Verification            | Unit tests on the seam contract + one deliberate live event                   | The code contract is cheap to test; the account wiring (DSN, grouping, alert rule) is only provable live.                      | Plan     |

## Scope

**In scope:** both DSNs as optional env values; `withSentry` around the Cloudflare entrypoint; browser
SDK init; seam forwarding with a runtime split and fingerprints; promotion of the ambiguous-charge,
paid-path, cache, ledger and lock sites; Sentry-side alert rules and spend cap; a live verification
record; README/CLAUDE.md/AGENTS.md and tracker updates; a local Sentry MCP install documented in the
change folder.

**Out of scope:** uptime/synthetic monitoring; performance tracing, replay, RUM, profiling; duplicating
S-07's per-summary cost ledger; any user-facing status surface; alerting on product metrics; promoting
the read-path console sites; committing the MCP entry; changing any event's key, payload or wording.

## Architecture / Approach

One seam, two sinks. `reportEvent` keeps its signature and its console output, then forwards to Sentry —
choosing between `@sentry/cloudflare` and the browser SDK via `import.meta.env.SSR`, which Vite replaces
with a literal per bundle, so the Worker SDK is tree-shaken out of the client build entirely (proved by
grepping the built assets, the same way this repo already proves the fake summarizer cannot ship). The
DSN never enters the seam — it is supplied by the two initialisation sites, which keeps the module
reachable from the unit test project. Forwarding is fire-and-forget and swallows its own failure, because
the seam sits immediately before the first paid vendor call in a request whose whole design is that a
user is never charged for work they did not receive.

## Phases at a Glance

| Phase                                        | What it delivers                                                        | Key risk                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1. Project, env plumbing, MCP                | Sentry project with a spend cap; both DSNs declared optional; MCP local  | Forgetting the spend cap — a looping bug can burn a free quota in an hour                      |
| 2. Server transport                          | `withSentry` around the Cloudflare entrypoint, data collection locked down | `wrangler.jsonc`'s `main` must land with its wrapper file or `dev`, `preview` and e2e all break |
| 3. Route the seam                            | Both runtimes forwarding; unit tests for the never-throws contract       | A static SDK import defeats the tree-shake and lands the Worker SDK in the client bundle        |
| 4. Promote the money events                  | Ambiguous charge (with identifiers) + five paid-path sites               | The identifier exception must be documented, not just implemented                              |
| 5. Promote the degradation events            | Cache, ledger and lock failures, fingerprinted per module                | ~20 sites — the phase most likely to produce noise if fingerprints are wrong                   |
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
- **`@sentry/astro`'s integration may try to contribute a Node-based server config**, which workerd cannot
  run. Phase 2 assumes it can be registered for its client role alone; if not, the client transport may
  need to be initialised without the integration.
- **A public browser DSN is abusable** by third parties sending events against the quota. Mitigated by the
  spend cap, not eliminated.

## Success Criteria (Summary)

- A budget crossing, an ambiguous charge, or a paid-path failure in production reaches the operator as a
  notification carrying enough to act on — without anyone checking a dashboard.
- A recurring condition produces one notification, not one per event.
- A local dev run, a CI run, an integration run and an e2e run send nothing at all.
