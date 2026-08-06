<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Transcript Cost Guardrail

- **Plan**: `context/changes/transcript-cost-guardrail/plan.md`
- **Scope**: Phase 3 of 7
- **Date**: 2026-08-02
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Optional `requestId` bypasses refusal billing

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.ts:96`
- **Detail**: The public request schema still accepts an omitted `requestId`, and `refuseAndCharge` deliberately skips the debit in that case (`generate.ts:231-248`). The current React client always sends `crypto.randomUUID()`, but any authenticated caller can omit the field and repeatedly exercise a paid, fresh `unavailable` transcript path without paying the Phase 3 app-credit charge. The implementation matches the plan's pre-F22 compatibility clause, but that clause makes D14 best-effort at the API trust boundary rather than enforced.
- **Fix**: Require `requestId` in `generateSchema` before Phase 7 deploy and record the compatibility decision as a plan addendum.
  - Strength: Closes the billing bypass at the only trustworthy boundary; the current first-party client already always sends a UUID.
  - Tradeoff: An old open tab or cached pre-F22 client will receive a validation error until refreshed.
  - Confidence: HIGH — the only current first-party call site always includes `requestId`.
  - Blind spot: No telemetry was available to quantify active unkeyed clients.
- **Decision**: FIXED — `requestId` is now required in `generateSchema` (`generate.ts:96`), `runGeneration` receives it unconditionally, and the pre-F22 compatibility clause is superseded by a dated addendum in `plan.md`. The null-tolerant internal branches were kept as a safety net. Lint passes.

### F2 — Broad `unique_violation` handler can misreport unrelated integrity failures as replay

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260731110000_charge_failed_transcript.sql:176`
- **Detail**: The concurrency adaptation correctly catches the intended partial-index race, but it catches every `unique_violation` raised anywhere in the protected block and immediately returns `replay`. A future unique constraint, trigger failure, or extremely unlikely reservation-ID collision would therefore be reported as a valid replay even when no matching non-refunded `(user_id, request_id)` row exists. The statement-level rollback protects the user's balance, but the service loses the distinction between a real replay and unrelated data-integrity failure.
- **Fix**: In the handler, re-query the exact non-refunded `(user_id, request_id)` row and return `replay` only when it exists; otherwise re-raise the original exception.
- **Decision**: FIXED — the `unique_violation` handler now re-reads the key and `raise`s when no non-refunded row exists. Verified on the local DB: a genuine two-session race still returns `replay` with the balance untouched, while an unrelated unique violation (temporary partial index) now propagates as the real integrity error instead of a silent `replay`.

### F3 — Change handoff retains obsolete five-phase routing

- **Severity**: OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: `context/changes/transcript-cost-guardrail/change.md:60`
- **Detail**: The notes correctly say the plan now has seven phases at line 40, but later say Phase 5 is the deploy gate and that the phase count is five, with the reservation ledger as Phase 3 (`change.md:60,77-80`). The current plan assigns refusal charging to Phase 3, the reservation ledger to Phase 5, breaker wiring to Phase 6, and deploy to Phase 7. This contradictory durable handoff can route a later agent to the wrong phase or deploy gate.
- **Fix**: Mark the five-phase note as superseded and update the stale deploy reference to Phase 7.
- **Decision**: FIXED — `change.md:60` now names Phase 7 as the single deploy gate, and the "Phase count is now 5" paragraph is struck through and marked SUPERSEDED with the corrected Phase 5/6/7 mapping.

## Verification

- `npm.cmd run lint` — PASS. ESLint exited 0; only the existing `astro-eslint-parser` project-service notices were emitted.
- `npm.cmd run build` — PASS. Astro SSR/Cloudflare build completed successfully; the existing missing-`site` sitemap warning remains.
- `npx.cmd supabase migration up` — PASS. The local database reported no pending migrations (`applied: []`).
- Grants/schema assertions — PASS. Both RPCs are executable only by `service_role` and the owner role; `refusal_reason` is nullable and CHECK-constrained to `unavailable`, `empty`, or `whitespace`.
- Rollback-only SQL assertions — PASS. The first call charged once, the same key replayed without another decrement, `get_refusal_replay` returned the stored reason, an operator-style row without a reason returned null, and a zero balance returned `insufficient` without writing a row.
- Call-site assertion — PASS. Exactly four 422 exits call `refuseAndCharge`; the fresh transient `failed`/`timeout` exit remains uncharged.
- Manual criteria 3.9–3.15 remain intentionally pending. The user explicitly deferred manual verification for this review; no manual result was inferred or rubber-stamped.

## Scope Notes

- Commit `6a62cf1` changes the three planned implementation files plus `plan.md` and `change.md`; no unplanned product surface was added.
- The `unique_violation` concurrency adaptation is justified, documented scope rather than drift: `select … for update` cannot lock a missing key, so the existing partial unique index must arbitrate simultaneous first inserts.
- The current working-tree-only `plan.md` change adds the closing SHA to completed automated rows and was preserved.
