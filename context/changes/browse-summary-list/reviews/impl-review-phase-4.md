<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Browse Summary List (S-02)

- **Plan**: `context/changes/browse-summary-list/plan.md`
- **Scope**: Phase 4 of 4
- **Date**: 2026-08-09
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 0 observations
- **Manual gate**: Pending by design; Progress items 4.3–4.8 remain unchecked

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING — 1 finding |
| Scope Discipline | PASS |
| Safety & Quality | WARNING — 2 findings |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING — automated checks pass; manual verification remains pending |

## Verification

- `npm.cmd run lint` — PASS. ESLint exited 0; only the existing `astro-eslint-parser` project-service notices were emitted.
- `npm.cmd run build` — PASS. The Astro SSR/Cloudflare production build exited 0; it emitted only the existing sitemap warning that `site` is not configured.
- Manual criteria 4.3–4.8 — PENDING. They are intentionally unchecked and were not treated as implementation defects.

## Findings

### F1 — Refresh completion can erase a newer generation

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/components/summaries/DashboardSummaries.tsx:64`
- **Detail**: `onSuccess` discards the success token, `refreshSummaries` accepts any array without confirming it contains `success.summaryId`, and a successful refresh unconditionally calls `generation.clearAttempt()` at line 102. If generation A succeeds, starts refresh A, and generation B starts before refresh A resolves, refresh A is still the latest refresh and clears B's live attempt. Separately, a successful response that does not yet contain A removes the pending card before a real A card exists. This breaks the plan's no-gap guarantee and leaves the planned `summaryId` contract unused.
- **Fix**: Bind each refresh to the success and attempt it consumes: pass the success token into `refreshSummaries`, require the returned list to contain `success.summaryId`, and make attempt clearing conditional on an immutable attempt identity.
  - Strength: Prevents an older refresh from erasing newer work and proves the replacement card exists before removing the pending one.
  - Tradeoff: Requires threading an attempt identity through the hook's attempt/success contract and conditional clear API.
  - Confidence: HIGH — the race follows directly from the independent request and refresh timelines, and `summaryId` currently has no Phase 4 consumer.
  - Blind spot: The rapid A-success/B-start timing has not yet been exercised manually.
- **Decision**: PENDING

### F2 — A committed summary is shown as still generating

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/DashboardSummaries.tsx:118`
- **Detail**: After generation succeeds, the attempt falls through to the `"generating"` status while the list refresh runs. If that refresh fails, the pending card keeps its spinner and says “Generating this summary…” while the adjacent note says the summary was saved. When the initial list was unavailable, `SummaryList` returns early without rendering the refresh-failure note, leaving only the perpetual spinner and the generic initial-read error.
- **Fix**: Add an explicit post-commit state such as `saved-awaiting-refresh`, render saved/refresh-failed copy without a spinner, and include the refresh-failure annotation in the `listUnavailable` branch.
  - Strength: Makes the UI reflect the actual paid-operation state and preserves the plan's best-effort refresh explanation in every list state.
  - Tradeoff: Adds one lifecycle state across `DashboardSummaries`, `SummaryList`, and `PendingSummaryCard`.
  - Confidence: HIGH — the current fallback status and early return make the contradictory states deterministic after a refresh failure.
  - Blind spot: Final wording and visual treatment have not been user-tested.
- **Decision**: PENDING

### F3 — Background lifecycle changes are not announced

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/PendingSummaryCard.tsx:46`
- **Detail**: The live card can change from generating to needs-confirmation or failed while the dialog is closed, and the refresh-failure note can appear asynchronously, but neither surface has live-region/status semantics. Screen-reader users may receive no announcement that generation now needs action or that the saved list failed to refresh.
- **Fix**: Give the lifecycle message a persistent `aria-live="polite"`/`role="status"` region with `aria-busy` while generating, and use alert semantics only for actionable failure while avoiding duplicate announcements.
- **Decision**: PENDING

## Review Summary

The planned pending-card states, list placement outside the character filter, same-origin re-read, monotonic refresh-response guard, retained list on refresh failure, and confirmation-dialog reopening are implemented. The extra `SummaryCard.tsx` change only exports the existing badge definitions for reuse, and the plan change is lifecycle bookkeeping; neither is scope creep. No security, XSS, authorization, destructive-data, performance, architecture, or React/Astro pattern violation was found. The implementation needs attention before the manual gate because refresh completion is not tied to the success/attempt it consumes, and two asynchronous UI states communicate misleadingly or not at all.
