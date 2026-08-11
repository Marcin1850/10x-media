<!-- PLAN-REVIEW-REPORT -->
# Plan Review: App Design System — Step 4

- **Plan**: `context/changes/app-design-system/plan.md`
- **Mode**: Deep
- **Date**: 2026-08-11
- **Verdict**: REVISE
- **Findings**: 2 critical, 4 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
| --- | --- |
| End-State Alignment | FAIL |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

19/19 existing targets ✓, 11/11 sampled symbols ✓, brief↔plan mismatch ✗.

The mechanical Progress contract passes: there is exactly one bottom `## Progress` section, all nine
phase names match, phase criteria have corresponding progress rows, and there are no checkboxes in the
plan body.

The requested review skill's `references/progress-format.md` was absent. The matching canonical
contract from `.claude/skills/10x-plan/references/progress-format.md` was used as the fallback.

## Findings

### F1 — `charged: true` can falsely report a debit

- **Severity**: 🛑 CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: End-State Alignment
- **Location**: Phase 9 — charged signal
- **Detail**: The plan hardcodes `charged: true` in `refusalResponse()`, but `refuseAndCharge()` currently
  discards the result of `chargeFailedTranscript()`. That service can return `insufficient` or
  `notCharged`, both meaning no credit was taken. The helper is also used for known charged replays, so
  one unconditional value cannot be truthful. The client owner must forward and reset the new state,
  which the plan's "exactly two sites" constraint omits.
- **Fix ⭐ Recommended**: Propagate the actual outcome end-to-end: `charged` and known refusal replay map
  to `true`; `insufficient`, `notCharged`, and transient failure map to `false`; missing or malformed
  fields map to `null`. Pass the value through `refusalResponse`, the generation hook,
  `DashboardSummaries`, and the pending card.
  - Strength: Makes every money statement derive from the ledger outcome.
  - Tradeoff: Expands Phase 9 beyond two response literals.
  - Confidence: HIGH — the service and SQL outcomes explicitly encode the distinction.
  - Blind spot: Replay wording should clarify that the operation was charged earlier, not charged again
    by the retry.
- **Evidence**:
  - `src/pages/api/summaries/generate.ts:235-278`
  - `src/lib/services/credits.ts:193-208,263-292`
  - `src/components/summaries/DashboardSummaries.tsx:174-198`
- **Decision**: PENDING

### F2 — The plan intentionally uses gate-only amber outside the gate

- **Severity**: 🛑 CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Phases 3, 5, and 6
- **Detail**: The design system states that `--attention` means only "waiting for your decision about
  spending credits." The plan nevertheless assigns it to warning banners, list refresh notes, and
  `saved-refresh-failed`, while Phase 6 requires amber to appear nowhere outside the cost gate. Following
  the phase contracts makes that success criterion impossible.
- **Fix A ⭐ Recommended**: Keep `--attention` gate-only; render general warnings on a neutral card and
  border treatment with icon and copy as their non-color channels.
  - Strength: Preserves the published semantic contract and unambiguous money signal.
  - Tradeoff: Requires specifying neutral warning treatments in three phases.
  - Confidence: HIGH — the source design artifacts state this contract explicitly.
  - Blind spot: The neutral banner treatment still needs a contrast check.
- **Fix B**: Redefine `--attention` as a general-warning token and revise the design artifacts and
  "amber iff" criteria.
  - Strength: Matches the plan's current phase mappings.
  - Tradeoff: Removes the intentionally unique spending-decision signal.
  - Confidence: HIGH — mechanically consistent, but contrary to the chosen visual direction.
  - Blind spot: Every warning surface would need re-validation.
- **Evidence**:
  - `context/changes/app-design-system/ds-bundle/tokens.css:6-9`
  - `context/changes/app-design-system/visual-direction-outcome.md:75-83`
  - `context/changes/app-design-system/plan.md:365-367,487-491,610-616,641-642`
- **Decision**: PENDING

### F3 — The topbar has two incompatible navigation contracts

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: Phases 3 and 8
- **Detail**: Phase 3 says the left side always contains the logo and "Podsumowania"; Phase 8 requires
  the landing page to show only the logo. Once `Topbar` moves into `Layout`, changing `Welcome.astro`
  cannot control that navigation.
- **Fix ⭐ Recommended**: Define `Topbar` as route-aware, suppressing "Podsumowania" on `/`, and clarify
  that "same topbar" means one shared component and shell rather than identical links.
  - Strength: Meets both settled screen contracts with one component.
  - Tradeoff: Navigation logic becomes aware of the current route.
  - Confidence: HIGH — Astro exposes the pathname directly.
  - Blind spot: The plan must state whether signed-in landing also remains logo-only.
- **Evidence**:
  - `context/changes/app-design-system/plan.md:327-334,721-728`
  - `src/layouts/Layout.astro:6-38`
  - `src/components/Welcome.astro:2,30`
- **Decision**: PENDING

### F4 — Account top-up interaction has no implementation contract

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 7 — Account page
- **Detail**: The phase modifies only `account.astro` but requires a click-driven notice and browser-side
  reporting call. Existing Astro pages contain no client scripts; current account interaction is a
  React island. Phase 3 independently requires the same behavior in `AccountMenu.tsx`.
- **Fix ⭐ Recommended**: Add a reusable `TopUpAction.tsx` client component used inside `AccountMenu` and
  hydrated from `account.astro`. Define its notice accessibility, stable event key, severity, and
  payload.
  - Strength: One interaction and telemetry contract across both surfaces.
  - Tradeoff: Adds one small island/component to the plan.
  - Confidence: HIGH — this matches the repository's existing interaction pattern.
  - Blind spot: The exact visual form of the plain notice remains a product choice.
- **Evidence**:
  - `context/changes/app-design-system/plan.md:661-670`
  - `src/pages/account.astro:32`
- **Decision**: PENDING

### F5 — Font configuration can preload up to 28 files

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1 — Font pipeline
- **Detail**: `<Font preload />` preloads every returned face. The proposed seven weights, two subsets,
  and Astro's default normal plus italic styles can generate up to 28 preload links, contradicting the
  plan's "minimal payload" claim.
- **Fix ⭐ Recommended**: Specify `styles: ["normal"]` and use filtered preload arrays for only measured
  above-the-fold weights and subsets.
  - Strength: Retains self-hosting without eagerly downloading every face.
  - Tradeoff: Requires choosing which faces are genuinely critical.
  - Confidence: HIGH — verified against the installed Astro 6 implementation.
  - Blind spot: Google may return variable files, reducing the actual count; `preload: true` still
    preloads everything returned.
- **Evidence**:
  - `context/changes/app-design-system/plan.md:167-173,198-200,854-857`
  - `node_modules/astro/components/Font.astro:13-27`
  - `node_modules/astro/dist/assets/fonts/core/filter-preloads.js:1-8`
- **Decision**: PENDING

### F6 — Several verification instructions cannot validate their claims

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Success criteria and Testing Strategy
- **Detail**: `grep` is unavailable in the repository's PowerShell environment. Breaking the Supabase
  URL prevents authentication or client creation before the protected list page can render its
  unavailable state. The plan also repeatedly says "nine screens/states" while the matrix contains
  eleven steps.
- **Fix**: Replace `grep` commands with PowerShell-compatible `git grep` or `Select-String`; use targeted
  list-service fault injection while authentication remains functional; change "nine" to "eleven."
- **Evidence**:
  - `context/changes/app-design-system/plan.md:59-60,215-217,282-285,538-539,829-850`
  - `src/middleware.ts:6-20`
  - `src/lib/supabase.ts:5-9`
- **Decision**: PENDING

### F7 — Middleware performance accounting omits signed-in auth pages

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Performance Considerations
- **Detail**: The proposed middleware condition excludes only `/api/`, so signed-in visits to the three
  auth pages also perform the new balance query. The performance section claims only `/account` and `/`
  gain reads.
- **Fix**: Update the performance statement or explicitly narrow where balances are loaded.
- **Evidence**:
  - `context/changes/app-design-system/plan.md:313-317,854-857`
  - `src/middleware.ts:6-24`
- **Decision**: PENDING

### F8 — "Every surface is in Polish" overpromises the accepted boundary

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Desired End State and plan brief
- **Detail**: Both documents promise every surface in Polish, while the plan deliberately preserves
  English server errors that are rendered inside those surfaces.
- **Fix**: Say "all client-owned UI copy is Polish" and retain the documented API-copy follow-up.
- **Evidence**:
  - `context/changes/app-design-system/plan.md:51-60,91-92,137-142,861-866`
  - `context/changes/app-design-system/plan-brief.md` — Desired End State and Open Risks
- **Decision**: PENDING
