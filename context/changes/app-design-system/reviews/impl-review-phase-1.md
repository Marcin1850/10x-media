<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: App Design System — Step 4 Implementation Plan

- **Plan**: `context/changes/app-design-system/plan.md`
- **Scope**: Phase 1 of 9
- **Date**: 2026-08-12
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 0 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | FAIL |

## Verification Evidence

### Automated

- `npm.cmd run build` — **PASS**. Astro completed the Cloudflare SSR build and copied four self-hosted font assets. The existing sitemap warning remains: no `site` option, so sitemap generation was skipped.
- `npm.cmd run lint` — **FAIL**. ESLint reports 36 formatting errors in four untracked Phase 2 shadcn files: `badge.tsx`, `checkbox.tsx`, `input.tsx`, and `label.tsx`. The tracked Phase 1 files pass a targeted ESLint run; `global.css` is not covered by the ESLint configuration.
- `git grep -n "bg-cosmic" -- src` — **PASS**. No matches.

### Manual

Intentionally pending, not treated as rubber-stamped or as an implementation defect:

- [ ] Both faces load from the app's own origin.
- [ ] Exactly four font preload links appear in `<head>`.
- [ ] Polish diacritics render in the loaded faces.
- [ ] Every page uses the flat `#101013` ground.
- [ ] A `bg-attention` probe renders amber.

## Findings

### F1 — Space Grotesk preload filter selects no generated asset

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `src/layouts/Layout.astro:29`
- **Detail**: The component filters Space Grotesk preloads by `weight: 600`, but Astro 6.3.1 deduplicates the Google provider's identical variable-font URLs and records the two unique Space Grotesk preload candidates (latin and latin-ext) under `weight: "400"`. The built `componentDataByCssVariable` therefore has no Space candidate matching 600, while `filterPreloads()` rejects both. The rendered head will contain only the two IBM Plex Sans preload links, not the required four. This is observable in `dist/server/chunks/_astro_assets_*.mjs`: both Space candidates are weight 400 and the filter requires exact weight equality.
- **Fix**: Remove `weight: 600` from the two Space Grotesk preload filters and select its two unique assets by subset; then rebuild and count the rendered preload links.
- **Decision**: PENDING

### F2 — Premature Phase 2 files break the Phase 1 lint gate

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Scope Discipline
- **Location**: `src/components/ui/badge.tsx:1`, `src/components/ui/checkbox.tsx:1`, `src/components/ui/input.tsx:1`, `src/components/ui/label.tsx:1`
- **Detail**: Five untracked shadcn primitives planned for Phase 2 are already present even though Phase 1 explicitly pauses before Phase 2 for manual font confirmation. Four are not repository-formatted, so the required whole-repository `npm run lint` command currently fails with 36 errors. The Phase 1 commit itself remains focused, and its tracked code files pass targeted linting, but the current workspace cannot satisfy automated criterion 1.2.
- **Fix A ⭐ Recommended**: Keep the generated primitives, format only the five untracked Phase 2 files, and rerun the full lint gate.
  - Strength: Preserves the generated work and restores the automated gate with a narrow mechanical change.
  - Tradeoff: Phase 2 preparation remains in the workspace before Phase 1's manual pause is cleared.
  - Confidence: HIGH — all 36 reported errors are Prettier-fixable and localized to these generated files.
  - Blind spot: The files have not yet been reviewed against the Phase 2 component contract.
- **Fix B**: Remove the untracked primitives and regenerate them after Phase 1 manual verification.
  - Strength: Restores the plan's phase boundary and a clean Phase 1 workspace.
  - Tradeoff: Discards generated work now and repeats the shadcn CLI step later.
  - Confidence: HIGH — the files are untracked and Phase 2 explicitly owns their generation.
  - Blind spot: Any unpublished manual edits inside the generated files would be lost.
- **Decision**: PENDING

## Review Notes

- All planned Phase 1 contracts match the implementation: font configuration, 3b token values, dark/Polish document setup, token-to-Tailwind mappings, and removal of `bg-cosmic`.
- The four additional one-token `bg-cosmic` removals in `Welcome.astro` and the three auth pages correct an incomplete usage count in the plan. They were necessary to delete the utility safely and satisfy criterion 1.3, so they are not treated as harmful scope creep.
- No substantive security, performance, data-safety, architecture, or established-pattern violations were found in the Phase 1 implementation.
