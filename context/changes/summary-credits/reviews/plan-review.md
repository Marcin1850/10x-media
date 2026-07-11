<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Summary Credits Implementation Plan

- **Plan**: context/changes/summary-credits/plan.md
- **Mode**: Deep
- **Date**: 2026-07-11
- **Verdict**: REVISE → **SOUND** after triage (all 4 findings fixed 2026-07-11)
- **Findings**: 0 critical · 2 warnings · 2 observations — all FIXED

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

6/6 paths ✓ (probe.ts, summaries.ts, migration 20260613145120, supabase.ts, dashboard.astro, package.json), 3/3 symbols ✓ (`AppDatabase.Functions` = `Record<never,never>`, `upsertVideoAndAppendSummary`, `createClient`), brief↔plan ✓, delete-account cascade expectation ✓ (delete-account/plan.md confirms credits table cascade), Progress↔Phase mechanical contract ✓ (well-formed: one `## Progress`, all phases/criteria mapped). **PRD provenance ✗** — see F2.

Design spot-checks: `auth.uid()` resolves inside `SECURITY DEFINER` via the request JWT GUC (independent of definer ownership) — plan's claim holds. Spend-after-save means a thrown save (`upsertVideoAndAppendSummary`) never reaches spend → no charge on failure ✓. RLS read-only + no client increment → balance unforgeable ✓.

## Findings

### F1 — Gate is best-effort; a concurrent burst defeats the guardrail it exists to provide

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Implementation Approach + "What We're NOT Doing" (concurrency) + Open Risks
- **Detail**: The Overview names the threat as "runaway or accidental generation," but read-gate-then-spend is non-atomic with the two paid calls (Supadata + OpenRouter) in between. Under a concurrent burst the gate barely caps: balance 5 with 100 concurrent requests → all 100 gates read >0 → all pass → 100 paid generations → 5 spends succeed, 95 report insufficient. Net: 100 paid calls, 5 credits debited. The disclosed risk ("a couple of extra generations") is true only for a balance-1 double-fire, not the burst/runaway case the feature targets. Practical exposure is small at single-user/closed-registration MVP scale (hence WARNING not blocker), but the plan should state the real guarantee so a future multi-user reader doesn't over-trust it.
- **Fix A ⭐ Recommended**: Correct the disclosure, keep the design. Rewrite the concurrency note to state the true bound — "gate caps sequential overuse; a concurrent burst at balance N can trigger up to (requests) paid calls while debiting only N credits; accepted at single-user MVP scale, MUST be revisited before registration opens" — cross-linked to S-01.
  - Strength: Keeps "failures cost nothing" (the reason spend is after save) intact; zero code cost; honest ceiling.
  - Tradeoff: Exposure remains if registration opens without revisiting.
  - Confidence: HIGH — follows directly from the non-atomic gate/spend.
  - Blind spot: None significant.
- **Fix B**: Reserve-then-refund. Make the up-front gate the atomic `spend_credit()` decrement and add a service-role/definer restore on generation failure.
  - Strength: Truly caps paid work at the credit count even under a burst.
  - Tradeoff: Reintroduces an increment (refund) path — the exact thing the plan avoided to keep the balance unmintable; larger change.
  - Confidence: MED — sound in principle, but reopens the closed design question.
  - Blind spot: Refund authorization boundary unverified.
- **Decision**: FIXED (Fix A — corrected concurrency disclosure in plan.md + plan-brief.md)

### F2 — Plan cites a PRD "NFR cost guardrail" and "PRD wants no audit log" that don't exist

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Overview (line 5); "What We're NOT Doing" (line 35); plan-brief
- **Detail**: The plan grounds itself in "PRD NFR cost guardrail" (Overview) and justifies dropping the ledger with "(PRD wants no audit log)" (line 35). The PRD's Non-Functional Requirements section (prd.md:70) has exactly two items — desktop browser support and data privacy. No cost/budget guardrail NFR, no credits, no audit-log mention anywhere in the PRD. The feature is legitimately grounded in roadmap S-05, but the citation chain (roadmap S-05 "PRD refs: NFR (cost guardrail)" → brief → plan) propagated an unsupported PRD attribution. The "no ledger because PRD wants no audit log" reasoning is hollow; the real reason is MVP simplicity.
- **Fix**: Reattribute to roadmap S-05 (and the OpenRouter-budget intent), not a PRD NFR. Change line 35's justification from "(PRD wants no audit log)" to "(MVP simplicity — no audit requirement exists)". Same one-line fix in plan-brief. Optionally correct roadmap S-05's "PRD refs".
- **Decision**: FIXED (Fix in plan — reattributed to roadmap S-05 in plan.md + plan-brief.md; roadmap S-05 "PRD refs" left as a follow-up)

### F3 — Post-save spendCredit DB-error behavior unspecified

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 §3 (enforce in generation endpoint)
- **Detail**: The plan handles the "insufficient" sentinel post-save (report `creditsRemaining: 0`, keep content) but says `spendCredit` reserves throws for "genuine DB errors" without saying what probe.ts does if that throw happens after a successful save. probe.ts has no try/catch, so a thrown post-save spend → 500 even though the summary is persisted and no credit was debited — user sees an error, then retries for a free second generation.
- **Fix**: Specify that a post-save spend failure is logged and the response still returns 200 with the summary (`creditsRemaining` falling back to the pre-spend balance or a re-read), never a 500 after a successful save.
- **Decision**: FIXED (Fix in plan — added post-save spend-error clause to Phase 2 §3 contract)

### F4 — Migration DDL drops the house idempotency style

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 1 §1–3 (contracts)
- **Detail**: The existing migration (20260613145120) uses `create table if not exists` and `drop policy if exists … / create policy …` throughout. The Phase 1 contracts use bare `create table` / `create policy` / `create function`. Harmless on a clean apply, but inconsistent with the one migration pattern in the repo.
- **Fix**: Match house style — `create table if not exists`, `drop policy if exists` before `create policy`, and `create or replace function` for the two functions.
- **Decision**: FIXED (Fix in plan — idempotent DDL applied to Phase 1 §1–3; also `drop trigger if exists` before the trigger)
