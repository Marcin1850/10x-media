<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Delete Summary Implementation Plan

- **Plan**: `context/changes/delete-summary/plan.md`
- **Mode**: Deep
- **Date**: 2026-09-06
- **Verdict**: REVISE → **SOUND** after triage (all 7 findings fixed, 2026-09-06)
- **Findings**: 2 critical, 4 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | WARNING |
| Lean Execution | WARNING |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | FAIL |

## Grounding

10/10 existing paths verified, 3/3 new paths absent as declared, 14/14 symbols verified, brief and plan aligned. The plan and brief share the stale branch statement captured in F6.

The requested skill's own `references/progress-format.md` is missing, so the equivalent repository reference at `.claude/skills/10x-plan/references/progress-format.md` was used.

## Findings

### F1 — Required research artifact is missing

- **Severity**: ⛔ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Change folder / testing prerequisites
- **Detail**: The repository instructions prohibit writing tests without the research step, and the documented workflow requires `research.md` to establish the oracle before planning. The change folder contains only `change.md`, `plan.md`, and `plan-brief.md`, while Phases 1–2 schedule both unit and integration tests.
- **Fix**: Run `/10x-research` for the deletion behavior and produce `context/changes/delete-summary/research.md`, then reconcile any resulting decisions across the plan and brief.
  - Strength: Satisfies the repository's mandatory testing workflow and preserves an independent oracle.
  - Tradeoff: Adds a research pass before implementation can begin.
  - Confidence: HIGH — the repository's AGENTS.md states this requirement explicitly.
  - Blind spot: Research may reveal additional plan changes.
- **Decision**: FIXED — research pass scoped to the test oracle (`research.md`), per user direction

### F2 — Progress titles violate the mechanical contract

- **Severity**: ⛔ CRITICAL
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: `## Progress`
- **Detail**: The structure is correct—one bottom-level Progress section, three matching phases, and all 29 rows—but 15 Progress titles are shortened versions of their corresponding Success Criteria. The review skill requires matching titles because `/10x-implement` treats this as a mechanical contract. Examples include 1.6, 1.9, 2.1, 2.4–2.5, and 3.7, 3.9–3.13.
- **Fix**: Make each Progress title match its Success Criteria bullet verbatim before the plan is reviewed and titles become immutable.
- **Decision**: FIXED — all 15 Progress titles rewritten verbatim

### F3 — Deleted-id state can be stale across asynchronous callbacks

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: End-State Alignment
- **Location**: Phase 3 — Delete lifecycle and list state
- **Detail**: The plan calls the tombstones one of three “pieces of state” and promises that every incoming list is filtered through them. Ordinary `useState<Set>` does not guarantee that: generation captures `onSuccess` before awaiting, and `refreshSummaries` also awaits before replacing the list wholesale. A deletion occurring during either wait can be invisible to the captured state, resurrecting the card—the exact race this design intends to prevent. Existing comments already warn about captured submit-time values in `DashboardSummaries.tsx:72-76`.
- **Fix A ⭐ Recommended**: Make a synchronously updated `useRef<Set<string>>` authoritative and read it after every await immediately before committing a list.
  - Strength: Minimal change that fits the component's existing `refreshSeq` ref pattern.
  - Tradeoff: Mutable refs require disciplined updates on delete and rollback.
  - Confidence: HIGH — both risky callbacks demonstrably cross asynchronous boundaries.
  - Blind spot: The race remains manual-only unless a suitable state-transition seam is extracted.
- **Fix B**: Store the summaries and tombstones in one state object or reducer and apply incoming lists through a functional update.
  - Strength: Makes the list/tombstone transition atomic and directly testable.
  - Tradeoff: More refactoring for a small feature.
  - Confidence: HIGH — functional updates receive the latest combined state.
  - Blind spot: Generation bookkeeping must remain outside the reducer or be carefully integrated.
- **Decision**: FIXED via Fix A — deleted-id set is an authoritative `useRef`, read after every await

### F4 — Endpoint validation and failure contracts lack automated coverage

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1 — Overview and unit tests
- **Detail**: Phase 1 promises unit tests for both the service and ID validation, but only `summary-delete.test.ts` is specified, covering service behavior. Invalid UUIDs are manual-only, while Phase 2 omits them. The handler's 503 and masked-500 mappings are also untested.
- **Fix A ⭐ Recommended**: Add a hermetic `delete.int.test.ts` handler suite with mocked client/service boundaries for 401, 400, 503, 404, 500, and 200; retain `delete.db.int.test.ts` for real balance and RLS behavior.
  - Strength: Pins the complete endpoint contract using the integration project's supported `astro:env/server` alias.
  - Tradeoff: Requires the established reset/mock/re-import harness pattern.
  - Confidence: HIGH — this matches the repository's documented treatment of endpoint refusal paths.
  - Blind spot: UI response handling remains manually verified.
- **Fix B**: Extract a pure delete-ID schema into `src/lib/schemas/` and unit-test valid, invalid, and missing IDs.
  - Strength: Small and consistent with `generate-summary.ts`.
  - Tradeoff: Leaves the handler's 503/500 response mappings unprotected.
  - Confidence: HIGH — the pattern already exists.
  - Blind spot: Service-to-response translation remains manual.
- **Decision**: FIXED via Fix A — hermetic `delete.int.test.ts` added as Phase 2 item 1

### F5 — Phase 3 specifies unreachable UI and an incomplete error callback

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 3 — Card and list contracts
- **Detail**: The card is removed immediately when deletion starts, so its `deleting` prop and in-flight label can never render. Separately, the card promises that Cancel clears its parent-owned per-ID error, but its declared props provide no error-clear callback.
- **Fix**: Preserve optimistic removal, remove the unreachable deleting state, prop, and copy, and add an `onClearDeleteError(id)` path through `SummaryList` to `SummaryCard`.
- **Decision**: FIXED — `deleting` prop/label dropped, `onClearDeleteError(id)` added through the list

### F6 — The branch phase is already stale

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 — Branch
- **Detail**: The plan, brief, and roadmap say the change is still on `master` and instruct implementation to create `delete-summary`. The current branch is already `delete-summary`, with plan commit `6e9740f`. Attempting to create it again will fail.
- **Fix**: Mark the branch prerequisite satisfied or remove the implementation step, and synchronize the stale statements in `plan-brief.md` and `roadmap.md`.
- **Decision**: FIXED — Phase 1 branch step marked satisfied; `plan-brief.md` and `roadmap.md` synced

### F7 — Confirmation guidance is generalized beyond its source

- **Severity**: OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Key Discoveries
- **Detail**: The plan says the account-deletion review established that confirmation must be enforced server-side, but the proposed summary endpoint accepts no confirmation. This is not necessarily a code defect: account deletion uses re-entered email as meaningful independent proof, while a boolean or repeated summary ID would add ceremony without protection.
- **Fix**: Scope the discovery to high-blast-radius account erasure and explicitly document why per-card deletion uses inline UI confirmation only.
- **Decision**: FIXED — discovery scoped to account erasure; per-card rationale documented
