<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Generate and Save a Video Summary (S-01)

- **Plan**: `context/changes/generate-and-save-summary/plan.md`
- **Mode**: Deep
- **Date**: 2026-07-18
- **Verdict**: RETHINK → **SOUND after triage** (2026-07-19)
- **Findings**: 2 critical, 5 warnings, 0 observations — all 7 FIXED in plan.md
- **Triage (2026-07-19)**: F1 debit-first + refund (via new `refund_credits` service_role RPC); F2 Progress cleaned; F3 expand/contract migration (drop deferred); F4 sentinel re-reads balance; F5 `HARD_MAX_TRANSCRIPT_CHARS` → 413; F6 PowerShell gates + stale-comment fix + authed RPC check; F7 stable 500 + UI mapping.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | FAIL |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | FAIL |
| Plan Completeness | FAIL |

## Grounding

Grounding: 14/14 current paths ✓, 7/7 symbols ✓, brief↔plan ✓; blast radius found 1 omitted reference.

## Findings

### F1 — Concurrent generation bypasses the credit budget

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Blind Spots
- **Location**: Critical Implementation Details / Phase 4
- **Detail**: The plan preserves persist-then-best-effort-spend and returns 200 even when spending fails. Concurrent requests can all pass one balance read, incur provider costs, save summaries, and only one debit succeeds. This defeats the budget guardrail.
- **Fix A ⭐ Recommended**: Add atomic request-scoped credit reservations, finalized after persistence and released on failure.
  - Strength: Enforces concurrency correctly while retaining “spend on success.”
  - Tradeoff: Requires reservation state/RPCs and cleanup for abandoned requests.
  - Confidence: HIGH — serialization requires state somewhere.
  - Blind spot: Reservation-expiry policy needs definition.
- **Fix B**: Debit before the LLM call and explicitly charge generation attempts.
  - Strength: Much smaller change and protects most provider spend.
  - Tradeoff: Users can lose credits when summarization or persistence fails.
  - Confidence: HIGH — mechanically simple.
  - Blind spot: Transcript-fetch cost remains outside the debit.
- **Decision**: FIXED via Fix A (debit-first + refund variant) — `spend_credits(cost)` moved before the paid LLM call as the atomic serialization gate; new `refund_credits(user_id, amount)` RPC (service_role-only, admin client) releases the debit on any downstream failure; best-effort-200 contract removed. A race-losing request may still pay the cheaper transcript fetch (accepted).

### F2 — Progress contract is malformed

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 / Progress
- **Detail**: Phase 3 contains a Manual Verification bullet saying “N/A,” but Progress has no matching `3.3` item. The Progress preamble also links to a nonexistent `references/progress-format.md`. `/10x-implement` expects this structure mechanically.
- **Fix**: Remove the N/A verification subsection and the dead reference.
- **Decision**: FIXED — removed Phase 3's N/A Manual Verification subsection and dropped the `references/progress-format.md` link from the Progress preamble.

### F3 — RPC replacement creates a deployment outage window

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 2 / Migration Notes
- **Detail**: Dropping `spend_credit()` in the same migration is not atomic with deploying the Worker. DB-first breaks the old Worker; Worker-first calls an RPC that does not exist. The plan’s “no window” claim is incorrect.
- **Fix**: Use expand/contract — create `spend_credits`, deploy its caller, then drop `spend_credit` in a later migration.
- **Decision**: FIXED — this slice's migration is now expand-only (adds `spend_credits`/`refund_credits`, keeps `spend_credit()`); the drop is deferred to a follow-up contract migration after the new Worker is live. Migration Notes rewritten; the false "no window" claim removed.

### F4 — The insufficient sentinel can report the wrong balance

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Phase 2 — Credits service
- **Detail**: The new RPC returns `-1` when balance is less than the requested amount. For a two-credit spend, the real balance may be 1, but the existing service maps `-1` to balance 0. The plan incorrectly says the result semantics remain unchanged.
- **Fix**: Re-read the balance on the insufficient sentinel or return the actual balance from the RPC.
- **Decision**: FIXED — `spendCredit` now re-reads the real balance via `getBalance` on the `-1` sentinel instead of hard-coding 0, so the 402 "you have &lt;balance&gt;" message is accurate.

### F5 — The 40k threshold is not a transcript cap

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Performance Considerations / Phase 3
- **Detail**: The plan says the “40k-char cap” bounds token cost and latency, but `summaryCost()` only changes the credit price. `summarize()` still sends the complete, unbounded transcript.
- **Fix A ⭐ Recommended**: Define a hard maximum and return a specific too-long response before calling the LLM.
  - Strength: Predictable cost, latency, and context usage.
  - Tradeoff: Some very long videos are rejected.
  - Confidence: HIGH — simplest MVP-safe bound.
  - Blind spot: The acceptable maximum needs choosing.
- **Fix B**: Add chunked/hierarchical summarization.
  - Strength: Supports arbitrarily long videos.
  - Tradeoff: Substantially more calls, cost, prompt work, and failure handling.
  - Confidence: MEDIUM — effective but outside the current thin-slice design.
  - Blind spot: Credit pricing for multiple LLM calls remains undefined.
- **Decision**: FIXED via Fix A (hard maximum) — added `HARD_MAX_TRANSCRIPT_CHARS = 200000`; the endpoint returns `413` before any debit/LLM call when the transcript exceeds it. Performance Considerations wording corrected (40k is the price threshold, not a cost bound).

### F6 — Verification gates cannot pass as written

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phases 2 and 4
- **Detail**: `src/pages/api/account/delete.ts:46` references the old probe path, contradicting “no other route references it.” `grep` is unavailable in the repository’s PowerShell environment. Calling `spend_credits(2)` directly in SQL Editor has no authenticated `auth.uid()`, so it cannot debit the intended seeded user.
- **Fix**: Include `account/delete.ts`, use a PowerShell `Select-String` check, and verify the RPC through an authenticated request or explicitly configured test JWT context.
- **Decision**: FIXED — Phase 4 now updates the stale `account/delete.ts:46` comment; the no-stale-refs gate uses `Get-ChildItem -Recurse -File src | Select-String`; Phase 2 verifies `spend_credits` under an authenticated JWT context (or the endpoint), not a bare SQL-editor call.

### F7 — Persistence failures have no stable API/UI path

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phases 4 and 6
- **Detail**: Only transcript and LLM calls receive planned error handling. Video/summary persistence can throw after paid provider work, producing an unhandled 500, while the UI contract defines no generic 500 response.
- **Fix**: Catch persistence failures, return a stable generic 500 payload, and map it to a retryable inline UI message.
- **Decision**: FIXED — Phase 4 wraps persistence so a post-debit failure refunds and returns a stable `500`; Phase 6 UI maps `500` to a retryable inline message.
