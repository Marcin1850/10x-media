# Summary Credits — Plan Brief

> Full plan: `context/changes/summary-credits/plan.md`

## What & Why

Guard the paid transcript/LLM pipeline against runaway or accidental generation (roadmap **S-05**; guards the paid OpenRouter/Supadata budget). Every user starts with **5 credits**; each successful summary spends one; generation is blocked server-side at zero **before any paid API is called**. Refills are operator-only for the MVP.

## Starting Point

The schema has only `videos`/`summaries` + `auth.users` — no per-user state table. The live transcript→LLM→save path is the F-02 probe endpoint (`src/pages/api/summaries/probe.ts`); S-01's dedicated endpoint isn't built yet, so enforcement wires in here and S-01 reuses the same service later. All DB access is the RLS-scoped anon SSR client.

## Desired End State

New signups auto-seed to 5 credits. A generation at balance > 0 returns the summary + a decremented `creditsRemaining`, shown on the dashboard. A generation at balance 0 returns **402** before Supadata/OpenRouter run (no money spent). Failed generations cost nothing. A user cannot raise their own balance by any client call; the operator does it with `npm run grant-credits -- <email> <n>`. Account deletion purges the credits row via cascade.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Storage | Dedicated `user_credits` table (PK → auth.users, cascade) | Purpose-built, atomic single-column decrement, nothing else needs a general profile yet | Plan |
| Seeding | `SECURITY DEFINER` trigger on `auth.users` insert + backfill | Atomic, un-bypassable, path-independent; backfill covers the existing user | Plan |
| Spend safety | `SECURITY DEFINER spend_credit()`, **no** client write policy | Atomic conditional decrement that can only lower the caller's own balance | Plan |
| Spend model | Read-gate up front, spend **only after successful save**, no refund | Meets both goals (0-credit blocked pre-paid-call; failures cost nothing) with no mintable increment | Plan (revised) |
| Call site | Reusable `credits` service, wired into `probe.ts` now | The only live generation path today; S-01 reuses the service | Plan |
| Balance UI | Server-rendered readout on the dashboard + `creditsRemaining` in response | At-a-glance budget for the single MVP user at near-zero UI cost | Plan |
| Refill | Offline `grant-credits.mjs` service-role script | Manual-only refill with no client-reachable increment | Plan |

## Scope

**In scope:** `user_credits` table + read-only RLS; seed trigger + backfill; atomic `spend_credit()`; `credits` service; enforcement (gate + spend) in `probe.ts`; dashboard balance readout; operator refill script + docs.

**Out of scope:** self-serve top-up/billing; refund path; per-generation cost variation; ledger/audit trail; service-role in the request path; strict concurrency guarantee; any S-01 generation UI.

## Architecture / Approach

**Spend-on-success + up-front read gate.** Endpoint reads balance → `402` if ≤ 0 (before paid calls) → generate → after a successful save, call the atomic `spend_credit()` RPC. The only balance *increases* are the seed trigger and the offline service-role script — there is deliberately no client-reachable increment, which is what makes the balance unforgeable. RLS gives clients read-only access to their own row.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Data layer | `user_credits` table, RLS, seed trigger + backfill, `spend_credit()` | Getting `SECURITY DEFINER` + `auth.uid()` + search_path right |
| 2. Service + enforcement | `credits` service + gate/spend wired into `probe.ts`, `creditsRemaining` | Correct ordering (gate before paid calls; spend after save) |
| 3. Balance display | Dashboard shows remaining credits | Trivial; SSR read + theme match |
| 4. Refill script | `npm run grant-credits -- <email> <n>` | Handling the service-role secret safely, offline only |

**Prerequisites:** F-01 (done). Local Supabase stack for migration + manual E2E; `SUPABASE_SERVICE_ROLE_KEY` in local `.env` for Phase 4.
**Estimated effort:** ~2 sessions across 4 phases (Phase 1–2 are the substance; 3–4 are small).

## Open Risks & Assumptions

- **Concurrency window:** gate-and-spend are not atomic (paid calls run between them), so a concurrent burst at balance N can trigger up to N-plus paid calls while debiting only N credits — the gate caps sequential overuse, not a burst. Accepted at single-user, closed-registration MVP scale; **must be revisited before registration opens / S-01 widens exposure**.
- **Assumes `auth.uid()` resolves inside the `SECURITY DEFINER` functions** (standard Supabase behavior) — verified in Phase 1's manual checks.
- **Enforcement lives in `probe.ts` today.** When S-01 builds its own endpoint it must call the same `credits` service, or the gate is bypassed.

## Success Criteria (Summary)

- A zero-credit user is blocked with **402** and triggers **no** paid transcript/LLM call.
- Each successful generation spends exactly one credit; failed generations cost none; the dashboard shows the current balance.
- No client-reachable action can raise a balance; the operator script can.
