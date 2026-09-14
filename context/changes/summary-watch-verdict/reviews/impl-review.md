<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Summary Watch Verdict Implementation Plan

- **Plan**: `context/changes/summary-watch-verdict/plan.md`
- **Scope**: Phases 1–3 of 3
- **Date**: 2026-09-14
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Findings

### F1 — A concurrent list refresh can overwrite a successful verdict

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/DashboardSummaries.tsx:194`
- **Detail**: `refreshSummaries` commits the complete GET result through `commitSummaries`, while `handleSetVerdict` writes the optimistic value only before its PATCH and performs no success-side state write. A generation-triggered GET can therefore read the old database value, then land after the optimistic update or after the PATCH response and replace the card with that stale value. `refreshSeq` orders GETs only, and the tombstone protects deletions only. PostgreSQL can hold the new verdict while the card shows the previous one until reload.
- **Fix**: Track a per-summary verdict mutation version and make a refresh preserve the current card value whenever its GET started before that mutation.
  - Strength: Extends the existing version/tombstone concurrency design and prevents stale GETs without another network request.
  - Tradeoff: Adds a small amount of mutation-version state plus a focused delayed-GET/delayed-PATCH regression test.
  - Confidence: HIGH — the conflicting writers and their ordering are explicit in this component.
  - Blind spot: The component has no current unit harness, so the most suitable focused test seam still needs to be chosen.
- **Decision**: PENDING

### F2 — Ten manual acceptance checks remain pending

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `context/changes/summary-watch-verdict/plan.md:281`
- **Detail**: Progress still has every manual row unchecked: Phase 1 has 2, Phase 2 has 1, and Phase 3 has 7. This includes the deliberate privilege-widening break, browser persistence, keyboard behavior, lock/rollback, cross-tab 404 removal, and responsive light/dark checks. The current automated suite cannot establish those claims, and the phase notes required human confirmation before advancing.
- **Fix**: Complete all ten manual checks, record observable evidence, and only then mark their Progress rows complete.
  - Strength: Closes the exact acceptance gaps the plan intentionally left outside automated coverage.
  - Tradeoff: Requires a human browser pass and a deliberate temporary database-policy break/revert.
  - Confidence: HIGH — the canonical Progress section marks all ten rows pending.
  - Blind spot: Some checks may already have been performed but were not recorded; no evidence is present in the change folder.
- **Decision**: PENDING

### F3 — The planned verdict-error clearing prop was omitted

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/components/summaries/SummaryCard.tsx:19`
- **Detail**: Phase 3 specified `onClearVerdictError(id)` on `SummaryCard` and forwarding through `SummaryList`, but neither interface includes it. The user-visible behavior is still present because `handleSetVerdict` clears that card's error atomically before starting the next PATCH (`DashboardSummaries.tsx:321-326`), so this is documentation/interface drift rather than a functional defect.
- **Fix**: Add an implementation note to the plan documenting that error clearing is owned atomically by `handleSetVerdict`, and that the redundant prop was intentionally omitted.
- **Decision**: PENDING

## Verification

| Command | Result | Evidence |
|---------|--------|----------|
| `npx.cmd supabase migration up` | PASS | Local database connected; no pending migrations; `Migrations applied`. |
| `npm.cmd test` | PASS | 17 files, 235 tests passed. |
| `npm.cmd run test:integration` | PASS | 11 files, 130 tests passed, including authorization, cross-account and PATCH DB coverage. |
| `npm.cmd run typecheck` | PASS | `tsc --noEmit` exited 0. |
| `npm.cmd run typecheck:astro` | PASS | 140 files; 0 errors, 0 warnings, 8 unrelated hints. |
| `npm.cmd run lint` | PASS | ESLint exited 0. |
| `npm.cmd run build` | PASS | Cloudflare server build completed successfully. |

Initial sandboxed Vitest/Astro attempts were blocked by filesystem permissions outside the workspace; each affected command was rerun outside the sandbox and passed. The untracked `packages/` directory pre-existed this review and was excluded from the implementation scope.
