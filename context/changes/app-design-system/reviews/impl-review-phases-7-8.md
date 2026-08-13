<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: App Design System — Step 4 Implementation Plan

- **Plan**: `context/changes/app-design-system/plan.md`
- **Scope**: Phases 7–8 of 9
- **Date**: 2026-08-13
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 2 observations

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

### F1 — Planned top-up variant contract was not implemented or documented

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/pages/account.astro:33`; `src/components/account/TopUpAction.tsx:51`
- **Detail**: Phase 7 requires `<TopUpAction variant="row-button" client:load />`, and Phase 3 specifies a shared `"menu-item" | "row-button"` variant API. The page instead renders `<TopUpAction client:load />`; the component accepts no variant and always renders the row-style outline button. The shared behavior is still centralized correctly through `useTopUpAction`, and `AccountMenu` uses that hook directly to preserve Radix menu-item semantics, so this is a contract/documentation drift rather than missing user behavior.
- **Fix**: Update `plan.md` and `plan-brief.md` to document the implemented split: `useTopUpAction` owns shared behavior, while `TopUpAction` is the row-button presentation and `AccountMenu` owns the menu-item presentation.
  - Strength: Matches the accessible implementation already in the repository and avoids adding an unused or misleading variant API.
  - Tradeoff: Records a discovered design adjustment in the plan instead of restoring its original component shape.
  - Confidence: HIGH — the component comment and both call sites make the implemented ownership explicit.
  - Blind spot: The pending manual top-up check must still confirm both surfaces emit the same event and show the same notice.
- **Decision**: PENDING

### F2 — Delete failure is not announced to assistive technology

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/account/DeleteAccountDialog.tsx:108`
- **Detail**: An asynchronous deletion failure is inserted as a plain paragraph without `role="alert"`, `role="status"`, or live-region semantics. A screen-reader user may receive no indication that the irreversible request failed and the dialog is ready for retry. Existing dynamic error patterns announce errors in `src/components/auth/FormField.tsx` and `src/components/summaries/PendingSummaryCard.tsx`.
- **Fix**: Add `role="alert"` (optionally `aria-atomic="true"`) to the error paragraph and mark the decorative `CircleAlert` as `aria-hidden="true"`.
- **Decision**: PENDING

### F3 — Public query state can display a false deletion-success message

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/pages/index.astro:6`
- **Detail**: The landing page treats `?deleted=1` as sufficient evidence that account deletion succeeded. Any direct visit to that URL, including by an authenticated user whose account still exists, displays the irreversible-success assertion. Phase 8 preserved and tokenized this pre-existing behavior exactly as planned, so this is a plan-level reliability observation rather than a phase regression.
- **Fix A ⭐ Recommended**: Set a short-lived, HttpOnly, SameSite one-shot cookie after successful deletion and consume/clear it on the landing response.
  - Strength: Keeps the toast server-rendered and ties it to server-observed success across the redirect.
  - Tradeoff: Expands the change across the delete endpoint and landing response, with cookie lifecycle handling.
  - Confidence: HIGH — the producer and consumer are both first-party server boundaries.
  - Blind spot: The exact cookie API under the Cloudflare Astro adapter has not been exercised in this review.
- **Fix B**: Store a one-shot flag in `sessionStorage` after the successful response and render the toast from a small client island.
  - Strength: Narrow client-side implementation with no server cookie contract.
  - Tradeoff: Adds hydration to a currently static toast and provides weaker provenance than server-issued evidence.
  - Confidence: MEDIUM — browser storage behavior is straightforward, but it changes the SSR presentation path.
  - Blind spot: Redirect timing and disabled-storage behavior would need browser verification.
- **Decision**: PENDING

### F4 — Fresh build verification was inconclusive in this environment

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: N/A
- **Detail**: `npm.cmd run lint` passed, the account palette grep returned no matches, and the landing blur grep returned no matches. A fresh `npm.cmd run build` did not reach compilation results: first Astro/Wrangler could not write config/log files outside the workspace, then Miniflare's Workers runtime terminated inside the sandbox; the unrestricted retry did not complete and was stopped. The Progress section records successful build verification in implementation commits `f736221` and `4987a77`, but this review could not independently reproduce it.
- **Fix**: Rerun `npm.cmd run build` in the normal local environment with the Cloudflare Workers runtime available and attach the result before closing phases 7–8.
- **Decision**: PENDING

## Verification Evidence

### Automated

| Criterion | Command | Result |
|-----------|---------|--------|
| 7.1 / 8.1 lint | `npm.cmd run lint` | PASS |
| 7.1 / 8.1 build | `npm.cmd run build` | INCONCLUSIVE — environment/runtime blocker; implementation commits record PASS |
| 7.2 account palette sweep | `git grep -nE "(bg|text|border)-(white|blue|purple|red|slate)-?" -- src/pages/account.astro src/components/account` | PASS — no matches |
| 8.2 landing blur sweep | `git grep -n "blur-\\[" -- src/components/Welcome.astro` | PASS — no matches |

### Manual

Manual criteria 7.3–7.7 and 8.3–8.6 are intentionally unchecked and pending. They were not treated as implementation defects or rubber-stamped as complete.

## Review Notes

- The requested path `context/changes/app-system-design` does not exist. The review resolved to `context/changes/app-design-system`, the only matching active change and the one with prior reviews through phases 4–6.
- Git scope is clean and phase-aligned: `f736221` changes only the planned Phase 7 source files plus progress metadata; `4987a77` changes only the planned Phase 8 source files plus progress metadata. Follow-up `93354d9` remains within the planned Phase 8 copy/component files, and `7045b6b` is progress-only documentation.
- No API translation, theme toggle, runtime i18n, self-serve top-up, landing capture bar, or other out-of-scope capability was added.
- No new XSS/injection, secret exposure, auth/authz bypass, unsafe deletion behavior, data-loss path, unbounded work, N+1 query, or resource leak was found. The delete endpoint remains the authoritative server-side boundary for identity and confirmation.
