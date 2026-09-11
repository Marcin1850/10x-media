<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Browse Summary List (S-02)

- **Plan**: `context/changes/browse-summary-list/plan.md`
- **Mode**: Deep
- **Date**: 2026-08-07
- **Verdict**: REVISE → **SOUND** after triage (2026-08-07)
- **Findings**: 1 critical, 5 warnings, 1 observation — all 7 fixed in `plan.md`

## Triage summary (2026-08-07)

All seven findings were fixed in the plan. Two were adjusted during triage rather than applied as written:

- **F5** — the proposed fix pinned an explicit `Intl` locale. Triage replaced it with locale-free `YYYY-MM-DD` from UTC parts, which removes the SSR/hydration mismatch class outright instead of managing it. Triage also established that the card's creation date traces to no upstream source (PRD FR-006, roadmap S-08 outcome, and the `plan-brief.md:30` card-fields decision all omit it). It was kept as a deliberate addition — it disambiguates the same video summarized under both characters — and `plan.md` now records that explicitly, along with the accepted cost that a late-evening local generation displays the previous UTC day.
- **F4** — Fix A (manual fault injection) chosen over Fix B (mocked-fetch hook tests); a full procedure is now in the plan's Testing Strategy, using a server kill after the commit log line so the ambiguity is deterministic rather than a raced DevTools toggle.

Two new verification criteria were added (2.10 forced-read-failure state, 3.9 ambiguous-network-retry) and criterion 3.7 was widened to cover input preservation. Progress↔Phase contract re-verified after the edits: 6/10/9/8 = 33 criteria against 33 checkboxes, headings matching, no stray checkboxes outside `## Progress`.

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
- **Decision**: FIXED

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
- **Decision**: FIXED

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
- **Decision**: FIXED — clearing policy stated: clear on success only.

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
- **Decision**: FIXED via Fix A

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
- **Decision**: FIXED (adjusted) — both helpers specified as locale-free `YYYY-MM-DD` from UTC parts rather than a pinned `Intl` locale, which removes the hydration-mismatch class entirely instead of managing it. Triage also established that the creation date appears in no upstream source (PRD FR-006, roadmap S-08, `plan-brief.md:30` card-fields row); it is kept, and the plan now records it as a deliberate addition beyond the brief.

### F6 — Read failures masquerade as an empty corpus

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 — Dashboard renders the list
- **Detail**: A database failure becomes `[]`, which then renders "generate your first summary." That incorrectly tells an existing user their summaries do not exist.
- **Fix**: Carry a `listUnavailable` state and render a reload/error message distinct from both empty states.
- **Decision**: FIXED

### F7 — Endpoint documentation becomes stale after the refactor

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 3 blast radius
- **Detail**: The generation endpoint explicitly references `GenerateSummaryForm.messageForStatus` (`src/pages/api/summaries/generate.ts:60-62`), but the plan moves that function without listing the endpoint comment as affected.
- **Fix**: Update the cross-file comment in `generate.ts` during Phase 3.
- **Decision**: FIXED
