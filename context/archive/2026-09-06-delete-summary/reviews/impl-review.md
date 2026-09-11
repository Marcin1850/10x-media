<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Delete Summary Implementation Plan

- **Plan**: `context/changes/delete-summary/plan.md`
- **Scope**: Phases 1-3 of 3
- **Date**: 2026-09-07
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 0 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — Transport failure is treated as proof that deletion did not happen

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/DashboardSummaries.tsx:243`; `src/lib/copy/pl.ts:248`
- **Detail**: A rejected browser `fetch` is ambiguous: Postgres may have committed the `DELETE` before the response was lost. The client nevertheless always removes the tombstone, restores the card, and says "Podsumowanie nie zostało usunięte." This conflicts with the repository's explicit transport-failure model in `src/lib/services/__fixtures__/supabase-stub.ts:110-112` (a rejected request may or may not have committed). The user can therefore see a ghost card and a false persistence claim until retry or reload.
- **Fix A ⭐ Recommended**: Reconcile an ambiguous transport result through the existing `GET /api/summaries`; keep the card removed if the id is absent, restore it if present, and use uncertainty copy if reconciliation also fails.
  - Strength: Resolves the outcome whenever the read path is available and never knowingly states the opposite of database state.
  - Tradeoff: Adds one conditional read and must preserve the existing `deletedIds`/refresh ordering guarantees.
  - Confidence: HIGH — the app already has an RLS-scoped list endpoint and a centralized list-commit filter.
  - Blind spot: Offline mode makes the reconciliation request fail too, so that branch still needs an explicit uncertain-state UX decision.
- **Fix B**: Keep the current rollback behavior but replace the definitive copy with an uncertainty message that asks the user to reload or retry.
  - Strength: Small, low-risk change that stops making a false claim and preserves the current recoverable card UI.
  - Tradeoff: A ghost card can remain visible until reload/retry even when the delete committed.
  - Confidence: HIGH — only the message contract changes.
  - Blind spot: Does not reconcile state automatically.
- **Decision**: FIXED via Fix A — a thrown `DELETE` fetch is now settled by `reconcileDelete(id)`, a read-only probe of `GET /api/summaries`: absent → the removal stands and the card stays gone with no message; present → the card returns with the existing network copy (now a verified claim); probe also failed → the card returns with new copy `summaryDeleteUnknown` ("Nie wiemy, czy podsumowanie zostało usunięte. Odśwież stronę, aby sprawdzić."). The tombstone stays in `deletedIds` across the probe, so a re-read landing mid-reconciliation still cannot resurrect the row, and the probe commits no list, so `refreshSeq`'s ordering keeps a single writer. `handleDelete`'s JSDoc was corrected to stop claiming a thrown fetch proves the row survived.

### F2 — Roadmap still routes agents to redo completed S-03 work

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/foundation/roadmap.md:382`; `context/foundation/roadmap.md:407`
- **Detail**: S-03 is marked implemented with all three phases landed, but Backlog Handoff still ends with `Next: /10x-implement delete-summary phase 3`, and Parked still says the slice remains proposed/parked. This misses the plan's epilogue requirement and the accepted lesson that roadmap status, Backlog Handoff, and lifecycle state must move together.
- **Fix**: Remove the stale phase-3 `Next` instruction and remove S-03 from Parked while preserving the current implemented/pending-review status text.
- **Decision**: FIXED — the Backlog Handoff row for S-03 now records all three phases as done (`8a73123`, `789cfca`, `8a61a23`, `7ea6cd5`) and points at merge + `/10x-archive` instead of `/10x-implement delete-summary phase 3`; the S-03 bullet was removed from `## Parked`. The `## Slices` status text (`implemented — 3/3 phases, 34/34 Progress rows, pending impl-review + merge`) was left as it stood.

### F3 — Plan sources do not record the implementation's accepted UI exceptions

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `context/changes/delete-summary/plan-brief.md:37`; `context/changes/delete-summary/plan-brief.md:38`; `context/changes/delete-summary/plan.md:533`; `src/components/summaries/DashboardSummaries.tsx:69`
- **Detail**: The brief says rollback happens only for 5xx/401/network even though the implementation rolls back every status other than 200/404 (including 400/503). The plan and brief also say every incoming list, including the initial prop, is filtered through `deletedIds`, while the implementation deliberately commits the initial prop directly because no deletion can precede the first render and React's refs lint rejects reading the ref during render. The code documents both behaviors, but the plan sources were not synchronized, contrary to the accepted derived-document lesson.
- **Fix**: Update `plan.md` and `plan-brief.md` together to state the actual non-200/404 rollback rule and the safe first-render exception for `initialSummaries`.
- **Decision**: FIXED — both documents were updated together, and describe the behaviour **after** F1's fix rather than the pre-review behaviour: an answered status other than `200`/`404` reverts the card, a thrown fetch is reconciled against `GET /api/summaries` (absent / present / probe-failed), and `initialSummaries` is named as the one list committed outside the `deletedIds` filter, with both reasons (nothing can be deleted before the first render; `react-hooks/refs` forbids reading the ref during render).

## Triage Outcome (2026-09-07)

All three findings were triaged and fixed. Code changed by triage: `src/components/summaries/DashboardSummaries.tsx` (new `reconcileDelete` probe, reworked `catch` branch, corrected `handleDelete` JSDoc) and `src/lib/copy/pl.ts` (new `summaryDeleteUnknown` key). Documents changed: `context/foundation/roadmap.md`, `context/changes/delete-summary/plan.md`, `context/changes/delete-summary/plan-brief.md`.

Re-verified after the fixes: `npm.cmd run lint` PASS · `npm.cmd run lint:tokens` PASS · `npm.cmd run typecheck` PASS · `npm.cmd run typecheck:astro` PASS (0 errors, 0 warnings, 5 pre-existing hints) · `npm.cmd test` PASS (5 files, 106 tests) · `npm.cmd run build` PASS. No test was added for F1: this repository has no component-level test layer — React islands are deliberately untested, with coverage living in `src/lib/**` and the API-route integration suites — so adding one would have introduced a new testing layer during triage. The two new branches are consequently covered only by manual verification.

## Verification Evidence

- `npm.cmd run lint` — PASS.
- `npm.cmd run typecheck` — PASS.
- `npm.cmd run typecheck:astro` — PASS (0 errors; five existing deprecation hints in `eslint.config.js`).
- `npm.cmd test` — PASS: 5 files, 106 tests.
- `npm.cmd run test:integration` — PASS: 9 files, 94 tests, including both delete suites and the unchanged authorization/cross-account suites.
- `npm.cmd run build` — PASS; Cloudflare SSR server build completed.
- `npx.cmd supabase migration up` — PASS; local database reports all migrations applied.
- Migration comparison — PASS: after replacing only the settled-with-no-summary diagnostic comment block, the old and new `begin_generation` definitions are sequence-identical (126 normalized lines; no remaining diff).
- Runtime catalog check — PASS: `prosecdef=true`, `search_path=""`, identity arguments `target_user uuid, request uuid, amount integer`; `anon` and `authenticated` cannot execute, `service_role` can.
- Manual Progress — all 14 manual rows are checked and carry implementation commit evidence; the Phase 3 pass is additionally documented in `change.md`. Phase 2's deliberate negative fault injection is inherently reverted and recorded in Progress/change history rather than left in the tree.
