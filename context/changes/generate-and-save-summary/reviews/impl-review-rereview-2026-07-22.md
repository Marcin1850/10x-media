<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Generate and Save a Video Summary (S-01)

- **Plan**: `context/changes/generate-and-save-summary/plan.md`
- **Scope**: Phases 1–7 of 8, including all post-review fixes through `0867fce`; deploy-gated Phase 8 excluded
- **Date**: 2026-07-22
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Verification

| Check | Result |
|-------|--------|
| `npm.cmd run lint` | PASS |
| `npm.cmd run build` | PASS |
| `npx.cmd supabase migration up` | PASS — no pending local migrations |
| No stale `summaries/probe` references under `src/` | PASS |
| `git diff --check 99adfea..HEAD` | PASS |
| `npm.cmd audit --offline --json` | PASS — 0 known vulnerabilities |

For Phases 1–7, all 17 automated/recorded Progress items are checked and 16 manual acceptance items remain unchecked. The pending manual matrix is the already accepted F15 release gate and is not duplicated as a new finding. Phase 8 is correctly excluded because its production-deployment precondition and all of its Progress items remain pending.

## Findings

> **Finding IDs continue from the two earlier implementation reviews.** `impl-review.md` contains F1–F8 and `impl-review-rereview-2026-07-20.md` contains F9–F15, so this report begins at **F16**. Resolved earlier findings are not repeated unless a current-HEAD implementation creates a distinct residual failure mode.

### F16 — Reserved rows do not prove whether work failed or was delivered

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality / Architecture
- **Location**: `supabase/migrations/20260720160000_credit_reservations.sql:37`; `src/lib/services/credits.ts:89`; `src/pages/api/summaries/generate.ts:239`
- **Detail**: The summary is persisted before `settleReservation`, and settlement is deliberately best-effort. If the settlement RPC fails or its response is lost, the successful generation remains `reserved`—the same state left when failed work could not be refunded. The migration's reconciliation runbook says every aged `reserved` row is a user owed credits and directs the operator to refund it, so following the runbook can refund work that was saved and delivered. The ledger has no `summary_id` or other durable outcome evidence that distinguishes these cases. Direct authenticated calls to `reserve_credits` can also create reserved rows outside the endpoint, further invalidating the assumption.
- **Fix**: Persist a validated reservation-to-summary link (for example, a unique `summaries.reservation_id` owned by the same user) and make reconciliation settle linked reservations while refunding only aged, unlinked reservations.
  - Strength: Gives reconciliation durable, exact evidence of delivered work and preserves idempotent settlement/refund behavior.
  - Tradeoff: Requires a forward schema migration plus persistence, RPC, type, and runbook changes; it amends the original “no schema change to summaries” boundary.
  - Confidence: HIGH — both successful-settle failure and failed-refund failure currently converge on the identical `reserved` state.
  - Blind spot: Existing unresolved rows will need a one-time classification policy because they predate the link.
- **Decision**: PENDING

### F17 — Long-video confirmation permits unlimited paid transcript attempts

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.ts:131`
- **Detail**: A user needs only a positive balance to trigger the paid transcript fetch. For a long video, the endpoint then returns 409 before reserving credits. The same one-credit user can repeat this sequentially—on the same or different long videos—without ever reaching a debit. The generation lease limits concurrency but not repeated sequential calls, and the confirmation retry fetches the transcript again by design. This leaves provider spend unbounded by the credit budget.
- **Fix**: Add a per-user transcript-attempt rate limit and issue a short-lived server-side confirmation quote/cache keyed to the user and normalized request so confirmation reuses the fetched transcript.
  - Strength: Bounds sequential abuse and removes the planned double fetch on confirmation while keeping the two-credit consent gate.
  - Tradeoff: Introduces state, expiry, storage limits, and invalidation rules on a latency-sensitive path.
  - Confidence: HIGH — every 409 currently occurs after transcript work and before any charge.
  - Blind spot: Actual Supadata billing/cache behavior and the appropriate rate window have not been measured.
- **Decision**: PENDING

### F18 — Editing during generation silently discards a paid successful result

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:97`
- **Detail**: Changing URL, character, or the long-video toggle increments `requestSeq` while the request continues server-side. When that request later returns, the stale branch discards every response, including HTTP 200. A summary may therefore be saved and charged while the UI shows neither the result nor the updated balance, encouraging a duplicate generation. The sequence guard correctly prevents stale 409 consent, but it is too broad for successful paid outcomes.
- **Fix A ⭐ Recommended**: Disable every quote-relevant input while `loading`, matching the repository's destructive-operation form pattern.
  - Strength: Small state model; the visible form remains identical to the request whose paid outcome will be shown.
  - Tradeoff: Users cannot prepare another URL during a potentially long transcript/LLM request, and `FormField` needs disabled-state support.
  - Confidence: HIGH — preventing input mutation makes the current sequence guard safe for all response classes.
  - Blind spot: Future programmatic input changes must also honor the loading lock.
- **Fix B**: Keep inputs editable, but always apply successful responses and credit balances while discarding only stale confirmation/error state; label the result with its submitted inputs.
  - Strength: Preserves editing during long requests without losing paid work.
  - Tradeoff: More UI state and a result can refer to a different URL than the currently edited form.
  - Confidence: HIGH — the client already holds the submitted URL and character snapshot.
  - Blind spot: The product needs a clear presentation for an old request completing beneath newly edited inputs.
- **Decision**: PENDING

### F19 — Lock-release transport errors can replace a valid endpoint response

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/generation-lock.ts:49`; `src/pages/api/summaries/generate.ts:98`
- **Detail**: `releaseGenerationLease` is documented as best-effort and “never throws,” but its `admin.rpc()` await is not wrapped in `try/catch`. A transport-level rejection propagates from the endpoint's `finally` and replaces the response returned by `runGeneration`. After a successful persist and debit, the user can receive a framework 500 and retry even though the summary was saved; the lock also remains until the stale sweep. The credit settlement/refund helpers already catch this same rejected-promise class.
- **Fix**: Wrap the entire release RPC call in `try/catch`, log the failure, and always resolve without throwing.
- **Decision**: PENDING

### F20 — Invalid YouTube URLs have no clear validation message

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence / Success Criteria
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:102`
- **Detail**: An invalid non-empty URL makes `submitDisabled` true, but the form renders no field error and uses `noValidate`, so the user only sees a silently disabled button. This misses Phase 6's contract and manual criterion 6.4 requiring invalid URLs to be blocked with a clear message. The reused `FormField` already supports an `error` prop.
- **Fix**: Pass a concise `error` to `FormField` whenever the URL is non-empty and `urlIsValid` is false.
- **Decision**: PENDING

### F21 — Phase contract and deployment secret count remain stale

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/changes/generate-and-save-summary/plan.md:336`; `README.md:278`
- **Detail**: The Phase 6 response contract still says every 500 maps to the persistence-specific “saving your summary” message, contradicting the accepted F14 behavior implemented in the client and documented later in Testing Strategy item 17. README also says to set “all four runtime secrets” immediately before listing five, including `SUPABASE_SERVICE_ROLE_KEY`.
- **Fix**: Update the Phase 6 500 mapping to distinguish generic pre-save failures from persistence failures, and change README's deployment count from four to five.
- **Decision**: PENDING
