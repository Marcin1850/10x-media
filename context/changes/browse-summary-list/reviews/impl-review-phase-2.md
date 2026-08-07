<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Browse Summary List (S-02)

- **Plan**: `context/changes/browse-summary-list/plan.md`
- **Scope**: Phase 2 of 4
- **Date**: 2026-08-07
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 1 observation
- **Manual gate**: Pending by design; Progress items 2.3–2.10 remain unchecked

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING — 2 findings |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING — automated checks pass; manual verification remains pending |

## Verification

- `npm.cmd run lint` — PASS. ESLint exited 0; only the existing `astro-eslint-parser` project-service notices were emitted.
- `npm.cmd run build` — PASS. Astro SSR/Cloudflare build exited 0 outside the filesystem sandbox; the existing sitemap warning notes that `site` is not configured.
- Manual criteria 2.3–2.10 — PENDING. They are intentionally unchecked and were not treated as implementation defects.

## Findings

### F1 — Card expand button contains non-phrasing document structure

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/SummaryCard.tsx:57`
- **Detail**: The expand control is a real `<button>`, as planned, but it wraps `<div>`, `<h3>`, and `<p>` descendants. A button's permitted content is phrasing content, so this is invalid interactive markup. It also makes the button's accessible name absorb the thumbnail alt, title, metadata, date, and preview, while the heading is nested inside the control. Lint and build do not validate this HTML content-model or assistive-technology behavior.
- **Fix**: Keep the semantic thumbnail, heading, metadata, and preview outside the button, and add a valid full-card overlay or focused expand/collapse button with an explicit title-based accessible label plus `aria-expanded`/`aria-controls`.
  - Strength: Preserves semantic document structure and gives the control a concise accessible name while retaining the planned expand behavior.
  - Tradeoff: Requires a small card-layout adjustment and a manual keyboard/screen-reader check.
  - Confidence: HIGH — the invalid descendants are directly visible in the component and existing repository buttons contain text/icons rather than block document structure.
  - Blind spot: The preferred interaction target (whole card versus a focused control) has not yet been chosen or manually verified.
- **Decision**: PENDING

### F2 — Thumbnail fallback state survives a changed source

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/VideoThumbnail.tsx:34`
- **Detail**: `stage` is initialized from `reportedUrl` only on mount. If the same summary card receives refreshed `youtubeId` or `reportedUrl` props later, a previous `derived` or `placeholder` state remains active and the new reported URL is never tried. Phase 2's server-seeded list does not update in place, but Phase 4 explicitly plans a controlled list refresh, so this can make a refreshed card differ from a page reload.
- **Fix**: Key `VideoThumbnail` by the thumbnail source identity at the `SummaryCard` call site so a changed `youtubeId` or `reportedUrl` remounts the fallback state.
- **Decision**: PENDING

## Review Summary

All seven Phase 2 implementation items match the plan in commit `d42c5ba`, including the shared hardened Markdown renderer, double thumbnail fallback, deterministic UTC formatting, controlled character filter, distinct unavailable/empty states, and unchanged inline generation flow. The commit respects every “What We're NOT Doing” guardrail; its only extra files are expected change lifecycle bookkeeping. Approval covers the implementation review. Human acceptance criteria 2.3–2.10 remain a separate pending gate and must be completed before Phase 3 begins.
