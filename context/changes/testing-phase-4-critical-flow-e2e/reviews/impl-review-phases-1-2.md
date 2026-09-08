<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Critical-flow e2e — test-plan Phase 4

- **Plan**: `context/changes/testing-phase-4-critical-flow-e2e/plan.md`
- **Scope**: Phases 1–2 of 6
- **Date**: 2026-09-08
- **Verdict**: REJECTED
- **Findings**: 1 critical, 6 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | FAIL |

## Automated verification

| Command / proof | Result | Evidence |
|-----------------|--------|----------|
| `npx playwright --version` | PASS | Playwright 1.63.0 |
| `npm run typecheck` | PASS | Exit 0 |
| `npm run typecheck:astro` | PASS | 115 files, 0 errors, 0 warnings, 6 hints |
| `npm run lint` | PASS | Exit 0 |
| `npm test` | PASS | 8 files, 132 tests |
| `npm run test:integration` | PASS | 9 files, 101 tests |
| Plain `npm run build` | PASS | No `E2E_FAKE_SUMMARIZER`; real system prompt present |
| `E2E_FAKE_LLM=1 npm run build` | PASS | Fake marker present; real system prompt absent |
| `npm run test:e2e` — cold dev run | FAIL | Pending card remained; saved card absent after 15 s. During the request Vite optimized `astro/env/runtime`, `zod`, and `@supabase/supabase-js` and reloaded the dev program. |
| `npm run test:e2e` — immediate retry | PASS | 1 spec passed in 7.6 s; cleanup after the failed run left 0 `synthetic-e2e-` accounts |
| `npm run test:e2e -- --repeat-each=2` | PASS | 2/2 iterations passed in one worker |

The Windows checks were executed through `npm.cmd` / `npx.cmd`; direct PowerShell wrappers were blocked by the host execution policy, not by the project. Astro/Vitest/Playwright commands that need host-level config, server, browser, or parent-directory access were rerun outside the filesystem sandbox with approval.

## Manual criteria evidence

- The deliberate-break record exists in the Phase 2 addendum and covers the card body, reported balance, and stored model independently.
- The fake model slug plus an empty `supadata_calls` read are asserted by the successful seed run. Vendor dashboards were not independently inspected during this review.
- The topbar and account balance use `aria-labelledby` against their visible labels; no `data-testid` was introduced.
- A failed seed run cleaned up its synthetic account and stopped its dev server. The hard-kill stale-row scenario was not repeated during this review.

## Findings

### F1 — Local E2E can spend real vendor credits before detecting a bad harness mode

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `playwright.config.ts:104`, `playwright.config.ts:119`, `tests/e2e/fixtures/global-setup.ts:20`, `package.json:20`
- **Detail**: The local command loads the developer's real environment and `webServer.env` overrides only `E2E_FAKE_LLM`. `reuseExistingServer: true` may accept a bare server that was started without the alias; the config comment explicitly admits that this can call OpenRouter. A cache miss can likewise reach Supadata with a real key. `readSupadataCalls()` and the stored-model assertion detect the mistake only after the paid request. In addition, Playwright starts/reuses and probes `webServer` before `globalSetup`, so the loopback guard does not run before the first app request. This violates the repository's load-bearing rule that no test may spend real provider credit.
- **Fix A ⭐ Recommended**: Make local E2E fail closed: evaluate the shared loopback guard while loading the Playwright config, set `reuseExistingServer: false`, and pass non-billable placeholder vendor keys to the server environment while keeping `E2E_FAKE_LLM=1`.
  - Strength: Prevents both paid boundaries before a spec runs and makes an occupied/wrong-mode port a loud startup failure.
  - Tradeoff: Every local run starts its own server; the shared guard must move to a dependency-light module importable from config.
  - Confidence: HIGH — it closes each observed path before network or mutation and preserves the existing build-time LLM seam.
  - Blind spot: Confirm Astro's env precedence between inherited `.env`, `.dev.vars`, and explicit `webServer.env` with one intentionally invalid local run.
- **Fix B**: Keep server reuse but add an unambiguous E2E-mode health handshake and refuse all tests unless it proves the fake build plus non-billable vendor configuration.
  - Strength: Retains the faster reuse loop.
  - Tradeoff: Adds production-visible or test-only handshake surface and is materially easier to misconfigure than owning the server process.
  - Confidence: MEDIUM — it can be safe, but only if the handshake proves configuration rather than echoing a runtime flag.
  - Blind spot: The correct place for a health signal in the workerd/Astro lifecycle has not been prototyped.
- **Decision**: PENDING

### F2 — The seed spec fails on a cold dev server

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Success Criteria
- **Location**: `playwright.config.ts:104`, `tests/e2e/generate-summary.spec.ts:84`
- **Detail**: The first review run reached the pending card but never produced the saved card. While the request was active, Vite discovered and optimized three dependencies and reloaded the dev program. The immediate retry passed in 7.6 s and `--repeat-each=2` passed twice, showing a cold-start flake rather than deterministic correctness. A clean checkout or dependency/config change can therefore fail the exemplar before any product assertion, while the Progress section says the run is green and repeatable.
- **Fix A ⭐ Recommended**: Run E2E against `build + preview` locally as well as in CI.
  - Strength: Removes dev optimizer reloads and tests the same server shape used by the gate.
  - Tradeoff: Slower local feedback and a build before every run.
  - Confidence: HIGH — the failure was emitted by the dev optimizer; preview serves a completed bundle.
  - Blind spot: Measure whether the added build time materially harms the Phase 3–4 authoring loop.
- **Fix B**: Keep `astro dev`, explicitly prebundle the discovered dependencies and add a startup warm-up that proves the server no longer reloads before the test begins.
  - Strength: Preserves the faster edit-run loop after warm-up.
  - Tradeoff: Couples the harness to Vite optimizer behavior and may require maintenance as dependency graphs change.
  - Confidence: MEDIUM — the observed dependencies are known, but future lazy imports can recreate the same failure.
  - Blind spot: The minimum reliable warm-up for the POST route has not been established without mutating application state.
- **Decision**: PENDING

### F3 — The visible content oracle does not prove the selected channel character reached the card

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `tests/e2e/generate-summary.spec.ts:57`, `tests/e2e/generate-summary.spec.ts:88`, `tests/e2e/generate-summary.spec.ts:95`
- **Detail**: The spec deliberately selects `educational` and says the visible assertion proves that choice reached the LLM call, but the card assertion checks only `transcriptFingerprint`, which is independent of character. If the card displays an `informational` fake summary for the same transcript while Postgres stores the correct educational row, every current assertion remains green. That is a direct card-versus-saved mismatch under risk #6. The deliberate-break record replaced the whole body with a constant and did not exercise this false-green case.
- **Fix**: In the expanded summary body, assert a character-dependent visible fragment (for example the fake's exact `educational` line) in addition to the transcript fingerprint, and add this mismatch to the deliberate-break proof.
- **Decision**: PENDING

### F4 — Account setup failures can leak a synthetic auth user

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `tests/e2e/fixtures/account.ts:79`
- **Detail**: `createSyntheticAccount()` completes before the fixture enters `try/finally`. If `context.addCookies()` or the optional `setBalance()` rejects, `account.dispose()` is never reached and the run leaks an `auth.users` row. Existing integration helpers start the `try` immediately after account creation.
- **Fix**: Begin `try/finally` immediately after `createSyntheticAccount()` and include cookie injection, balance setup, and `await use(...)` inside it.
- **Decision**: PENDING

### F5 — The seed registry safety rule is comment-only

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `tests/e2e/fixtures/test.ts:27`, `tests/e2e/fixtures/registry.ts:14`
- **Detail**: `seedVideo.seed()` accepts any `string` although its contract says the ID must come from the registry. A copied spec can typo an ID, use an unregistered synthetic ID, or seed a real YouTube ID. After a hard kill, `globalSetup` scans only registered IDs, so that fabricated user-agnostic cache row is invisible and can later answer a real request.
- **Fix**: Export an `E2eYoutubeId` union from the registry, accept only that type in `VideoSeeder.seed`, and runtime-reject values absent from `E2E_RESERVED_YOUTUBE_IDS` before any write.
- **Decision**: PENDING

### F6 — The pending-card assertion races an immediately resolving fake

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency
- **Location**: `tests/e2e/generate-summary.spec.ts:73`
- **Detail**: The fake LLM resolves immediately. If the request completes and the pending card is replaced before Playwright first observes its status, a retrying assertion cannot recover because the expected state existed only in the past. Copying this pattern into later fast flows creates a timing-dependent exemplar even though it contains no explicit sleep.
- **Fix A ⭐ Recommended**: Gate the generate request with Playwright routing, assert the pending state while the request is held, then release it and continue to the saved state.
  - Strength: Makes the transient-state assertion deterministic without a time-based wait.
  - Tradeoff: Adds a small synchronization helper and must not fake the response itself.
  - Confidence: HIGH — the browser request can be delayed while the real endpoint remains the system under test after release.
  - Blind spot: Verify the chosen route gate works consistently with workerd streaming and does not hold unrelated page requests.
- **Fix B**: Remove the pending assertion from the business-flow exemplar and cover pending UI in a separate, deliberately controlled test.
  - Strength: Keeps paid-flow specs focused on durable outcomes.
  - Tradeoff: Adds another test if pending state is still considered contract-critical.
  - Confidence: HIGH — no current ledger oracle depends on observing the transient card.
  - Blind spot: Product ownership of the pending state as a required behavior should be confirmed.
- **Decision**: PENDING

### F7 — Cleanup stops after the first deletion error

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `tests/e2e/fixtures/test.ts:52`, `tests/e2e/fixtures/seed-cache.ts:83`
- **Detail**: Future specs may seed multiple videos, but teardown deletes them sequentially and fails fast. One transcript delete failure prevents its metadata delete and every later ID's cleanup, magnifying one database error into multiple stale rows and blocking the next run.
- **Fix**: Attempt cleanup for both tables and all tracked IDs, collect failures, then throw one `AggregateError` after every cleanup attempt has run.
  - Strength: Preserves loud cleanup failures while minimizing leaked state.
  - Tradeoff: Slightly more teardown code and a combined error message.
  - Confidence: HIGH — all cleanup targets are already known before teardown begins.
  - Blind spot: If the owner connection itself is lost, all attempts may fail for the same root cause.
- **Decision**: PENDING

### F8 — The canonical cookbook contradicts the implemented ESLint exception

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `context/foundation/test-plan.md:285`, `eslint.config.js:91`
- **Detail**: The cookbook says `tests/` needs no `eslint.config.js` change, while Phase 2 added a targeted override for Playwright fixture callbacks misread as React `use()`. The plan addendum documents why the override is legitimate, but the canonical document future contributors are told to read remains stale.
- **Fix**: Rewrite the cookbook sentence to say the base coverage required no inclusion change, but Playwright fixtures need the scoped `react-hooks/rules-of-hooks` exception already present.
- **Decision**: PENDING

## Seed exemplar assessment

The seed is strong in the places most E2E suites get wrong: semantic locators, state-based waits, explicit island hydration, fresh per-test accounts, a two-sided money/ledger oracle, summary-to-reservation linkage, and cleanup after an ordinary test failure. The second and repeated runs prove sequential isolation.

It is not yet a safe gold-standard template for Phases 3–4. F1 can spend real vendor credit before detection, F2 makes a clean local run flaky, F3 leaves a direct UI-versus-stored-content false green, and F4–F7 leave lifecycle guarantees partly conventional rather than enforced. Fix F1–F5 before treating the file as the model copied by the next E2E phase; F6–F7 should be resolved while the fixture surface is still small.
