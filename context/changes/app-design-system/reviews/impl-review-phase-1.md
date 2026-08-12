<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: App Design System — Step 4 Implementation Plan

- **Plan**: `context/changes/app-design-system/plan.md`
- **Scope**: Phase 1 of 9
- **Date**: 2026-08-12
- **Verdict**: NEEDS ATTENTION at review time; **APPROVED** after triage (2026-08-12) — see [Post-Triage Status](#post-triage-status)
- **Findings**: 0 critical, 2 warnings, 0 observations — both triaged, neither left an outstanding defect

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
- **Decision**: DISMISSED — false positive, disproved by render. The fix was applied and measured end to end against `npm run preview` (curl on `/`, counting `<link rel="preload">`):
  - `{ weight: 600, subset }` (as implemented) renders **4** preloads: `font-space-grotesk-600-normal-{latin,latin-ext}` plus the two IBM Plex Sans faces — exactly criterion 1.2's required set.
  - `{ subset }` only (the proposed fix) renders **10** preloads: Space Grotesk is emitted at weights 400/500/600/700 x 2 subsets, re-listing the same two deduped files four times each.
  - The static reading of `dist/server/chunks/_astro_assets_*.mjs` was wrong: candidates at weight 600 do exist and do match. Applying the fix would have quadrupled the Space Grotesk preloads.
  - Code reverted to its original form; the only retained change is a comment in `src/layouts/Layout.astro` recording why the `weight` key is load-bearing.

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
- **Decision**: FIXED via Fix B — the untracked Phase 2 primitives are no longer in the workspace. `src/components/ui/` now holds only `button.tsx`, `dialog.tsx`, and `LibBadge.astro`; `git status` is clean apart from the Phase 1 review file and `Layout.astro`; `npm run lint` exits 0 across the whole repository. The plan's phase boundary is restored and Phase 2 regenerates the primitives via the shadcn CLI.

## Post-Triage Status

Triaged 2026-08-12. The two review-time verdicts below were both driven by findings that did not survive triage:

| Dimension | At review | After triage | Why |
|-----------|-----------|--------------|-----|
| Scope Discipline | WARNING | PASS | F2 resolved via Fix B — the premature Phase 2 primitives are gone from the workspace. |
| Success Criteria | FAIL | PASS | The FAIL rested on criterion 1.2 (`npm run lint`), which failed only because of F2's unformatted files. With those removed, `npm run lint` exits 0 repository-wide. F1, the other Success Criteria finding, was disproved by render. |

All other dimensions were PASS at review time and are unchanged. Phase 1's five manual criteria remain intentionally pending — the phase's manual font-verification gate is still open and is not affected by this triage.

Working-tree change carried out of triage: a comment in `src/layouts/Layout.astro` documenting why the `weight` key in the `<Font preload>` filter is load-bearing. No behavioral code change was made.

## Review Notes

- All planned Phase 1 contracts match the implementation: font configuration, 3b token values, dark/Polish document setup, token-to-Tailwind mappings, and removal of `bg-cosmic`.
- The four additional one-token `bg-cosmic` removals in `Welcome.astro` and the three auth pages correct an incomplete usage count in the plan. They were necessary to delete the utility safely and satisfy criterion 1.3, so they are not treated as harmful scope creep.
- No substantive security, performance, data-safety, architecture, or established-pattern violations were found in the Phase 1 implementation.
