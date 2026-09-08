<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Critical-flow e2e — test-plan Phase 4

- **Plan**: `context/changes/testing-phase-4-critical-flow-e2e/plan.md`
- **Scope**: Phase 0 of 6
- **Date**: 2026-09-08
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Automated verification

| Command | Result | Evidence |
|---------|--------|----------|
| `npm run typecheck` | PASS | Exit 0 |
| `npm run typecheck:astro` | PASS | 103 files, 0 errors, 0 warnings, 5 hints |
| `npm run lint` | PASS | Exit 0 |
| `npm test` | PASS | 7 files, 120 tests |
| `npm run test:integration` | PASS | 9 files, 101 tests |

The Windows checks were executed through `npm.cmd`; the first `npm` invocation was blocked by the host's PowerShell execution policy, not by the project.

### Re-run after triage (2026-09-08, F1-F4 applied)

| Command | Result | Evidence |
|---------|--------|----------|
| `npm run typecheck` | PASS | Exit 0 |
| `npm run typecheck:astro` | PASS | 103 files, 0 errors, 0 warnings, 5 hints |
| `npm run lint` | PASS | Exit 0 |
| `npm test` | PASS | 7 files, 127 tests (was 120) |
| `npm run test:integration` | PASS | 9 files, 101 tests, against a local stack with `20260908120000_refusal_replay_balance.sql` applied |

## Findings

### F1 — Refusal replay can never repair a balance lost with the first response

- **Severity**: ⚠️ WARNING
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.ts:411`
- **Detail**: A replayed paid refusal returns `charged: true` but intentionally omits `creditsRemaining`, assuming the client learned the balance from the original response. The idempotency retry exists precisely for a request whose response may have been lost: `useGenerateSummary.ts:265-274` retains the request id after a network failure but learns no balance. The replay therefore confirms the charge without repairing the stale hook/header balance, and a true zero-credit account can remain displayed as one credit until navigation. Successful replays already carry the balance at `generate.ts:379-387`; the refusal replay test at `generate.db.int.test.ts:374-395` checks the debit but not the response balance.
- **Fix A ⭐ Recommended**: Change the `get_refusal_replay` RPC to return both the refusal reason and current balance, update `lookupRefusalReplay`, and pass that balance to `refusalResponse`.
  - Strength: Repairs the exact lost-response path in one trusted `SECURITY DEFINER` read and makes refusal replay symmetric with successful replay.
  - Tradeoff: Requires a Supabase migration, updated function ACLs, service types, and unit/integration coverage.
  - Confidence: HIGH — the ledger row and `user_credits` balance are available at the same database boundary, and the success replay already establishes the response shape.
  - Blind spot: A separate concurrent debit after the RPC snapshot can still make any returned balance momentarily old.
- **Fix B**: After a refusal reason is found, read the balance through the authenticated Supabase client and include it when that read succeeds.
  - Strength: Avoids changing the database function and migration surface.
  - Tradeoff: Adds a second database round trip and a split failure policy; the endpoint must decide whether a balance-read failure still returns the reconstructed 422 without the field.
  - Confidence: MEDIUM — it uses an existing service but is less cohesive than returning the replay facts together.
  - Blind spot: The extra read has not been checked against all replay/failure timing cases.
- **Decision**: FIXED via Fix A — `supabase/migrations/20260908120000_refusal_replay_balance.sql` drops and recreates `get_refusal_replay` as `returns table (refusal_reason text, balance integer)` (grants re-asserted after the drop); `lookupRefusalReplay` now resolves `RefusalReplay { reason, balance }` (missing credits row reads as 0); `respondToRepeatedRequest` passes that balance to `refusalResponse`. Covered by two new unit cases in `credits.test.ts` and a `creditsRemaining` assertion on the replay in `generate.db.int.test.ts`.

### F2 — Editing inputs while a paid refusal is in flight drops its balance update

- **Severity**: ⚠️ WARNING
- **Impact**: 🟠 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/components/hooks/useGenerateSummary.ts:334`
- **Detail**: `inputsChanged()` invalidates the request sequence at `useGenerateSummary.ts:409-417`. When that older request later returns a charged 422 (or a balance-bearing 402), the stale non-success guard at lines 334-344 returns before `setCredits` and `announceBalance` at lines 358-390. Dropping an obsolete error card is correct; dropping an authoritative money update is not. This leaves the form and header overstating the balance in a reachable path, contrary to Phase 0 items 2 and 7 and README's promise that the last request cannot leave the displayed balance stale.
- **Fix**: Apply a numeric `creditsRemaining` to hook state and the global balance event before the stale non-success guard, while continuing to discard stale error/confirmation UI.
  - Strength: Preserves the existing stale-card rule while treating a server-reported balance like the already-special-cased paid success state.
  - Tradeoff: The ordering must remain explicit so a later refactor does not reapply stale advisory UI with the balance.
  - Confidence: HIGH — the success branch already applies paid state before checking staleness for the same reason.
  - Blind spot: Programmatic concurrent `generate()` calls outside the current disabled-while-loading UI were not exercised.
- **Decision**: FIXED — a single `creditsRemaining` application now sits directly above the stale non-success guard in `useGenerateSummary.ts`, so every balance-bearing non-2xx (402 and the charged 422s) syncs `credits` and the header event even when the inputs moved on; the 402 and 422 branches no longer re-apply it and still drop their stale advisory UI. Not unit-covered — the hook needs a DOM environment this repo does not have (see `useGenerateSummary.test.ts` header); verified by typecheck and the unchanged pure-mapper suite.

### F3 — Unknown or missing cause codes can still render English

- **Severity**: ⚠️ WARNING
- **Impact**: 🟠 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/components/hooks/useGenerateSummary.ts:118`
- **Detail**: Phase 0 item 6, `copy.errors.codes` documentation, and README promise that an absent or unknown code falls back to a generic Polish status message. `messageForError` passes `serverError` to `messageForStatus`, whose 400/422/429/500/503/default branches prefer that English string. The new fallback test uses status 413, which ignores `serverError`, while `useGenerateSummary.test.ts:82-86` explicitly pins the opposite behavior for a missing 429 code. A cause deployed before its translation therefore leaks English exactly where the contract says it must degrade to Polish.
- **Fix A ⭐ Recommended**: Make unresolved or absent codes use only the Polish per-status fallback, and parameterize tests across the multi-cause statuses with an English `error` present.
  - Strength: Implements the user's explicit “no English in the card” ruling and makes the regression test exercise the branches that can violate it.
  - Tradeoff: An older server build without codes loses its more specific English wording in favor of generic Polish copy.
  - Confidence: HIGH — all current multi-cause endpoint exits already send codes; 401 and 502 already have correct Polish status fallbacks without codes.
  - Blind spot: Compatibility with any external client that imports this UI helper has not been investigated.
- **Fix B**: Keep the English legacy fallback and revise the plan, README, copy-table comment, and success criterion to document that compatibility choice.
  - Strength: Preserves cause-specific information when talking to an older or malformed server response.
  - Tradeoff: Reverses the recorded product decision and permits mixed-language error cards.
  - Confidence: MEDIUM — behavior is already implemented, but it conflicts with the accepted oracle.
  - Blind spot: User acceptance of mixed-language fallback would need to be reconfirmed.
- **Decision**: FIXED via Fix A — `messageForStatus` is Polish on every branch and `messageForError`'s `serverError` parameter is REMOVED, so no path can render the English string; call sites pass `(status, code)`. Tests now parameterize the multi-cause statuses (400/422/429/500/503 plus the `default` arm) as code-less Polish, replacing the row that pinned the English 429. Nothing is lost in practice: every current 400/422/429/500/503 exit sends a code, and the two 502s and the 401 already had correct Polish status fallbacks. Comments in `generate.ts` (the D3 string pair and the budget 503) were re-synced to the code-carries-the-distinction rule.

### F4 — Phase 0 decisions were not propagated consistently through derived docs

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `context/changes/testing-phase-4-critical-flow-e2e/plan.md:54`, `plan.md:103`, `plan.md:526`, `plan.md:567`, `plan.md:668`, `context/changes/testing-phase-4-critical-flow-e2e/plan-brief.md:40`, `README.md:263`
- **Detail**: The documents retain mutually contradictory instructions after items 6 and 7: non-refusal statuses are still called English; the 402 branch is called untouched; Phase 5 is told to document “header never updates”; Phase 3 summary/progress still requires an English refusal; and `plan-brief.md` puts non-refusal Polish copy both out of scope and back into scope. README additionally says every endpoint error has a code even though the accepted design deliberately exempts 401 and both 502s. This violates the accepted lesson to synchronize `plan.md`, `plan-brief.md`, and derived docs in the same pass, and can misdirect later phases.
- **Fix**: Reconcile the listed lines with Phase 0 items 6/7 and narrow README's “every error” claim to the coded exits while documenting the 401/502 status-fallback exceptions.
- **Decision**: FIXED — `plan.md`: the "still English by decision" tail on the NOT-doing entry and the "402 branch untouched" contract are struck and dated; the §6.4 cookbook now names the `credits:changed` sync instead of the header-never-updates fact; the Phase 3 e2e bullet and manual item 3.6 now demand the Polish `copy.errors.codes.*` string; items 1 and 6 carry dated amendments for the F1 replay balance and the F3 signature change. `plan-brief.md`: the out-of-scope "Polish copy for the non-refusal exits" entry is struck and points at the moved-into-scope paragraph below it. `README.md`: the "every error carries a code" claim is narrowed to multi-cause statuses, the 401/502 exemption is stated, and the fallback is described as structural (the mapper no longer takes the English string).

### F5 — Manual completion has no reproducible verification record

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `context/changes/testing-phase-4-critical-flow-e2e/plan.md:615`
- **Detail**: Manual items 0.5 and 0.11-0.14 are checked and the commit message says a manual pass occurred, but the change folder contains no verification artifact recording setup, observed UI values, routes, or results. The diff proves the intended code exists, not that the browser behaviors marked complete were observed. Items 0.6 and 0.7 are directly visible in the documentation/code diff.
- **Fix**: Add a concise Phase 0 manual-verification note with the account setup, exercised paths, observed before/after balances and Polish copy/redirect results.
- **Decision**: SKIPPED (user, 2026-09-08) — the manual pass happened; a retroactive artifact reconstructed from the diff would record the reviewer's reading, not the observation.
