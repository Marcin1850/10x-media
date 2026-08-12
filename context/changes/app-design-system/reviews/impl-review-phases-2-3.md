<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: App Design System — Step 4 Implementation Plan

- **Plan**: `context/changes/app-design-system/plan.md`
- **Scope**: Phases 2–3 of 9
- **Date**: 2026-08-12
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 5 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Verification Evidence

### Automated

- `npm.cmd run lint` — **PASS**. ESLint exits 0. The existing `astro-eslint-parser` notice about treating `projectService` as `project: true` is unchanged.
- `npm.cmd run build` — **PASS**. Astro completed the Cloudflare SSR build and copied four font assets. Existing warnings remain: inspector port 9229 was unavailable and sitemap generation was skipped because `site` is unset.
- `git grep -n "\[supadata-budget\]" -- src/lib/services` — **PASS**. The stable key remains `src/lib/services/supadata-budget.ts:212:const BUDGET_EVENT = "[supadata-budget]";`.
- `git grep -n "LibBadge" -- src` — **PASS**. No matches.
- `git grep -n "/dashboard" -- src` — **PASS**. No matches.
- `git grep -n -A 1 "PROTECTED_ROUTES" -- src/middleware.ts` — **PASS**. The array contains `/summaries` and `/account`.

### Manual

Intentionally pending, as requested. None of these unchecked rows is treated as rubber-stamped or as a defect merely because it is open:

- [ ] Phase 2: budget event logs in the same shape as before the refactor.
- [ ] Phase 3: shared topbar shell and route-aware summaries link on all four surfaces.
- [ ] Phase 3: signed-in/signed-out right side branches correctly.
- [ ] Phase 3: avatar menu supports click, Escape and arrow-key navigation.
- [ ] Phase 3: top-up notice renders and emits one warning.
- [ ] Phase 3: `/dashboard` 404s and `/summaries` remains protected.
- [ ] Phase 3: a missing balance shimmers rather than showing `0`.
- [ ] Phase 3: warning banner is neutral rather than amber and passes AA.

The Success Criteria verdict is WARNING, not FAIL: all automated gates pass, while the deliberately deferred manual gate remains open and F1 gives the menu-keyboard row a concrete risk to test.

## Findings

### F1 — Top-up menu nests interactive controls inside a Radix menu item

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/AccountMenu.tsx:38`, `src/components/account/TopUpAction.tsx:32`
- **Detail**: `DropdownMenuItem` is the roving-focus `menuitem`, but it contains a second native button and, after activation, another dismiss button. Pointer activation can reach the inner top-up button. Keyboard activation targets the outer Radix item; its `onSelect` only prevents the default close and never invokes `TopUpAction.handleClick`, so Enter/Space can leave the notice unopened and emit no event. The dismiss button is also inside the menu composite without being part of Radix's focus model. This directly threatens manual criterion 3.6.
- **Fix**: Make the Radix item the sole menu trigger, route its `onSelect` through the shared top-up handler, and render/portal the persistent status plus dismiss control outside the `menuitem` composite.
  - Strength: Restores valid menu keyboard semantics while retaining one owner for notice and reporting behavior.
  - Tradeoff: Requires a small state/component-boundary rearrangement rather than a one-line handler change.
  - Confidence: HIGH — Radix activates the outer item for selection, and its source explicitly ignores selection keys when the event target is a nested control.
  - Blind spot: The final focus-return behavior still needs the intentionally pending browser pass.
- **Decision**: PENDING

### F2 — Phase 3 overlays the new shell on the legacy summaries shell

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/pages/summaries.astro:3`, `src/pages/summaries.astro:21`, `src/pages/summaries.astro:53`
- **Detail**: Middleware now reads `getBalance` into `locals.credits`, but `/summaries` imports and calls `getBalance` again, creating two sequential balance queries on the primary signed-in page. The renamed page also retains the old header card's account link and sign-out form even though the phase-3 contract says account is menu-only and this phase ends ad-hoc navigation. Phase 5 separately schedules removal of this page-local read and header, so the plan has a phase-order ambiguity; nevertheless, the explicit phase-3 end state (“read once per request” and one navigation shell) is not true now.
- **Fix**: Pull the narrow Phase 5 page-shell cleanup forward: seed `initialCredits` from `Astro.locals.credits`, remove the page-local balance read, and delete the legacy header card while leaving the summary-list read and island behavior unchanged.
  - Strength: Makes the Phase 3 architecture and performance claim true without changing generation or list behavior.
  - Tradeoff: Moves a documented portion of Phase 5 into the Phase 3 correction and requires synchronizing the plan/brief phase ownership.
  - Confidence: HIGH — the duplicate call and duplicate controls are directly visible in the page, and middleware already supplies the required value.
  - Blind spot: Visual spacing after removing the header still needs the pending browser pass.
- **Decision**: PENDING

### F3 — Unsupported-feature events are browser-local, not Worker events

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: `src/components/account/TopUpAction.tsx:26`, `src/lib/services/reporting.ts:21`
- **Detail**: The top-up action runs in a hydrated client island, so `reportUnsupportedFeature()` writes to the user's browser console. Budget events call the same source function on the Worker and reach Worker logs. The seam is shared at module level but not at runtime, and the comment saying unsupported-feature events are counted in Workers logs is currently false.
- **Fix A ⭐ Recommended**: Document the emitter as runtime-local for now and make the future receiver contract explicitly support both browser and Worker transports.
  - Strength: Makes the current observability claim honest without adding a new network boundary during a UI phase.
  - Tradeoff: Top-up events remain unavailable in centralized Worker logs until the planned receiver lands.
  - Confidence: HIGH — browser and Worker consoles are separate execution environments.
  - Blind spot: The eventual telemetry product and its client/server SDK behavior are not selected yet.
- **Fix B**: Add a minimal authenticated telemetry endpoint and send the top-up event to it.
  - Strength: Produces a real server-side event immediately.
  - Tradeoff: Adds an abuse-sensitive public boundary, validation and failure handling outside the phase plan.
  - Confidence: MEDIUM — technically straightforward, but the operational requirements are not specified.
  - Blind spot: Rate limiting and receiver durability have not been designed.
- **Decision**: PENDING

### F4 — Copy module omits the planned namespace skeleton

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/lib/copy/pl.ts:10`
- **Detail**: The plan requires `common`, `nav`, `auth`, `summaries`, `generate`, `account`, `landing` and `errors` to exist from Phase 2, with only `common` and `nav` populated. The implementation defines only `common` and `nav`, so `Copy = typeof pl` does not yet enforce the promised full locale shape.
- **Fix**: Add empty `auth`, `summaries`, `generate`, `account`, `landing` and `errors` objects to `pl` now; later phases populate them in place.
- **Decision**: PENDING

### F5 — Top-up reporting is once per reveal cycle, not once per click

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/account/TopUpAction.tsx:22`
- **Detail**: The phase contract says the stable `top-up` event emits once per click. `handleClick` emits only when `revealed` is false, so clicking the still-visible trigger again while the notice is open records no event. It currently measures closed-to-open transitions rather than clicks.
- **Fix**: Call `reportUnsupportedFeature("top-up")` unconditionally from the trigger handler, leaving render-time emission prohibited.
- **Decision**: PENDING

### F6 — Neutral warning banner has only a bottom border

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/components/Banner.astro:27`, `src/components/Banner.astro:45`
- **Detail**: The neutral warning contract specifies a card ground with a 1px solid `--border` outline. The shared banner rule defines only `border-bottom: 1px solid`; the warning variant changes colors but never adds the full border. It correctly avoids amber and includes the warning icon.
- **Fix**: Set the warning variant to `border: 1px solid var(--border)` (and retain the neutral card/foreground colors).
- **Decision**: PENDING

### F7 — Unknown credit state has no accessible value

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/components/Topbar.astro:30`
- **Detail**: When credits are unavailable, the only value-shaped element is an `aria-hidden` shimmer. Assistive technology receives the label “Kredyty” without a value or an unavailable-state announcement.
- **Fix**: Add localized visually-hidden copy such as “saldo niedostępne” beside the decorative shimmer.
- **Decision**: PENDING

### F8 — Generated dropdown keeps a prohibited Next.js directive

- **Severity**: 👁️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/components/ui/dropdown-menu.tsx:1`
- **Detail**: The file starts with `"use client"`, contrary to the repository rule forbidding Next.js directives. Astro already controls hydration at `<AccountMenu client:load />`, and neighboring generated primitives do not carry the directive. It is inert here but creates a misleading framework signal.
- **Fix**: Remove the `"use client"` directive from the generated primitive.
- **Decision**: PENDING

## Review Notes

- Git scope is exact and clean: Phase 2 is `a4ae502`, Phase 3 is `7131897`; commits after Phase 3 change documentation only. No unrelated source paths were introduced by either phase.
- The five requested shadcn primitives were added and `LibBadge.astro` was deleted; no speculative primitive was added.
- The budget event key, payload serialization and warn-vs-error routing remain structurally unchanged.
- No authentication bypass, cross-user balance exposure, injection risk, destructive data operation or secret was found. `/summaries` and `/account` remain protected, balance failures degrade to `null`, and sign-out remains a POST.
