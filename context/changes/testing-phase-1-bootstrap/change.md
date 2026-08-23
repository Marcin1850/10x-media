---
change_id: testing-phase-1-bootstrap
title: Test bootstrap + unit tests for the cost and credit decision rules
status: implementing
created: 2026-08-18
updated: 2026-08-23
archived_at: null
---

## Notes

Rollout Phase 1 of `context/foundation/test-plan.md` §3: "Test bootstrap + cost/credit rules".
Linear: MAR-19 (project *10xMedia MVP*, label `test-rollout`). Blocks MAR-20 (Phase 2) and MAR-23 (Phase 5).

Risks covered: #1 (a user's credits are spent and no summary comes back, or a refusal charges them silently), #5 (a crafted request drives the paid pipeline for free, or past a guard the UI enforces but the server does not).

Test types planned: unit.

Risk response intent:

- #1: prove that every terminating path either delivers a summary or leaves the balance where it found it, and that any deliberate charge-without-delivery is the documented one. The oracle comes from the documented credit rules, never from the implementation.
- #5: prove the server refuses what the UI would never send. Challenge the assumption that client-side validation implies server-side validation.

This phase stands up the test runner (none exists today: zero test files, no runner config) and covers the pure decision rules only. Integration, database and e2e layers belong to Phases 2-4.

Stack note: Astro 6 requires Vitest's `environment: 'node'` for tests rendering Astro components, and Astro exposes `getViteConfig()` from `astro/config`.

Per `context/foundation/lessons.md`: work happens on branch `testing-phase-1-bootstrap`; keep §3 Phase 1 Status and the MAR-19 state in sync at each lifecycle step.

## Research (2026-08-22) — `research.md`

Three scope decisions were taken with the user during research and are inputs to `/10x-plan`, not open questions:

1. **`allowLong: true` on a first, unprompted request is BY DESIGN** — pre-authorization, not a bypass of the 409 consent gate. Risk #5 must pin this as intended behaviour and must NOT assert a refusal. No code change.
2. **Phase 1 covers pure functions AND hermetic stub-client tests** (`chargeFailedTranscript`, `beginGeneration`) — zero infrastructure either way. Without this, risk #1 has almost no testable surface in this phase.
3. **`generateSchema` moves to `src/lib/schemas/`** and is imported by `generate.ts`; it is module-private today and unreachable from a test.

Findings that shape the plan: the endpoint has 35 terminating exits and **nothing charges by accident** — the four charging 422s are S-09 D14 by design. The real risk-#1 surface is the five-way `charged` truth table (`ambiguous` omits the field rather than guessing `false`). The real risk-#5 surface is `requestId` being required (S-09 P3 finding F1, a regression that already happened). `z.uuid()` in Zod 4 accepts any RFC UUID version, not v4 only — verified via Context7, and it contradicts a loose phrasing in the roadmap.

## Plan (2026-08-23) — `plan.md`, `plan-brief.md`

Five phases: runner bootstrap → risk #5 (trust boundary) → risk #1 (ledger truth table) → gates + mutation check → cookbook + status sync.

Planning decisions on top of research's three:

1. **Colocated `*.test.ts`** next to the module under test — `tsconfig`/ESLint already cover `src/**`.
2. **`beginGeneration` and `lookupRefusalReplay` are in scope**; `billedSince` and `readBillableCredits` are not (risk #2, Phase 2 — and the second is blocked by the doc-vs-code conflict in research's Open Questions).
3. **`refuseAndCharge` is NOT extracted** — research's own recommendation. The `REFUSAL_COPY` lookup and the `ambiguousCharge: true` body shape stay uncovered until Phase 2's request-boundary tests; the gap is stated in the plan rather than left to be discovered.
4. **Unit gate goes into CI now; pre-commit stays lint-only**, matching how `lint:tokens` and `build` are already gated.
5. **Coverage reporter (no thresholds) and Stryker both land** (user's call) — Stryker as a narrow ad-hoc check over `credits.ts`, never a CI gate.

Stryker's Vitest integration verified via Context7 on 2026-08-23: `@stryker-mutator/core` + `@stryker-mutator/vitest-runner`, default `mutate` glob already excludes `*.test.ts`, and `"vitest": { "related": false }` is the documented fallback if it cannot match tests to mutants.

Phases 2 and 3 are `/10x-tdd`-eligible; 1, 4 and 5 are `/10x-implement`.

No roadmap item carries this Change ID, so `roadmap.md` is untouched. MAR-19 moves to In Progress; per `lessons.md` it stays there until Phase 5 closes.
