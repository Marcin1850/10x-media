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
- **Decision**: FIXED via Fix A, with its vendor-key half replaced after measurement.
  - **Landed as specified**: the loopback guard moved to a new dependency-free `src/test/loopback-guard.ts` (re-exported from `integration-setup.ts`, which also breaks its import cycle with `db-owner.ts`) and now runs while `playwright.config.ts` loads — before `webServer` starts and is probed. `reuseExistingServer` is `false` in both environments, so the bare-`npm run dev` reuse path that could reach OpenRouter no longer exists; an occupied :4321 is a loud startup error.
  - **Changed after measurement**: Fix A's "placeholder vendor keys in `webServer.env`" is impossible. A throwaway probe route reading `astro:env/server` from inside the Worker showed the app still saw the REAL keys (35 and 73 chars) — @astrojs/cloudflare re-reads the fixed-name `.dev.vars` into `process.env` at `astro:config:done`, overwriting anything `webServer.env` passes. Replaced (user decision) with a wrangler environment: `CLOUDFLARE_ENV=e2e` on `webServer` makes wrangler load a committed `.dev.vars.e2e` whose Supadata/OpenRouter values are deliberate non-credentials. Re-probed: `isPlaceholder: true` for both. No `env.e2e` section was added to `wrangler.jsonc` on purpose — absent, wrangler warns once and keeps the top-level config, so bindings stay identical; adding one would drop every non-inheritable binding.
  - **Second guard**: wrangler's fallback from `.dev.vars.e2e` to `.dev.vars` is silent, so the config also refuses to start when the file is missing. Both guards verified firing (`does not resolve to loopback`; `` `.dev.vars.e2e` is missing ``).
  - **Depends on F2**: the `.dev.vars.e2e` mechanism only reaches the app under `build + preview`. Under `astro dev` the adapter's `process.env` assignment wins. F2's fix makes local runs use `preview`, which is what makes this protection real locally rather than CI-only.

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
- **Decision**: FIXED via Fix A. `webServer.command` is now `npm run build && npm run preview` in BOTH environments — the `isCI` split is gone. This removes the dev dependency-optimizer that caused the cold-run failure, and it is also the only measured way F1's non-billable vendor keys reach the app (probed: `astro dev` → real keys, `preview` → placeholders). The stale rationale on `timeout` and `expect.timeout`, which justified both by `astro dev`'s compile-on-first-request, was rewritten rather than left to mislead; the values are unchanged and are now honestly described as headroom. Verified: `npm run test:e2e` passes, the spec itself in 3.6s (7.6s under dev), ~1.5 min wall clock including the build.

### F3 — The visible content oracle does not prove the selected channel character reached the card

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `tests/e2e/generate-summary.spec.ts:57`, `tests/e2e/generate-summary.spec.ts:88`, `tests/e2e/generate-summary.spec.ts:95`
- **Detail**: The spec deliberately selects `educational` and says the visible assertion proves that choice reached the LLM call, but the card assertion checks only `transcriptFingerprint`, which is independent of character. If the card displays an `informational` fake summary for the same transcript while Postgres stores the correct educational row, every current assertion remains green. That is a direct card-versus-saved mismatch under risk #6. The deliberate-break record replaced the whole body with a constant and did not exercise this false-green case.
- **Fix**: In the expanded summary body, assert a character-dependent visible fragment (for example the fake's exact `educational` line) in addition to the transcript fingerprint, and add this mismatch to the deliberate-break proof.
- **Decision**: FIXED. `fake-llm.ts` now exports `fakeCharacterLine(character)` and builds that body line from it, so the spec asserts the character through the SAME function the app's response came from rather than a literal that can drift. That line lost its `**` emphasis (it is now asserted against rendered text, where `**` does not survive react-markdown); the fingerprint and length lines keep theirs, so the body still exercises Markdown rendering. Recorded as deliberate-break #4 in the plan's section F: asserting `informational` against an `educational` run goes red with `- Charakter kanału: informational` / `+ Charakter kanału: educational`.

### F4 — Account setup failures can leak a synthetic auth user

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `tests/e2e/fixtures/account.ts:79`
- **Detail**: `createSyntheticAccount()` completes before the fixture enters `try/finally`. If `context.addCookies()` or the optional `setBalance()` rejects, `account.dispose()` is never reached and the run leaks an `auth.users` row. Existing integration helpers start the `try` immediately after account creation.
- **Fix**: Begin `try/finally` immediately after `createSyntheticAccount()` and include cookie injection, balance setup, and `await use(...)` inside it.
- **Decision**: FIXED. The `try` now opens on the line after `createSyntheticAccount()`, so cookie injection, `setBalance` and `await use(...)` are all covered by the existing `finally`. Matches the shape the integration helpers already use.

### F5 — The seed registry safety rule is comment-only

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `tests/e2e/fixtures/test.ts:27`, `tests/e2e/fixtures/registry.ts:14`
- **Detail**: `seedVideo.seed()` accepts any `string` although its contract says the ID must come from the registry. A copied spec can typo an ID, use an unregistered synthetic ID, or seed a real YouTube ID. After a hard kill, `globalSetup` scans only registered IDs, so that fabricated user-agnostic cache row is invisible and can later answer a real request.
- **Fix**: Export an `E2eYoutubeId` union from the registry, accept only that type in `VideoSeeder.seed`, and runtime-reject values absent from `E2E_RESERVED_YOUTUBE_IDS` before any write.
- **Decision**: FIXED, both halves. `registry.ts` exports `E2eYoutubeId` (derived from `E2E_YOUTUBE_IDS`, so it cannot drift from the roster) plus an `assertReservedYoutubeId` assertion function; `VideoSeeder.seed` accepts only the union, and calls the runtime check before the first write AND before the id enters the cleanup list. The runtime half is not redundant: a cast, a JS caller, or an id built from a variable all pass `tsc`. Recorded as deliberate-break #5 - seeding the real id `dQw4w9WgXcQ` (cast past the type) goes red in 1.1 s, before any database write, naming the registered ids in the error.

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
- **Decision**: FIXED via Fix A. New `tests/e2e/fixtures/request-gate.ts` holds the generate request open (`page.route` on `**/api/summaries/generate`); the spec asserts the pending card while it is held, then releases it with `route.fallback()` so the REAL endpoint serves the real response - the gate delays, it never answers, so every assertion after it describes an ordinary generation. The pattern matches that one URL, so documents, assets and the follow-up `GET /api/summaries` are never held. Proved non-decorative by removing `release()`: the saved card then never arrives and the spec fails on the heading assertion, which also demonstrates that the pending assertion ran while the request was genuinely in flight.

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
- **Decision**: FIXED at both levels, since fixing one alone would leave the other failing fast. `deleteCacheRows` now attempts `transcript_cache` and `metadata_cache` independently and throws a single `AggregateError`; the `seedVideo` teardown loops every seeded id the same way and aggregates across ids. Failures stay loud - they are collected, never swallowed - but nothing is skipped, which matters because a skipped row aborts the NEXT run through `global-setup.ts`'s guard.

### F8 — The canonical cookbook contradicts the implemented ESLint exception

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `context/foundation/test-plan.md:285`, `eslint.config.js:91`
- **Detail**: The cookbook says `tests/` needs no `eslint.config.js` change, while Phase 2 added a targeted override for Playwright fixture callbacks misread as React `use()`. The plan addendum documents why the override is legitimate, but the canonical document future contributors are told to read remains stale.
- **Fix**: Rewrite the cookbook sentence to say the base coverage required no inclusion change, but Playwright fixtures need the scoped `react-hooks/rules-of-hooks` exception already present.
- **Decision**: FIXED, and extended (user decision) to the rest of section 6.4 that this triage invalidated. The sentence now separates **inclusion** (unchanged - `**/*` still covers `tests/`) from the scoped **exception** `eslint.config.js` carries, with the Playwright-fixture-versus-React-`use()` reason. Section 6.4 also gained a four-rule "the runner fails closed" block covering the F1/F2 changes: always `build + preview`, never reuse a server, vendor keys via `CLOUDFLARE_ENV=e2e` / `.dev.vars.e2e` (and why `webServer.env` cannot do it), and both guards evaluated at config load rather than in `globalSetup`. The stale half-truth "`.dev.vars` reaches only the app server" was replaced by a pointer to those rules.

## Triage outcome (2026-09-09)

All eight findings resolved: **F1, F2, F6 fixed via Fix A** (F1's vendor-key mechanism was replaced after measurement disproved it - see its Decision), **F3, F4, F5, F7, F8 fixed** as proposed. Nothing skipped, accepted or dismissed.

The verdict table above is left as the record of what the review found; the table below is the state after triage.

| Check | Result | Evidence |
|-------|--------|----------|
| `npm run lint` | PASS | Exit 0 |
| `npm run typecheck` | PASS | Exit 0 |
| `npm run typecheck:astro` | PASS | 0 errors, 0 warnings, 6 hints |
| `npm test` | PASS | 8 files, 132 tests |
| `npm run test:integration` | PASS | 9 files, 101 tests - covers the `loopback-guard.ts` extraction |
| `npm run test:e2e` | PASS | 1 spec in 2.9 s under the new `build + preview` harness |
| `npm run test:e2e -- --repeat-each=2` | PASS | 2/2 in one worker, 47 s including the build |
| Loopback guard fires at config load | PASS | A non-loopback `SUPABASE_URL` refuses before `webServer` starts |
| Missing `.dev.vars.e2e` refuses to start | PASS | Verified by moving the file aside |
| Vendor keys under `preview` | PASS | Worker-side probe: `isPlaceholder: true` for both keys |
| Deliberate break #4 (character) | RED as intended | `- Charakter kanału: informational` / `+ ... educational` |
| Deliberate break #5 (registry) | RED as intended | A real YouTube id is rejected in 1.1 s, before any write |
| The request gate genuinely holds | PASS | Without `release()` the saved card never arrives |

One environmental interruption, unrelated to the code: the local Supabase gateway (Kong) stopped accepting connections mid-session and was restored with `docker restart supabase_kong_10x-media`.

**Residual, deliberately not done**: `README.md` still describes secrets as living in two files and does not mention `.dev.vars.e2e`. The README documents no e2e workflow at all yet, so that belongs with the Phase 6 documentation work rather than to this triage.

## Seed exemplar assessment

The seed is strong in the places most E2E suites get wrong: semantic locators, state-based waits, explicit island hydration, fresh per-test accounts, a two-sided money/ledger oracle, summary-to-reservation linkage, and cleanup after an ordinary test failure. The second and repeated runs prove sequential isolation.

It is not yet a safe gold-standard template for Phases 3–4. F1 can spend real vendor credit before detection, F2 makes a clean local run flaky, F3 leaves a direct UI-versus-stored-content false green, and F4–F7 leave lifecycle guarantees partly conventional rather than enforced. Fix F1–F5 before treating the file as the model copied by the next E2E phase; F6–F7 should be resolved while the fixture surface is still small.
