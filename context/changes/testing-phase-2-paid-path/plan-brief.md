# Paid-path integration tests — Plan Brief

> Full plan: `context/changes/testing-phase-2-paid-path/plan.md`
> Research: `context/changes/testing-phase-2-paid-path/research.md`

## What & Why

Test-plan rollout Phase 2. The generation endpoint spends real money on every request, and it has 35 terminating exits — six charge, two charge-then-refund, one refuses without charging, and one returns 500 in three situations the code cannot tell apart. Nothing currently tests any of them. This change builds the net that proves every terminating path either delivers a summary or leaves the user's balance where it found it.

## Starting Point

Three unit test files exist, all pure or hermetic against an injected Supabase stub. There is no test infrastructure for the paid-vendor HTTP boundary and no test that touches an HTTP endpoint. `npm test` is deliberately env-less, and CI's own comment records that as a property worth keeping.

Research established the enabling fact empirically: `generate.ts` is reachable from Vitest once `astro:env/server` resolves to a stub module — no `getViteConfig()`, no Cloudflare adapter conflict, no production refactor. That overturned the assumption this phase was scoped around.

## Desired End State

Two runner projects. `npm test` keeps its current meaning and speed. `npm run test:integration` runs a new layer against the local Supabase stack, and a parallel CI job gates deployment alongside the existing one. The five stale records that test authors derive assertions from state what the code actually does, and `test-plan.md` §6.2 stops saying "TBD".

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Reachability | `resolve.alias` for `astro:env/server` | Proven by spike; no production change needed | Research |
| Isolation strategy | Hybrid — real DB for balances, stub for breaker | Puts each cost where it is actually required | Plan |
| Fresh-fetch on real DB | Forbidden | Keeps the paid cache and budget singleton out of reach by construction, not by assertion | Plan |
| Risk #2 oracle | Recorded fixtures only, no live vendor | CI holds no vendor keys, by hard rule | Plan |
| Risk #2 layer | Stub layer | Follows from forbidding fresh-fetch on the real DB | Plan |
| Runner split | Vitest `projects` | One place to declare the load-bearing aliases | Plan |
| Exit scope | Every exit with a credit effect, plus the trust boundary | ~15–18 exits; the rest are variants of the same 500 | Plan |
| CI shape | Separate parallel job, `deploy: needs [ci, integration]` | Wall clock is the max, not the sum | Plan |
| Exit #34 | Pin all three branches | A test phase should not change product behaviour, and the fork is only visible once split | Plan |
| Stale docs | Fix all five, incl. a comment-only migration | Two of them are what a correct test asserts against | Plan |
| `summarize` coverage | Its own unit test | Mocking `llm.ts` elsewhere would leave it uncovered | Plan |

## Scope

**In scope:** runner split and safety guards; vendor response fixtures; trust-boundary and refusal-exit coverage; budget breaker including every fail-open branch; spend reconciliation over the ledger payload; balance invariants on a real database; `summarize`'s contract; CI wiring; oracle corrections; the §6.2 cookbook.

**Out of scope:** any production code change; live vendor calls of any kind; fixing exit #34; fresh-fetch against the real database; a second Supabase stack; the Whisper job path; e2e, component rendering, Playwright.

## Architecture / Approach

Two layers, split at the isolation hazard rather than at convenience.

```
                  fake fetch (Supadata) + vi.mock (llm.ts)
                                  │
   ┌──────────────────────────────┴──────────────────────────────┐
   │ stub layer                      │ real-DB layer              │
   │ vi.mock on both client ctors    │ real local Supabase        │
   │ → refusal exits, trust boundary │ → balance before/after     │
   │ → breaker trip + fail-open      │ → refund, replay, exit #34 │
   │ → reconciliation payload        │ synthetic accounts, seeded │
   │ nothing shared to contaminate   │ cache so breaker is bypassed│
   └─────────────────────────────────┴────────────────────────────┘
```

Anything needing a **real balance** goes right; anything needing a **forced vendor or budget state** goes left, where no shared row exists to contaminate.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Oracle correction | Five stale records fixed, incl. a comment-only migration | Rewriting history instead of marking supersession |
| 2. Runner split and guards | Two projects, env stub, `globalSetup` guards | A diverging alias fails at import, not as an assertion |
| 3. Fixtures + `llm.test.ts` | Vendor response builders; `summarize` covered | Hand-written shapes drifting from the vendor's |
| 4. Stub layer | Trust boundary, refusals, breaker, reconciliation | Testing the trip and forgetting the fail-open |
| 5. Real-DB layer | Balance invariants, replay, exit #34's three branches | Contaminating the paid local dataset |
| 6. CI + cookbook | Parallel job gating deploy; §6.2 written | Copying production env into the integration job |

**Prerequisites:** Docker with the local Supabase stack; the stack's migrations applied. No vendor keys, by design.
**Estimated effort:** ~4–5 sessions across six phases; Phase 5 is the largest.

## Open Risks & Assumptions

- `supabase start` timing on a GitHub runner is estimated, not measured. If it dominates the PR, the fallback is image caching — not moving the layer out of CI.
- The integration tests create and delete `auth.users` rows. A copy-paste of the build step's production env into the integration job would run that against production; the `globalSetup` loopback guard is the mitigation and must land before any test that can connect.
- Exit #34 returns 500 in three different situations: the sweep already refunded (user whole), an operator settled by hand (credit lost), or the work actually succeeded (false failure report). Only the middle one is a defect, and fixing it means branching on `persisted.reason` — a product decision left open here.
- Reconciliation against recorded fixtures cannot detect a vendor pricing change or a dropped header — the failure modes reconciliation exists to catch. Recorded in §7 rather than left implicit.

## Success Criteria (Summary)

- Every exit with a credit effect is covered, and a failed generation demonstrably leaves the balance where it started.
- The budget breaker refuses cleanly at the threshold and, when the vendor counter is unreadable, does not take generation down.
- A full integration run leaves the local database's shared tables byte-identical — the 13 paid transcripts and the budget singleton untouched.
