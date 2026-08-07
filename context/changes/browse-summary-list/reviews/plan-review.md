<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Browse Summary List (S-02)

- **Plan**: `context/changes/browse-summary-list/plan.md`
- **Mode**: Deep
- **Date**: 2026-08-07
- **Verdict**: REVISE
- **Findings**: 1 critical, 5 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
| --- | --- |
| End-State Alignment | WARNING |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | FAIL |

## Grounding

Grounding: 8/8 paths ✓, 7/7 symbols ✓, brief↔plan ✓, Progress 31/31 ✓

The selected review skill's sibling `references/progress-format.md` was absent, so the matching canonical reference at `.claude/skills/10x-plan/references/progress-format.md` was used.

## Findings

### F1 — Nullable video embed cannot satisfy the DTO

- **Severity**: ⛔ CRITICAL
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Shared list DTO / List service
- **Detail**: The DTO requires non-null `youtubeId` and `url`, but the mapping contract also permits `videos: null` and says to render it as all-null metadata. A null embed contains neither value. The database actually guarantees a video through a non-null composite FK; historical "null metadata" means a present video whose descriptive columns are null (`supabase/migrations/20260613145120_videos_and_summaries.sql:4-13,34-42`).
- **Fix**: Require the embedded video at the mapping boundary and throw a read/data-integrity error if absent. Define null metadata as a present video with nullable descriptive fields.
- **Decision**: PENDING

### F2 — Phase 4 lacks a complete state-ownership contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 hook contract and Phase 4 refresh flow
- **Detail**: Phase 2 gives `SummaryList` ownership of list state, while Phase 4 says `DashboardSummaries` fetches and replaces that list. The plan also lacks a reactive submitted-attempt descriptor and a repeatable success event. The endpoint returns `summaryId`, but the current client discards it. A ref cannot drive pending-card rendering, and it is cleared before HTTP errors are handled (`src/components/summaries/GenerateSummaryForm.tsx:135-182`).
- **Fix ⭐ Recommended**: Make `DashboardSummaries` own `summaries`, refresh status and a refresh sequence guard. Have the hook expose a typed reactive attempt plus a monotonic success event carrying `summaryId`, URL and character; leave only filter state in `SummaryList`.
  - Strength: Gives all transitions and race handling one explicit owner.
  - Tradeoff: Expands the Phase 3/4 contracts and makes `SummaryList` controlled.
  - Confidence: HIGH — it follows React's existing lifted-state model.
  - Blind spot: None significant.
- **Decision**: PENDING

### F3 — Closing the dialog resets its visible inputs

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phase 3 — Form and dashboard island
- **Detail**: Radix unmounts dialog content when closed, while URL, character and `allowLong` remain local to the form (`src/components/summaries/GenerateSummaryForm.tsx:104-107`; `src/components/ui/dialog.tsx:37-54`). The request and confirmation survive in the hook, but reopening displays blank/default inputs beside the retained request or quote.
- **Fix**: Lift the quote-relevant form inputs into the persistent parent state and pass them to the form as controlled values.
  - Strength: Reopening accurately reflects the running or quoted attempt.
  - Tradeoff: The form becomes less self-contained.
  - Confidence: HIGH — the current dialog wrapper does not force-mount content.
  - Blind spot: The desired policy for clearing fields after success still needs stating.
- **Decision**: PENDING

### F4 — The ambiguous-network-retry invariant is not verified

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3 success criteria
- **Detail**: Preserving an idempotency key only across an ambiguous network failure is identified as a paid-path invariant, but no success criterion exercises it. Lint, build and normal generation cannot detect a regression that double-charges a retry.
- **Fix A ⭐ Recommended**: Add a deterministic manual fault-injection check that lets the first request commit but discards its response, retries, and verifies replay with no second credit charge.
  - Strength: Tests the real client/server contract without introducing a test framework.
  - Tradeoff: Manual setup must be documented precisely.
  - Confidence: HIGH — the endpoint already supports successful replay.
  - Blind spot: Remains non-automated.
- **Fix B**: Add focused hook tests with mocked `fetch` for network failure, HTTP failure, replay and stale success.
  - Strength: Repeatable regression coverage.
  - Tradeoff: Introduces the repository's first test runner.
  - Confidence: HIGH — these transitions are well suited to mocked responses.
  - Blind spot: Does not prove integration with the real idempotency ledger.
- **Decision**: PENDING

### F5 — Date rendering is under-specified

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Formatting helpers / Summary card
- **Detail**: The card promises both upload and creation dates, but only the upload-date helper is defined. Locale and timezone are also unspecified. Server and browser locale differences can cause hydration mismatches, while converting midnight UTC in a local timezone can shift a date-only value.
- **Fix**: Define formatting for both fields with an explicit locale and timezone; require UTC for `publishedAt` date-only rendering.
  - Strength: Deterministic SSR and hydration.
  - Tradeoff: Locks a locale until localization is introduced.
  - Confidence: HIGH — no existing repository formatting convention was found.
  - Blind spot: The preferred display locale is not documented.
- **Decision**: PENDING

### F6 — Read failures masquerade as an empty corpus

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 — Dashboard renders the list
- **Detail**: A database failure becomes `[]`, which then renders "generate your first summary." That incorrectly tells an existing user their summaries do not exist.
- **Fix**: Carry a `listUnavailable` state and render a reload/error message distinct from both empty states.
- **Decision**: PENDING

### F7 — Endpoint documentation becomes stale after the refactor

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 blast radius
- **Detail**: The generation endpoint explicitly references `GenerateSummaryForm.messageForStatus` (`src/pages/api/summaries/generate.ts:60-62`), but the plan moves that function without listing the endpoint comment as affected.
- **Fix**: Update the cross-file comment in `generate.ts` during Phase 3.
- **Decision**: PENDING
