<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Browse Summary List (S-02)

- **Plan**: `context/changes/browse-summary-list/plan.md`
- **Scope**: Phase 4 of 4
- **Date**: 2026-08-09
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 0 observations (+1 warning added during triage — see F4)
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
- **Decision**: FIXED — applied with the retry variant. `GenerateAttempt` now carries an immutable `id` (the installing request's `requestSeq`), `LastSuccess` carries the matching `attemptId`, and `clearAttempt(attemptId?)` clears via a functional update only when the live attempt still matches. `refreshSummaries(success)` re-reads up to 3 times (`REFRESH_RETRY_DELAYS_MS = [250, 750]`) until the list contains `success.summaryId`; any list it obtains still lands, but the pending card is retired only once the saved row is proven present. `onPendingDismiss` is wrapped so the click event is not passed as an attempt id. `npm run lint` passes.

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
- **Decision**: FIXED — `PendingSummary.status` gained `saved` and `saved-refresh-failed`, derived in `DashboardSummaries` from `lastSuccess.attemptId === attempt.id` (the F1 identity) crossed with `refreshFailed`. `saved` keeps a spinner but says "Summary saved — adding it to your list…"; `saved-refresh-failed` drops the spinner, uses the amber of the refresh note, and says "Summary saved. Reload the page to see it in your list." `SummaryList` now renders `refreshNote` in the `listUnavailable` branch as well. `npm run lint` passes.

### F3 — Background lifecycle changes are not announced

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/PendingSummaryCard.tsx:46`
- **Detail**: The live card can change from generating to needs-confirmation or failed while the dialog is closed, and the refresh-failure note can appear asynchronously, but neither surface has live-region/status semantics. Screen-reader users may receive no announcement that generation now needs action or that the saved list failed to refresh.
- **Fix**: Give the lifecycle message a persistent `aria-live="polite"`/`role="status"` region with `aria-busy` while generating, and use alert semantics only for actionable failure while avoiding duplicate announcements.
- **Decision**: FIXED — the generating / saved / saved-refresh-failed / needs-confirmation messages now live in one always-mounted `role="status" aria-live="polite" aria-atomic="true"` region on `PendingSummaryCard`, with `aria-busy` set while generating or awaiting the refresh. The failure message carries `role="alert"` and sits outside that region so it is announced once; the dismiss button stays outside the alert. The list's refresh note was left without live semantics on purpose — the card's `saved-refresh-failed` message already announces the same fact, and both would double-announce. `npm run lint` and `npm run build` pass.

## Triage (2026-08-09)

All findings fixed, including F4 raised during the triage itself. Verification after the fixes: `npm run lint` PASS, `npm run build` PASS.

| Finding | Decision |
|---------|----------|
| F1 | FIXED — attempt identity + `summaryId` confirmation, with a bounded retry on the re-read |
| F2 | FIXED — explicit `saved` / `saved-refresh-failed` card states; refresh note in the unavailable branch |
| F3 | FIXED — persistent polite status region; alert semantics for the failure only |
| F4 | FIXED — `refreshFailed` boolean replaced by the identity of the unlisted summary (added during triage) |

Files touched: `src/components/hooks/useGenerateSummary.ts`, `src/components/summaries/DashboardSummaries.tsx`, `src/components/summaries/PendingSummaryCard.tsx`, `src/components/summaries/SummaryList.tsx`.

Manual criteria 4.3–4.8 remain the open gate. Three scenarios are worth exercising there specifically: the F1 A-success/B-start race, the new saved-state copy, and the F4 sequence — fail one re-read, start a second generation, and confirm the note keeps naming the first video until a list actually shows it.

## Review Summary

The planned pending-card states, list placement outside the character filter, same-origin re-read, monotonic refresh-response guard, retained list on refresh failure, and confirmation-dialog reopening are implemented. The extra `SummaryCard.tsx` change only exports the existing badge definitions for reuse, and the plan change is lifecycle bookkeeping; neither is scope creep. No security, XSS, authorization, destructive-data, performance, architecture, or React/Astro pattern violation was found. The implementation needs attention before the manual gate because refresh completion is not tied to the success/attempt it consumes, and two asynchronous UI states communicate misleadingly or not at all.

## Findings added during triage

Raised after the report was written, while fixing F1–F3. Kept here rather than folded into the list above so the record of what the review itself caught stays honest.

### F4 — A boolean `refreshFailed` loses the summary it was raised for

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/DashboardSummaries.tsx:42`
- **Detail**: `refreshFailed` is a bare boolean, so it records *that* a re-read failed but not *which* saved summary is missing from the list. Two consequences, both of which end with a paid summary in neither place. (1) A later generation's successful re-read sets it back to `false` after proving only its **own** row landed — the earlier orphan is declared resolved without ever being seen in a list, and its card is long gone because a newer attempt replaced it. (2) While that newer generation is in flight, the note above the list still says "your summary was saved" while the only card on screen belongs to a different video, so the sentence reads as being about work that is still running. Note that a naive fix — clearing `refreshFailed` when a new generation starts — makes (1) strictly worse: the note is the *only* remaining trace of the orphaned summary once its card has been replaced.
- **Fix**: Replace the boolean with the identity of the unlisted summary (`{ summaryId, url }`). Retire it only when some list actually contains that id — including a list read for a different success — and name the URL in the note so it stands on its own regardless of which card is on screen.
  - Strength: Restores the no-gap guarantee for the one case F1's fix does not cover, and removes the note's implicit "this card" attribution without inventing new copy semantics.
  - Tradeoff: `SummaryList`'s prop changes from a boolean to a nullable object; the note gains a URL and gets longer.
  - Confidence: HIGH — the boolean provably cannot distinguish "this summary landed" from "the summary I was raised for landed".
  - Blind spot: Only one orphan is tracked; two consecutive failed re-reads name the newer summary in the note. The next successful read surfaces both rows anyway, so the loss is the mention, not the data.
- **Decision**: FIXED — `refreshFailed: boolean` replaced by `unlisted: UnlistedSummary | null` (`{ summaryId, url }`, exported from `SummaryList.tsx`). A re-read that does not produce its own row installs that success as the orphan; an existing orphan is retired only by a list that actually contains its id, including one read for a different success. The card's `saved-refresh-failed` state now comes from `committedUnlisted` (orphan id === the committed success's id) rather than from "a refresh failed at some point", and the list note names the video: "We saved your summary of &lt;url&gt;, but couldn't refresh this list." `npm run lint` and `npm run build` pass.
