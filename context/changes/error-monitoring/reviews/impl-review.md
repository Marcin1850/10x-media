<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Error Monitoring (Sentry)

- **Plan**: `context/changes/error-monitoring/plan.md`
- **Scope**: All completed phases (1–6 of 6; 55/55 Progress items checked)
- **Date**: 2026-09-10
- **Verdict**: REJECTED
- **Findings**: 1 critical, 4 warnings, 2 observations
- **Git scope**: `687b0bf^..dfb03b1` (42 changed files)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | FAIL |

## Findings

### F1 — Worker request-data lockdown does not protect Sentry events

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `worker.ts:65`
- **Detail**: The configuration claims that `httpBodies: []`, header deny lists and query-parameter deny lists prevent sensitive request data from reaching Sentry. A runtime probe against the installed `@sentry/cloudflare@10.74.0`, using the same configuration, produced an event envelope containing the full POST body, `Authorization` header, raw query string and full URL with query parameters. The SDK source confirms the mechanism: the default `HttpServer` integration captures request bodies up to 10 KB (`medium`), while `RequestData` always attaches already-captured body data and treats the data-collection header/query values as include switches for events rather than applying the configured deny lists. This creates concrete credential exposure paths: sign-in/sign-up bodies carry email and password (`src/pages/api/auth/signin.ts:7`, `signup.ts:7`), the auth callback URL carries its code (`src/pages/auth/callback.ts:8`), account deletion carries the confirmation email, and promoted generation events can carry the complete submitted body. The existing promotion tests inspect only `contexts.report.payload`, so all automated gates pass while the surrounding request leaks. The supposedly exhaustive `dataCollection` object also omits `graphQL`, `stackFrameVariables` and `frameContextLines`, which would inherit permissive values if those integrations become active.
- **Fix**: Replace the default Worker `HttpServer` and `RequestData` integrations with explicit privacy-preserving instances (`maxRequestBodySize: "none"`; request data/body/headers/query/cookies/IP disabled), retain only a query-stripped URL if needed, and add a `beforeSend` scrubber that removes `request.data`, headers, query string and the query/hash from `request.url`. Add an SDK-envelope regression test containing sentinel password, authorization, callback-code and body values and assert that none occurs anywhere in the serialized envelope.
  - Strength: Closes the demonstrated leak at capture time and again immediately before transport, and tests the real SDK boundary rather than only the app-owned payload.
  - Tradeoff: Removes some automatic HTTP context from Worker events and adds a version-sensitive integration test.
  - Confidence: HIGH — reproduced against the exact installed SDK and corroborated by its shipped `httpServer` and `requestData` implementations.
  - Blind spot: The browser SDK needs a separate envelope-level privacy probe; the demonstrated exploit is the Worker path.
- **Decision**: PENDING

### F2 — Source-map upload is off in production but can run during local e2e

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `astro.config.mjs:89`, `.github/workflows/ci.yml:172`, `playwright.config.ts:63`
- **Detail**: Source-map upload is enabled only when `SENTRY_AUTH_TOKEN` exists, with `SENTRY_ORG` and `SENTRY_PROJECT` read alongside it. The production deploy build passes none of those three values, so source-map upload is always disabled and production stack traces remain minified. Conversely, `npm run test:e2e` loads `.env`, but its fail-closed guard and child-env pinning cover only the two DSNs. A developer `.env` containing the source-map credentials can therefore upload an e2e build to Sentry despite the plan's no-outbound guarantee outside production.
- **Fix**: Pass `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` only to the deploy build, enable upload only when the complete tuple and `PUBLIC_SENTRY_DSN` are present, and extend the e2e guard/pinning at least to `SENTRY_AUTH_TOKEN` (preferably the full tuple).
  - Strength: Makes production diagnostics usable while preserving a fail-closed non-production boundary.
  - Tradeoff: Adds three deployment settings and requires maintaining their repository-secret configuration.
  - Confidence: HIGH — the config reads the values, the deploy job does not supply them, and the e2e guard enumerates only the DSNs.
  - Blind spot: The review did not inspect the Sentry project's source-map releases because no current build can upload one.
- **Decision**: PENDING

### F3 — `reportEvent` can still throw while serializing a payload

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/reporting.ts:177`
- **Detail**: `JSON.stringify(payload)` executes outside the transport `try/catch`. Because the public parameter is `unknown`, a circular object, `bigint`, or throwing `toJSON` propagates synchronously, contradicting the seam's stated never-throws contract. Current call sites use plain serializable objects, so this is a contract hole rather than a currently observed paid-path failure.
- **Fix**: Use a never-throwing serializer/fallback for the console message and add circular-object and `bigint` contract cases.
- **Decision**: PENDING

### F4 — Linear MAR-24 is still In Progress although Progress 6.9 says closed

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `context/changes/error-monitoring/reviews/manual-verification.md:21`
- **Detail**: The roadmap records S-13 as `done`, but the verification record says MAR-24 intentionally remains **In Progress** until `/10x-impl-review`. Nevertheless, Progress 6.9 and the record's status table mark “Roadmap and Linear reflect the closed slice” as passed. At review completion, the external tracker is therefore the one remaining unchecked outcome hidden behind a checked box.
- **Fix**: Move MAR-24 to Done/Reviewed and post the implementation-review verdict; then correct the 6.9 evidence so the recorded state matches the tracker.
- **Decision**: PENDING

### F5 — Browser deduplication contradicts the plan's full-stream contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `context/changes/error-monitoring/plan.md:521`, `sentry.client.config.ts:42`
- **Detail**: The plan and reporting seam state that every event is sent so the dashboard shows the full stream. The browser keeps Sentry's default `Dedupe` integration; live verification proved that a second identical top-up event in the same page session was discarded (`manual-verification.md:178`). The operator explicitly accepted this because the only browser family is an unsupported-feature click, but the accepted behavior was recorded only in the live report and never amended into the plan, plan brief or seam contract.
- **Fix A ⭐ Recommended**: Amend the plan, plan brief and reporting contract to state that browser-identical repeats may be deduplicated within one page session, preserving the operator's recorded decision.
  - Strength: Matches the observed and accepted operational requirement without increasing noise or quota use.
  - Tradeoff: Browser occurrence counts remain session-level approximations rather than exact click counts.
  - Confidence: HIGH — the live record proves the behavior and explains why it is acceptable for the current browser event family.
  - Blind spot: A future browser event family may need exact counts and would have to revisit this exception.
- **Fix B**: Disable `Dedupe` in the browser (and `enableDedupe` in the Worker if literal cross-runtime symmetry is required).
  - Strength: Restores the plan's literal every-event/full-stream contract.
  - Tradeoff: Increases event volume and can make repeated client failures noisier without changing first-seen/regression notifications.
  - Confidence: HIGH — the installed SDK exposes the integration and the live record identifies it as the cause.
  - Blind spot: Event-volume impact has not been measured with production usage.
- **Decision**: PENDING

### F6 — Accepted Phase 6 evidence changes were not amended into the plan

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/changes/error-monitoring/plan.md:892`, `context/changes/error-monitoring/plan.md:936`
- **Detail**: Three Phase 6 deviations are explicit and reasonable in the live record but absent from the plan's amendments: CI was observed on a direct master push rather than “on the PR”; the impossible no-debug Worker boot-log check was replaced with a stronger two-sided loopback-ingest probe; and README correctly documents a two-step rollback (Worker secret plus client build secret/redeploy) instead of the plan's Worker-only rollback. These are evidence/source-of-truth drift, not implementation defects.
- **Fix**: Add a Phase 6 amendment summarizing the three accepted substitutions and propagate it to `plan-brief.md` where applicable.
- **Decision**: PENDING

### F7 — Completed verification still carries stale “pending” and ownership wording

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `context/changes/error-monitoring/reviews/manual-verification.md:115`, `context/changes/error-monitoring/reviews/manual-verification.md:150`, `astro.config.mjs:149`
- **Detail**: The completed manual record still labels the alert/spend-cap and smoke sections `_pending_`, while `astro.config.mjs` says the server DSN is read by an “injected server config” even though the amended architecture assigns it to the hand-written `worker.ts` wrapper. The evidence and runtime wiring below those labels are otherwise complete.
- **Fix**: Remove the two `_pending_` suffixes and change “injected server config” to “Worker entry wrapper”.
- **Decision**: PENDING

## Automated Verification Evidence

Repeated phase commands were deduplicated and run once against the reviewed `HEAD` (`dfb03b1`). The first sandboxed attempts of Astro/Vitest/Wrangler failed before project execution because Windows profile/config paths were denied; the same commands were then rerun successfully outside that sandbox through their native `.cmd` launchers.

| Plan checks | Command / probe | Result |
|-------------|-----------------|--------|
| 1.1, 2.1, 3.1, 4.1, 5.1 | `npm.cmd run typecheck` | PASS — exit 0 |
| 1.2, 2.2 | `npm.cmd run typecheck:astro` | PASS — 132 files, 0 errors, 0 warnings, 8 hints |
| 1.3, 2.3, 3.2, 4.2, 5.2 | `npm.cmd run lint` | PASS — exit 0 (existing Astro parser notices only) |
| 2.5, 3.3, 4.3, 5.3 | `npm.cmd test` | PASS — 15 files, 218 tests |
| 2.6, 3.6, 4.4, 5.5 | `npm.cmd run test:integration` | PASS — 9 files, 108 tests; local Supabase boundary exercised |
| 2.7, 3.7 | `npm.cmd run test:e2e` | PASS — 5 Chromium tests in 1.1 min; runner-owned build/preview; port 4321 free before and after |
| 1.4, 2.4, 3.4, 4.6, 5.6, 6.2 | `npm.cmd run build` | PASS — no Sentry env values in the process; server build completed |
| 1.5, 6.3 | Search built output for `ingest.*sentry.io` | PASS — 0 matching files |
| 1.6 | Run e2e config once with each DSN set | PASS — each exited non-zero at config load before build |
| 2.8 | `npm.cmd ls @sentry/astro @sentry/cloudflare` | PASS — both resolve to 10.74.0; installed types expose `dataCollection` |
| 2.9 | `npx.cmd wrangler deploy --dry-run` | PASS — 48 modules bundled; dry run exited without deploy |
| 3.5 | Search built client/server output for owned sink sentinels | PASS — Worker sentinel client 0/server 1; browser sentinel client 1/server 0 |
| 4.5 | Deliberate deletion check | NOT RE-RUN — would mutate reviewed code; completion is recorded at `f2e9800`, and each promoted family has a direct recorder assertion |
| 5.4 | Payload field-set and withheld-value assertions | PASS as part of unit/integration suites; this does not cover SDK-added request data (F1) |
| 6.1 | CI jobs on delivery commit | RECORDED PASS — `ci`, `integration`, `e2e`, `deploy` successful on master run `34475037695`; delivery differed from the plan's PR wording (F6) |

## Manual Verification Review

| Phase | Evidence review |
|-------|-----------------|
| 1 | Sentry project, project-scoped MCP/OAuth setup and spend controls are recorded; e2e file contains no DSN. |
| 2 | Worker binding arrival and no-DSN local behavior are recorded; current wrapper/config match the amended architecture. |
| 3 | Browser and Worker seams, no-outbound checks and bundle split have direct code/test/build evidence. |
| 4 | Reconciliation-family identifier exception and all money-event promotions match the amended roster and exact field-set tests. |
| 5 | All degradation sites have distinct keys and recorder tests; no explicit user identifier is in app-owned payloads. |
| 6 | Both live smoke events, alert delivery, trigger removal and four negative checks are recorded without committed account identifiers. Linear closure is still pending despite 6.9 being checked (F4). |

## Scope Notes

- No violation of “What We're NOT Doing” was found: no tracing/replay/profiling, status surface, product-metric alerts, database change, repository-scoped MCP configuration or promotion of deliberately excluded console sites.
- Extra changed files are benign implementation support or lifecycle documentation: the shared reporting recorder, generation harness injection, `change.md`, plan amendments, plan brief and verification record.
- `CLAUDE.md` and `AGENTS.md` contain the required identical reporting paragraph in the local ignored files, as the plan specifies.
