<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Transcript Cost Guardrail Implementation Plan

- **Plan**: `context/changes/transcript-cost-guardrail/plan.md`
- **Scope**: Phase 6 of 7
- **Date**: 2026-08-05
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Stale sweep can erase billed-but-unsettled spend

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260731150000_supadata_budget.sql:328`
- **Detail**: `reserve_supadata_credits` deletes an unsettled reservation once its operation ceiling has elapsed. A Worker can die after Supadata billed the call but before `generate.ts` reaches its settlement `finally`; the stored `/v1/me` reading can therefore predate real spend that the sweep then removes from the local delta. Until a later successful refresh anchors that spend, the breaker can authorize against an understated balance. During a `/v1/me` outage the omission can persist indefinitely. The 600-second ceiling proves the call is no longer running, not that it was free.
- **Fix**: Convert stale unsettled rows to settled-with-unknown (`actual_credits = null`) so they continue counting at their reserved maximum until a successful authoritative refresh supersedes them.
  - Strength: Preserves the plan's pessimistic treatment of unknown billing and closes the dead-Worker accounting gap.
  - Tradeoff: During a prolonged `/v1/me` outage, unknown rows can conservatively consume budget and eventually refuse otherwise affordable work.
  - Confidence: HIGH — the current delete predicate does not establish whether the vendor billed, while the existing accounting already defines null actual credits as reserved maximum.
  - Blind spot: The replacement state transition and refresh pruning need SQL assertions, including a Worker-death simulation and concurrent reserve.
- **Decision**: PENDING

### F2 — Refresh failure paths skip the vendor-rate spacing

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/supadata-budget.ts:456`
- **Detail**: The only `RETRY_DELAY_MS` wait is at line 499, after both `/v1/me` and `save_supadata_budget` succeed. A non-2xx or malformed `/v1/me` response, a timeout, a save failure, or a lost claim returns `untracked` at lines 460 or 471 without waiting; both endpoint call sites then proceed directly to paid Supadata work. This contradicts Phase 6's conservative shared-rate-bucket assumption and can turn a breaker degradation into `limit-exceeded` on the paid request.
- **Fix**: After a refresh claimant attempts `/v1/me`, pass every proceed/untracked exit through one shared `RETRY_DELAY_MS` barrier, and remove the success-only wait.
- **Decision**: PENDING

### F3 — Warn events omit the local spend delta

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: `src/lib/services/supadata-budget.ts:479`
- **Detail**: The warning is evaluated from `reading.usedCredits` alone and emits `outstanding: null`, even though D5a and the Phase 6 contract require a self-sufficient event containing the local delta since the reading. For example, vendor usage at 79/100 with two outstanding credits neither warns nor explains the effective usage. Stop decisions remain safe, and D5b deliberately defers the receiver, so this is not currently safety-critical.
- **Fix**: Evaluate and emit the refresh-cadenced warning after the second locked reserve result, using its complete `used`, `max`, `outstanding`, and `readAt` statistics and an explicit rule for whether the newly authorized reservation is included.
  - Strength: Makes the event self-sufficient from one coherent locked state without adding a racing follow-up query.
  - Tradeoff: Moves warning evaluation after the second pass and requires pinning whether the current reservation contributes to the 80% threshold.
  - Confidence: HIGH — the current payload explicitly serializes the required delta as null.
  - Blind spot: No receiver exists yet, so end-to-end alert rendering cannot be verified in this phase.
- **Decision**: PENDING

## Verification Evidence

- `npm.cmd run lint` — **PASS**. ESLint exited 0; `astro-eslint-parser` emitted its existing `projectService` compatibility notices.
- `npm.cmd run build` — **PASS**. Astro SSR/Cloudflare build completed; sitemap emitted the existing missing-`site` warning.
- Sweep-window source — **PASS**. `src/lib/services/supadata-budget.ts` passes `RESERVATION_STALE_SECONDS` as `p_stale_seconds`; `20260731150000_supadata_budget.sql` contains no duplicated 600-second policy value.
- Settlement structure — **PASS**. Both paid operations settle from `finally` and only under `outcome === "reserved"`; the transcript rate-limit 500/429 exits additionally settle known-zero work before returning.
- Meter reducer — **PASS**. A direct `createSupadataMeter` harness returned `{retry:2, other:9, unknown:null, empty:0, nonDestructive:true, checkpointExcluded:true}`.
- Result contract — **PASS**. `ReserveBudgetResult` is the planned `reserved | refused | untracked` union, and `untracked` call sites never attempt settlement.
- Manual rows 6.8–6.17 — **PENDING BY DESIGN**. Per user instruction, the missing manual pass is acknowledged and is not a finding or failure. No temporary `BUDGET_STOP_RESERVE` override was applied.
- Deploy-window concerns — **EXCLUDED BY USER INSTRUCTION**.

## Scope Notes

- Commit `01b0f34` changed exactly the five planned source files plus the change documentation.
- The later claim-ID/database-clock update in `8e53d34` is documented safety-improving drift from the original caller-timestamp prose, not a defect. The same commit's known-zero settlement on pre-fetch 500/429 exits is corrective, in-scope extra work.
- No planned source change is missing, and the “What We're NOT Doing” boundaries remain intact.
