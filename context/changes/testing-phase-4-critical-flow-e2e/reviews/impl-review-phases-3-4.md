<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Critical-flow e2e (test-plan Phase 4)

- **Plan**: `context/changes/testing-phase-4-critical-flow-e2e/plan.md`
- **Scope**: Phases 3-4 of 5 (plus Phase 0)
- **Date**: 2026-09-09
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — Testing Strategy still promises the dropped transient-refusal case

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/changes/testing-phase-4-critical-flow-e2e/plan.md:926`
- **Detail**: Phase 3's accepted ruling removes the transient `failed`/`timeout` 422 from e2e because it is not browser-reachable without a real vendor call. The phase body, `change.md`, `plan-brief.md`, and `test-plan.md` all record that gap, but the later E2E Testing Strategy still lists “transient refusal: no-charge line + unmoved balance (Phase 3)” as delivered. The implementation correctly contains only the two charged refusal cases; this is an internal contradiction in the plan, not missing code.
- **Fix**: Replace the transient-refusal claim with the two charged causes and state that the uncharged transient remains integration-only.
- **Decision**: PENDING

### F2 — Changing the quoted URL leaves the abandoned card looking like active work

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `tests/e2e/long-video-confirmation.spec.ts:250`
- **Detail**: The transferability case verifies that editing the URL removes the priced submit, then immediately submits the second video. It never verifies the state of the first video's card between those actions. `inputsChanged()` clears `confirm` but leaves `attempt` (`src/components/hooks/useGenerateSummary.ts:415-424`); the pending-state derivation then maps an attempt with no loading, confirmation, error, or committed result back to `"generating"` (`src/components/summaries/DashboardSummaries.tsx:303-325`). The UI can therefore claim that the abandoned first video is still generating even though no request is active. The second submit replaces the attempt and masks this state, so the new spec passes against the misleading UI state.
- **Fix A ⭐ Recommended**: Clear the current attempt when `inputsChanged()` invalidates the quoted/requested inputs, and assert that the old video's article disappears before the second submit.
  - Strength: Aligns displayed state with the hook's explicit decision to drop advisory outcomes for abandoned inputs, and gives the e2e scenario an observable assertion at the exact transition it introduces.
  - Tradeoff: Changes shared hook behavior; unit coverage should pin what happens when an in-flight response arrives after the attempt was cleared.
  - Confidence: HIGH — the current state derivation deterministically produces the phantom `generating` card.
  - Blind spot: The desired UX for an abandoned request that later reports a new balance should be confirmed; balance synchronization currently happens independently above the staleness guard.
- **Fix B**: Make the pending-card derivation return no card when an attempt has no active or terminal outcome, and add the same e2e assertion.
  - Strength: Localizes the change to presentation and preserves the attempt as internal request bookkeeping.
  - Tradeoff: Leaves stale attempt state alive and may hide a future malformed no-outcome response instead of surfacing it explicitly.
  - Confidence: MEDIUM — it fixes the visible symptom but not the contradictory state that creates it.
  - Blind spot: Other consumers of `generation.attempt` were not exhaustively audited.
- **Decision**: PENDING

### F3 — Runner documentation still describes the unsafe pre-review server mode

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: `context/changes/testing-phase-4-critical-flow-e2e/plan-brief.md:24`; `context/foundation/test-plan.md:300`
- **Detail**: The accepted Phases 1-2 review ruling requires a built `preview` locally and in CI with `reuseExistingServer: false`, specifically to fail closed rather than reuse a developer server carrying real vendor configuration. `plan-brief.md` still says “dev locally, built preview in CI”. The e2e cookbook correctly states the new runner mode at lines 289-294, but its waits paragraph still attributes the timeout to first-request compilation under `astro dev`. These stale explanations are substantive because they describe the safety boundary future contributors are expected to preserve, and `lessons.md` requires derived docs to stay synchronized with plan changes.
- **Fix**: Update the brief to “built preview everywhere, never reused” and replace the `astro dev` timeout rationale with the actual preview/workerd plus real-database latency rationale (or remove the unsupported rationale while retaining the measured limits).
- **Decision**: PENDING

### F4 — Successful long-video generation does not assert the reservation is not a refusal

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `tests/e2e/long-video-confirmation.spec.ts:189`
- **Detail**: Phase 3 extends `ReservationRow` with `refusalReason` and documents that ordinary `begin_generation` rows must carry `null`, while refusal specs assert concrete causes. The Phase 4 success case uses `objectContaining({ amount, status })`, so it would remain green if a normal generation row were incorrectly classified with a refusal reason. The rest of the Phase 4 oracle is strong and this does not currently break the user flow, but the new semantic field is not asserted symmetrically across the two flow types.
- **Fix**: Add `refusalReason: null` to the successful long-video reservation expectation.
- **Decision**: PENDING

## Verification

### Automated

- PASS — `npm run typecheck`
- PASS — `npm run lint`
- PASS — `npm run test:e2e` (5 tests)
- PASS — `npm run test:e2e -- tests/e2e/charged-refusal.spec.ts --repeat-each=2` (4 tests)
- PASS — `npm run test:e2e -- tests/e2e/long-video-confirmation.spec.ts --repeat-each=2` (4 tests)
- PASS — port 4321 was free before the e2e server started and free again after each run

The e2e runs emitted the existing Wrangler warning that no `[env.e2e]` block exists, while explicitly loading `.dev.vars.e2e`; it did not fail or change the verified outcomes.

### Manual evidence

- Phase 3 items 3.4-3.6 and Phase 4 items 4.4-4.6 are checked in `## Progress` and backed by detailed deliberate-break records in each phase's `Added during implementation` section.
- No `test.skip` or `test.fixme` remains in the reviewed specs.
- The diff respects the documented exclusions: no sign-in, ambiguous-charge, Firefox, component-rendering, RLS/cross-account, snapshot, or pixel coverage was added.
