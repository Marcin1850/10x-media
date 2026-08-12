<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: App Design System — Step 4 Implementation Plan

- **Plan**: `context/changes/app-design-system/plan.md`
- **Scope**: Phases 4–6 of 9
- **Date**: 2026-08-12
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 7 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Verification Evidence

### Automated

- `npm.cmd run lint` — **PASS**. ESLint exits 0. The existing `astro-eslint-parser` notice about treating `projectService` as `project: true` remains.
- `npm.cmd run build` — **PASS**. Astro completed the Cloudflare SSR build and copied four font assets. Existing warnings remain: inspector port 9229 was unavailable and sitemap generation was skipped because `site` is unset. The first sandboxed attempt could not create Astro's user-level telemetry directory; the approved retry passed.
- `git grep -nE "(bg|text|border)-(white|blue|purple|red)-?" -- src/components/auth src/pages/auth` — **PASS**. No matches.
- `git grep -n "CHARACTER_LABEL" -- src` — **PASS**. One declaration in `SummaryCard.tsx`, two render/import consumers, and the two filter-value reads.
- `git grep -n "ui/dialog" -- src/components/summaries` — **PASS**. No matches.
- `git diff --check 30394e9^..64b0f57` — **PASS**.

### Manual

Intentionally pending, as requested. None of the unchecked rows is treated as rubber-stamped or as a defect merely because it is open:

- [ ] Phase 4: three auth screens render in Polish on the at-rest slot.
- [ ] Phase 4: validation errors render in the error slot with correct plurals.
- [ ] Phase 4: password generation works with the password visible and hidden.
- [ ] Phase 4: a server error renders in the error slot.
- [ ] Phase 4: pending state shows and the form cannot be double-submitted.
- [ ] Phase 5: all four list states render and remain mutually exclusive.
- [ ] Phase 5: read-failed never claims the list is empty.
- [ ] Phase 5: the reading measure and leading are correct.
- [ ] Phase 5: both badges remain distinguishable in greyscale.
- [ ] Phase 5: expand/collapse, stretched header target and focus ring work.
- [ ] Phase 6: short-video generation proceeds pending → saved → real card.
- [ ] Phase 6: cold cost gate renders and confirms at the quoted price.
- [ ] Phase 6: pre-authorisation skips the gate.
- [ ] Phase 6: amber appears only on the cost gate.
- [ ] Phase 6: failed generation renders the error slot and is dismissable.
- [ ] Phase 6: zero/unknown credit states render and behave correctly.
- [ ] Phase 6: navigation away loses the pending card but not the credit.

The Success Criteria verdict is WARNING rather than FAIL: every automated gate passes and the manual gate is deliberately open. F1 and F4 provide concrete reasons to expect two manual rows to fail in the current implementation; F3, F6 and F7 identify additional cases that need deliberate browser coverage.

## Findings

### F1 — Auth forms do not enter the pending state

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `src/components/auth/SubmitButton.tsx:11`, `src/components/auth/SignInForm.tsx:44`, `src/components/auth/SignUpForm.tsx:66`
- **Detail**: `SubmitButton` derives `pending` from React's `useFormStatus()`, but both auth forms use ordinary string `action` URLs and native navigation. The installed React 19 implementation starts the host form transition for a function action, or for an already-prevented submit inside a transition; these valid native submissions do neither. The button therefore stays enabled with its normal label until navigation, so manual criterion 4.7's pending state and double-submit protection are not provided. This behavior existed before Phase 4, but Phase 4 explicitly retains and claims the pending state as a success criterion.
- **Fix**: Own a `submitting` boolean in each auth form, set it only after validation succeeds, and pass it to `SubmitButton` as the disabled/pending source.
  - Strength: Preserves the current native POST endpoints while making the lifecycle explicit, matching the pattern used by other async forms in the repository.
  - Tradeoff: The state cannot recover from a server response without navigation; that is acceptable for these native POSTs, but network failures before navigation need browser verification.
  - Confidence: HIGH — the installed React source and the current string-action form markup establish the behavior directly.
  - Blind spot: The browser pass is still needed to verify autofill and native validation interactions.
- **Decision**: FIXED — `SubmitButton` now takes an explicit `pending` prop; `SignInForm`/`SignUpForm` own a `submitting` boolean set after successful validation and passed through.

### F2 — Field errors are not programmatically connected to their inputs

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/auth/FormField.tsx:46`
- **Detail**: Inputs receive `aria-invalid`, but neither errors nor hints have stable IDs and the input has no `aria-describedby`. Newly inserted errors also have no alert/live semantics, and validation leaves focus on the submit button. The visual destructive slot is correct, but assistive-technology users are not told which message belongs to which field after a rejected submit.
- **Fix**: Give the hint/error a stable ID, bind it with `aria-describedby`, announce newly created errors, and focus the first invalid field after submit.
  - Strength: Makes the existing validation usable without changing its rules or server behavior.
  - Tradeoff: Requires a small focus contract between `FormField` and each form rather than a CSS-only edit.
  - Confidence: HIGH — the missing relationships are directly visible in the rendered attributes.
  - Blind spot: The exact announcement timing should be checked with a screen reader.
- **Decision**: FIXED — `FormField` now assigns stable `id`s to the error/hint node and wires `aria-describedby`; the error paragraph is `role="alert"`. Both auth forms focus the first invalid field's input (via `inputRef`) when validation fails.

### F3 — Character radios have no visible keyboard focus

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:112`
- **Detail**: The native radio inputs are `sr-only`, while their visible labels style selection and hover only. Keyboard users can move between the radios but receive no visible focus indicator, unlike the explicit focus-ring treatment on summary-card expansion and shadcn controls elsewhere.
- **Fix**: Add a label-level `:has(input:focus-visible)` ring treatment (or add the shadcn radio-group primitive via the prescribed CLI and use its focus behavior).
- **Decision**: FIXED — added `has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50` to the label, matching the `input.tsx`/`button.tsx` focus-ring pattern.

### F4 — Dismissing a failed pending card leaves the same error visible

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `src/components/summaries/DashboardSummaries.tsx:242`, `src/components/summaries/GenerateSummaryForm.tsx:169`
- **Detail**: The pending card's dismiss action calls only `generation.clearAttempt()`. `generation.error` is not cleared and the capture form renders that same error through `ServerError`, so the failure disappears from the card but remains immediately above it. Manual criterion 6.7 says the failed generation is dismissable; the current action only dismisses one of two copies.
- **Fix**: Expose an attempt-bound failure clear that removes both the matching attempt and its error, then use it for the dismiss action; alternatively make the pending card the sole owner of request errors.
- **Decision**: FIXED — `clearAttempt` now also clears `error`, guarded by `attemptSeq.current` so a stale attemptId (from the post-success refresh path) is a no-op and never clears a newer, still-live attempt's error.

### F5 — A malformed successful response can leave a paid attempt “generating” forever

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/hooks/useGenerateSummary.ts:237`, `src/components/summaries/DashboardSummaries.tsx:194`
- **Detail**: The client type-asserts the JSON body rather than validating it. Any `2xx` response is treated as a paid success, but a missing/non-string `summaryId` returns before raising `lastSuccess`; the Phase-6 pending derivation then deliberately falls back to `generating`. Before Phase 6, the separate result block could still show the returned body; after that block was removed, this contract failure has no terminal UI and no list re-read. This is a reliability risk at a paid boundary even though the current endpoint normally honors the shape.
- **Fix**: Validate success and error variants at the fetch boundary; if a `2xx` body lacks required fields, preserve any trustworthy returned balance/result data but transition the attempt to a terminal contract-error state instead of `generating`.
  - Strength: Converts a silent indefinite state into an explicit recoverable failure without weakening success-before-staleness or idempotency behavior.
  - Tradeoff: Requires a small response schema/state addition around a load-bearing hook.
  - Confidence: HIGH — the missing-ID branch and fallback status are explicit in the current code.
  - Blind spot: The desired user copy for “saved but response malformed” is not specified by the plan.
- **Decision**: FIXED — the missing-`summaryId` branch now calls `setError(copy.errors.savedResponseInvalid)` before returning, so the pending-derivation reads `error !== null` and resolves to the existing "failed" (dismissable) status instead of falling back to "generating" forever. New `pl.ts` copy string added; `result`/`credits` already applied above are left intact.

### F6 — The cost gate can report a negative resulting balance

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/PendingSummaryCard.tsx:154`
- **Detail**: The gate always interpolates `credits - confirm.cost`. A one-credit user can receive a two-credit long-video quote before the authoritative debit; the UI then blocks confirmation as too expensive but simultaneously says the resulting balance would be `-1`. No such balance can result because the endpoint will not allow the debit. This is a false statement about user funds.
- **Fix**: Branch the gate copy for insufficient known balance: state the quoted cost and current shortfall, omit the impossible post-confirmation balance, and keep the submit disabled. Use the four-fact “resulting balance” sentence only when confirmation can actually proceed.
  - Strength: Keeps monetary copy truthful and consistent with the existing `confirmTooExpensive` guard.
  - Tradeoff: Requires documenting a narrow exception to the plan's “four things and only those” gate sentence.
  - Confidence: HIGH — the arithmetic and disabled condition are both directly visible.
  - Blind spot: The exact 409 payload for this balance case still needs the pending endpoint/browser pass.
- **Decision**: FIXED — `PendingSummaryCard` now computes `gateTooExpensive` (same formula as `GenerateSummaryForm`'s `confirmTooExpensive`) and, when true, renders the existing `copy.generate.gate.tooExpensive` shortfall copy instead of `gate.held`'s resulting-balance sentence.

### F7 — Zero credits does not render the planned Disabled visual slot

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:74`, `src/components/summaries/GenerateSummaryForm.tsx:91`
- **Detail**: Zero credits correctly disables submission and keeps the layout mounted, but the capture bar remains unconditionally `bg-card`; only the default button disabled opacity and muted explanatory copy change. The Phase-6 contract explicitly requires the Disabled slot's `--background` ground under the disabled control plus `--muted-foreground`.
- **Fix**: Apply the planned `bg-background` disabled treatment conditionally when `noCredits` is true, preserving the bar's dimensions and content.
- **Decision**: FIXED — the form's className now conditionally swaps `bg-card` for `bg-background text-muted-foreground` when `noCredits` is true; layout/dimensions unchanged.

### F8 — Empty-list copy names the deleted dialog action

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/lib/copy/pl.ts:102`
- **Detail**: The genuine-empty hint still tells the user to use “Nowe podsumowanie”. Phase 6 deleted that dialog/button and replaced it with the always-visible inline capture bar, so the instruction names a control that no longer exists.
- **Fix**: Rewrite the hint to direct the user to paste a YouTube URL in the generation bar above.
- **Decision**: FIXED — `emptyHint` now reads "Wklej adres URL filmu z YouTube w pasku powyżej, aby wygenerować pierwsze."

### F9 — Persisted provider thumbnail URLs can request arbitrary origins

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/VideoThumbnail.tsx:48`
- **Detail**: `reportedUrl` comes from third-party metadata, is persisted without a URL-host allowlist, and is rendered directly as `<img src>`. A malformed or compromised provider value can make every viewer's browser contact an arbitrary origin. This was pre-existing logic that Phase 5 explicitly preserved, so it is a plan-level safety observation rather than implementation drift; it is also inconsistent with `SummaryMarkdown`'s documented reason for excluding attacker-controlled images.
- **Fix A ⭐ Recommended**: Always derive the thumbnail from the validated YouTube ID.
  - Strength: Eliminates the arbitrary-origin class and uses the fallback already documented as universally available.
  - Tradeoff: Gives up potentially higher-resolution/provider-selected variants.
  - Confidence: HIGH — the derived path already exists and is the current fallback.
  - Blind spot: Visual quality differences across older videos have not been sampled.
- **Fix B**: Parse and allowlist HTTPS YouTube thumbnail hosts before using `reportedUrl`, falling back to the derived URL otherwise.
  - Strength: Retains valid higher-quality reported variants while blocking unrelated origins.
  - Tradeoff: Adds host-policy maintenance and must account for every legitimate YouTube thumbnail hostname.
  - Confidence: MEDIUM — the current dataset's full legitimate host set was not audited.
  - Blind spot: Signed/redirecting thumbnail URLs may use hosts not yet observed.
- **Decision**: FIXED via Fix B — `VideoThumbnail.tsx` now allowlists `{i,i1-i4}.ytimg.com` and `img.youtube.com` over HTTPS via `isTrustedThumbnailUrl` (parsed with `new URL`); an untrusted or unparseable `reportedUrl` falls back to the derived `hqdefault.jpg` URL exactly as a 404 already does.

## Review Notes

- The user requested `context/changes/app-system-design`, but that folder does not exist. This review resolves to `context/changes/app-design-system`, the only matching active change and the one explicitly referenced by `context/foundation/lessons.md`.
- Git scope is exact and clean: Phase 4 is `30394e9`, Phase 5 is `28ff930`, and Phase 6 is `64b0f57`; `d8aecb2` only records the Phase-6 SHA in plan progress.
- Phase 4 otherwise matches its token, copy, pluralization and autocomplete contracts. The `import.meta.env.DEV` confirmation branch is preserved.
- Phase 5 otherwise preserves all four list states, the list-read failure distinction, the single `CHARACTER_LABEL`, greyscale badge channels, Markdown allowlist, reading typography, thumbnail fallback stages and keyed remount behavior.
- Phase 6 otherwise preserves generation-hook ownership, frozen quote inputs, idempotency-key lifetime, success-before-staleness ordering, refresh sequencing, attempt-bound clearing, server-error preference and both ARIA regions. No summary API, 409 metadata, theme, i18n-library, top-up or speculative-primitive scope was added.
- The insufficient-confirmation guard added to the unified Phase-6 submit button is not treated as drift: the legacy dialog's confirmation button already blocked a quote more expensive than the known balance. The unified bar preserves that behavior while still allowing submission when balance is unknown.
- No authentication bypass, cross-user data exposure, XSS/injection, hardcoded secret, destructive operation, unbounded loop, resource leak or new N+1 query was found.

