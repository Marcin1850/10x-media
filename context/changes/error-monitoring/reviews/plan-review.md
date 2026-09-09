<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Error Monitoring (Sentry)

- **Plan**: `context/changes/error-monitoring/plan.md`
- **Mode**: Deep
- **Date**: 2026-09-09
- **Verdict**: RETHINK → **SOUND** after triage (all 10 findings fixed 2026-09-09)
- **Findings**: 4 critical, 6 warnings, 0 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | FAIL |
| Lean Execution | WARNING |
| Architectural Fitness | FAIL |
| Blind Spots | FAIL |
| Plan Completeness | FAIL |

## Grounding

15/15 existing paths verified, 8/8 referenced symbols verified, brief-to-plan consistency verified. New paths are explicitly marked as new. `docs/reference/contract-surfaces.md` is absent, so the opt-in contract-surface check was skipped. The plan's `references/progress-format.md` reference does not resolve to an existing file.

## Findings

### F1 — The plan mixes two competing Worker instrumentation paths

- **Severity**: CRITICAL
- **Impact**: HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architectural Fitness
- **Location**: Phase 2 — Dependencies, Worker entry wrapper, Astro integration
- **Detail**: The plan both registers `sentry()` and replaces Wrangler's entrypoint with a custom `Sentry.withSentry` wrapper. `@sentry/astro` gained first-class Astro-on-Cloudflare-Workers support in 10.40 and now detects the Cloudflare adapter, injects server initialization, adds a Cloudflare Vite plugin that wraps the Worker entry with `withSentry`, and adds middleware. Without `sentry.server.config.ts`, its default initialization reads `PUBLIC_SENTRY_DSN`. The proposed combination can therefore double-wrap/double-initialize the Worker and, more importantly, let the build-time public DSN initialize server reporting independently of the runtime `SENTRY_DSN`. The manual wrapper itself is technically feasible: `@astrojs/cloudflare/entrypoints/server` default-exports an `ExportedHandler`, which `withSentry` accepts. The problem is combining it with the integration's server path without disabling one of them. Sources: [Sentry 10.40.0 release](https://github.com/getsentry/sentry-javascript/releases/tag/10.40.0), [official Astro SDK README](https://github.com/getsentry/sentry-javascript/blob/develop/packages/astro/README.md), and the current [Astro integration source](https://github.com/getsentry/sentry-javascript/blob/develop/packages/astro/src/integration/index.ts).
- **Fix A ⭐ Recommended**: Use the official integration end to end: add root `sentry.server.config.ts` and `sentry.client.config.ts`, keep `wrangler.jsonc`'s existing entrypoint, and configure the two DSNs in their respective init files.
  - Strength: One initialization path, less custom code, and alignment with the SDK's supported Astro/Cloudflare architecture.
  - Tradeoff: The implementation must prove in a real workerd build that `sentry.server.config.ts` reads the runtime server secret as intended.
  - Confidence: HIGH — this is the integration's documented path.
  - Blind spot: Exact `astro:env/server` behavior in the injected server config still needs a build/runtime probe.
- **Fix B**: Keep the custom Worker wrapper, but make `sentry()` explicitly client-only with `enabled: { client: true, server: false }`; configure source maps separately and prove there is no second server initialization in the bundle.
  - Strength: Preserves direct control over the Worker's runtime binding.
  - Tradeoff: More custom entrypoint code and a larger maintenance/bundle-verification burden.
  - Confidence: MEDIUM — viable from the public APIs, but the composed build must be measured.
  - Blind spot: Disabling only request middleware is insufficient; the full server side of the Astro integration must be disabled.
- **Decision**: FIXED via Fix A (official integration end to end; custom wrapper and `wrangler.jsonc` change dropped)

### F2 — E2E can inherit a real browser DSN

- **Severity**: CRITICAL
- **Impact**: HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Desired End State; Phase 1 environment isolation; Phase 3 bundle proof; Phase 6 negative verification
- **Detail**: `npm run test:e2e` starts Node with `--env-file-if-exists=.env`, and Playwright passes the parent `process.env` into the `webServer` child. `webServer.env` adds `E2E_FAKE_LLM` and `CLOUDFLARE_ENV` but does not remove either Sentry variable. A developer's local `PUBLIC_SENTRY_DSN` can therefore reach the browser build even though `.dev.vars.e2e` contains no DSN: that file controls Wrangler's Worker bindings, not the client build environment. The integration firewall runs only inside Vitest, while the e2e app and browser are separate processes. No current e2e spec exercises the top-up/browser event or blocks Sentry hosts. The proposed `grep -rl "@sentry/cloudflare" dist/_astro/` is also not a reliable bundle-purity proof because Rollup can remove package specifiers; the existing fake-LLM proof works because it greps an application-owned sentinel.
- **Fix**: Add a Playwright config-load guard that fails closed when `SENTRY_DSN` or `PUBLIC_SENTRY_DSN` is present, block/abort Sentry network hosts in the browser, exercise the browser seam in e2e, and replace the package-name grep with an application-owned sentinel or module-graph/build-plugin assertion. Define a deterministic server-side negative proof as well.
  - Strength: Turns the headline no-outbound promise into an executable guarantee for the actual two-process e2e architecture.
  - Tradeoff: Adds test-runner and build-verification work beyond the currently planned comments and manual dashboard check.
  - Confidence: HIGH — the environment flow is explicit in `package.json` and `playwright.config.ts`.
  - Blind spot: Browser request interception does not observe Worker-originated network calls, hence the separate server proof.
- **Decision**: FIXED (Phase 1 fail-closed Playwright guard, `webServer.env` pins both DSNs empty, sentinel-based two-directional bundle proof, e2e Sentry-host abort + top-up walk, four named negative checks in Phase 6)

### F3 — The fingerprint cannot separate the five paid-path conditions

- **Severity**: CRITICAL
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Phase 3 fingerprint contract; Phase 4 paid-path integrity
- **Detail**: Phase 3 fixes the fingerprint at `[key, severity]`. Phase 4 then assigns all five paid-path sites the same `[paid-path]` key and `error` severity, while claiming a discriminator stored only in the payload will separate their fingerprints. Payload fields do not participate in the specified fingerprint, so all five conditions collapse into one Sentry issue. This contradicts the plan's one-condition/one-issue noise-control contract.
- **Fix**: Either use a distinct stable key per paid-path stage or define the fingerprint as `[key, severity, discriminator]`. Add a table-driven test proving that the five stages have distinct fingerprints while different payload values for the same stage remain grouped.
- **Decision**: FIXED via distinct key per condition (`[family:stage]`); fingerprint stays `[key, severity]`, table-driven distinctness test added

### F4 — Progress does not satisfy the plan parser contract

- **Severity**: CRITICAL
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: `## Progress`
- **Detail**: The plan has exactly one bottom `## Progress`, matching phase headings, matching item counts, and no checkboxes outside Progress. However, eight Progress titles do not exactly match their corresponding Success Criteria: 1.5, 3.5, 3.8, 4.6, 5.6, 6.3, 6.4, and 6.6. The referenced `references/progress-format.md` file is also absent. `/10x-implement` relies on this mechanical contract.
- **Fix**: Copy the eight Success Criteria titles verbatim into Progress and remove or correct the dead progress-format reference.
- **Decision**: FIXED (Progress regenerated verbatim from Success Criteria and renumbered; the `progress-format.md` reference is not dead — it resolves to `.claude/skills/10x-plan/references/`, and the link now says so)

### F5 — Promoted events will be logged twice

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phases 4–5 — every promoted existing `console.*` site
- **Detail**: The plan requires each existing console line to remain and additionally calls `reportEvent`. The current `reportEvent` itself logs to `console.warn` or `console.error`, and Phase 3 explicitly preserves that behavior. Each promoted failure will therefore produce two console entries/breadcrumbs, contrary to the unchanged-console-output intent and increasing noise.
- **Fix**: Separate forwarding from logging, for example with one sink-only `captureEvent` helper used internally by `reportEvent` and directly after the preserved console lines. Keep one transport implementation rather than duplicating Sentry logic.
- **Decision**: FIXED (sink-only `captureEvent` split out of `reportEvent`; promoted sites call `captureEvent`)

### F6 — Tests do not prove that event promotion was implemented

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phases 4–5 success criteria; Testing Strategy
- **Detail**: The plan only requires existing unit/integration suites to remain green after adding reporting calls. Those tests assert business outcomes and currently silence console output; they do not assert that the monitoring seam was called, with which key/severity/discriminator, or without disallowed identifiers. Every promotion call could be omitted and the automated Success Criteria would still pass. Phase 3 additionally says the sink is injected without defining the injection mechanism while preserving `reportEvent`'s public signature.
- **Fix**: Define the sink injection/factory mechanism, then add parameterized behavioral assertions for the promoted branches: event key, severity, discriminator/fingerprint, and allowed payload fields. Use existing hermetic Supabase/vendor seams; do not test Sentry transport internals.
  - Strength: Directly protects the core deliverable without network calls or brittle console-copy assertions.
  - Tradeoff: Adds focused tests across several existing modules and the generate integration harness.
  - Confidence: HIGH — current tests provide the failure seams but not the reporting oracle.
  - Blind spot: Some endpoint branches may need a small reporting injection seam to stay testable.
- **Decision**: FIXED (`setReportingSink` injection seam defined; parameterized key/severity/payload-field-set assertions added to Phases 4 and 5, plus a deliberate-deletion check)

### F7 — The promotion inventory omits failures inside its declared scope

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phases 4–5; What We're NOT Doing
- **Detail**: The strongest omission is `credits.ts:438-450` (`CREDIT_LEAK`): a failed refund leaves the reservation open and explicitly requires reconciliation, making it a direct money-integrity event. `generate.ts:194` (`acquireGenerationLease failed`) fits the lock family, and `generate.ts:681` (`recordTranscriptAttempt failed`) fits the guard family. Other unhandled-but-swallowed paid-path sites at `generate.ts:512`, `:534`, `:706`, and `:978` are neither promoted nor explicitly excluded. The plan's out-of-scope list names other console sites individually, so these omissions leave the implementer to guess whether they are intentional.
- **Fix**: Include at least `CREDIT_LEAK` and classify every remaining operator-relevant console site in a compact roster as promoted or deliberately excluded, with one-sentence signal/noise reasoning. Keep the final alert set narrow, but make that calibration explicit.
  - Strength: Closes the money-reconciliation gap and removes implementation-time ambiguity.
  - Tradeoff: A broader promotion set may increase event volume and needs matching fingerprints/tests.
  - Confidence: HIGH for `CREDIT_LEAK`; MEDIUM for the other sites because their desired paging severity is a product/operations decision.
  - Blind spot: Actual production frequency is not yet measured.
- **Decision**: FIXED via Fix A (§Promotion Roster added; `CREDIT_LEAK`, both `get_refusal_replay` sites, `generate.ts:194` and `:681` promoted; every remaining site classified with a reason)

### F8 — One live event cannot verify two transports

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Desired End State; Phase 6 live verification; Manual Testing Step 3
- **Detail**: The plan has independent Worker and browser initialization paths but asks for one unspecified deliberate production event. A browser event can pass while the Worker secret/entry is broken, and a Worker event can pass while the client DSN/init is broken. The plan also does not define a safe, reproducible server-side trigger. All stated live criteria can therefore pass without verifying the complete two-runtime end state.
- **Fix**: Specify two concrete smoke cases: the existing top-up action for the browser and a safe, explicitly removable or operator-restricted server trigger. Record both event IDs/grouping/notification outcomes and verify removal or inaccessibility of any temporary trigger.
  - Strength: Proves both configuration channels and both transports independently.
  - Tradeoff: The server smoke mechanism needs a deliberate security/cleanup decision before implementation.
  - Confidence: HIGH — two independent transports require two independent observations.
  - Blind spot: The repository currently has no operator-only diagnostics endpoint to reuse.
- **Decision**: FIXED (two smoke cases: production top-up click for the browser, a flag-guarded and explicitly reverted Worker trigger; both recorded)

### F9 — README scope is incomplete and whole-file byte identity is impossible

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 environment documentation; Phase 6 documentation
- **Detail**: Including `README.md`, `CLAUDE.md`, and `AGENTS.md` is correct. However, README currently says every env variable is a server-only secret, instructs the operator to set exactly five Worker runtime secrets, says Worker secrets are not injected by the deploy pipeline, and has a separate repository-secrets table. Adding two env-table rows and one monitoring section without updating those statements leaves a contradictory runbook. Also, `CLAUDE.md` and `AGENTS.md` are already intentionally different: their headers/tool descriptions and large 10x lesson blocks differ. The plan's requirement that the files remain byte-identical cannot be met without overwriting tool-specific guidance.
- **Fix**: Expand README changes to cover the env introduction, optional/public distinction, local safety rule, manual build/deploy commands, Worker secret list, repository-secret table, alert catalog, negative scope, verification, and rollback. Add the same concise monitoring paragraph to CLAUDE/AGENTS, but require only that shared paragraph to stay semantically identical.
- **Decision**: FIXED (README scope expanded to the statements the change invalidates; identity requirement scoped to the shared paragraph, and the gitignored status of both files recorded)

### F10 — The SDK version and source-map contracts do not match the APIs used

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 2 dependencies and Astro integration
- **Detail**: The plan permits `@sentry/astro` and `@sentry/cloudflare` from 10.40 while depending on `dataCollection`, which was introduced later in the v10 line (tracked in [Sentry issue #20924](https://github.com/getsentry/sentry-javascript/issues/20924) and shipped from 10.54). The open-ended `>=10.40.0` range also permits future breaking majors. Finally, "source-map upload stays off unless `SENTRY_AUTH_TOKEN` is present" is not backed by a literal integration option; the Astro integration can enable hidden source-map generation even when upload credentials are absent.
- **Fix**: Keep both Sentry packages on the same verified v10 release with a major-bounded range (at least 10.54 and less than 11; preferably the repository's normal caret convention from a verified current v10), and set `sourcemaps.disable` explicitly from the auth-token decision.
- **Decision**: FIXED (both packages on one v10 release, caret-bounded, ≥ 10.54 for `dataCollection`; version check added as 2.8. Source-map half resolved by F1's explicit `sourcemaps.disable` contract)
