# Summary Credits Implementation Plan

## Overview

Give every user a small **credit budget** that guards the paid transcript/LLM pipeline against runaway or accidental generation (roadmap **S-05**; guards the paid OpenRouter/Supadata budget). Each user starts with **5 credits**, generating a summary **spends one credit only after it succeeds**, and generation is **blocked server-side at zero credits before any paid call is made**. Refills are **manual-only** (an operator script) — no self-serve top-up. The balance is visible to the user on the dashboard.

## Current State Analysis

- **No per-user state table exists.** The schema has only `videos`, `summaries` (both `references auth.users(id) on delete cascade`) and `auth.users` (`supabase/migrations/20260613145120_videos_and_summaries.sql`). This slice adds the first per-user scalar state (`user_credits`).
- **The live generation path is the F-02 probe endpoint.** `src/pages/api/summaries/probe.ts` is the only real transcript→LLM→save call site today: it auth-guards on `context.locals.user`, config-guards `SUPADATA_API_KEY`/`OPENROUTER_API_KEY` (503), validates with zod (`extractYoutubeId`), fetches the transcript (Supadata, paid), calls `summarize` (OpenRouter, paid), then persists via `upsertVideoAndAppendSummary`. S-01's dedicated endpoint is **not built yet**, so enforcement wires in here now and S-01 reuses the same service later.
- **All app DB access is the anon-key SSR client** (`src/lib/supabase.ts`), RLS/JWT-scoped as the calling user. The service layer types it as `AppSupabaseClient` over a hand-written `AppDatabase` shape (`src/lib/services/summaries.ts:41-57`) because there are no generated DB types.
- **Client-forgeable writes are the core risk.** A credits column the `authenticated` role can `UPDATE` (or any client-callable increment RPC) lets a user set their own balance — defeating the guardrail. Decrement must be atomic and server-authoritative; there must be **no client-reachable path that raises a balance**.
- **Account deletion already anticipates credits.** The S-04 delete-account plan notes a credits table referencing `auth.users` will be purged by the existing cascade (`context/changes/delete-account/plan.md:17,36`) — so the FK must cascade.
- **Registration is effectively closed** (single MVP user, PRD Access Control), but seeding must still be robust to however users are created.
- **Dashboard is minimal** — `src/pages/dashboard.astro` server-renders `Astro.locals.user` and a sign-out form; a good host for a balance readout.
- **No test harness, no `tsx`/`dotenv`.** Verification is `npm run lint` + `npm run build` + manual. Node is v22.14 (`.nvmrc`), which supports `node --env-file=.env` and running plain `.mjs` scripts — so the operator script needs no new dependency.

## Desired End State

A new signup automatically has a `user_credits` row at balance **5**. Calling the generation endpoint with balance > 0 returns the summary and a decremented `creditsRemaining`; the dashboard shows the current count. Calling it at balance 0 returns **402** *before* Supadata/OpenRouter are ever hit — no money spent. A failed generation (e.g. transcript-unavailable 422, LLM error) costs **no** credit. A user cannot raise their own balance by any client-reachable call; the operator raises it with `npm run grant-credits -- <email> <n>`. Deleting the account removes the credits row via cascade.

### Key Discoveries:

- Cascade-FK pattern to mirror for the new table — `supabase/migrations/20260613145120_videos_and_summaries.sql:4-6,36`.
- Enforcement call site (auth/config/zod guards, save via service) — `src/pages/api/summaries/probe.ts:18-64`.
- Hand-written DB typing to extend (`AppDatabase`, `AppSupabaseClient`) — `src/lib/services/summaries.ts:40-57`.
- SSR anon client (RLS-scoped) — `src/lib/supabase.ts`; used everywhere, including the dashboard read.
- Delete-account expects credits to cascade — `context/changes/delete-account/plan.md:17,36`.

## What We're NOT Doing

- **No self-serve top-up / purchase / billing.** Refill is operator-only for the MVP.
- **No refund path.** Because credits are spent only after a successful save, there is nothing to refund — and this deliberately avoids any client-reachable increment (which would be mintable). See Implementation Approach.
- **No credit-cost variation.** Every generation costs exactly 1 credit regardless of length/model.
- **No ledger / audit trail of grants and spends** (MVP simplicity — no audit requirement exists). A single mutable balance only.
- **No service-role key in the request path.** The generation flow stays on the anon SSR client; the service-role key is used only by the offline operator script.
- **No strict concurrency guarantee.** The gate reliably caps _sequential_ overuse, but gate-and-spend are not atomic and the two paid calls run between them — so a _concurrent burst_ at balance N can trigger up to as many paid Supadata/OpenRouter calls as there are in-flight requests while only debiting N credits. Accepted at single-user, closed-registration MVP scale; **must be revisited before registration opens or S-01 exposes generation more widely** (see Open Risks).
- **No S-01 UI.** No generation form is built here; only the balance readout on the existing dashboard.

## Implementation Approach

**Spend-on-success with an up-front read gate**, chosen because it meets both goals — 0-credit users never reach a paid API, and failed generations cost nothing — while exposing **no** increment operation to clients:

1. **Gate (read-only):** before any paid call, read the caller's balance; if `≤ 0`, return **402** immediately.
2. **Generate:** fetch transcript → summarize → save, exactly as today.
3. **Spend (atomic, only after save):** call `spend_credit()`, a `SECURITY DEFINER` function that does a single conditional `UPDATE … balance = balance - 1 WHERE user_id = auth.uid() AND balance > 0 RETURNING balance`. It can only ever *lower* the caller's own balance, so it is safe to expose to `authenticated`.

Seeding is a `SECURITY DEFINER` trigger on `auth.users` insert (atomic, path-independent). Reads use ordinary RLS-scoped `SELECT` on the own row. There is intentionally **no** client-callable write that increases a balance — the only increments are the seed trigger and the offline service-role script.

## Critical Implementation Details

- **RLS: read-only for clients.** `user_credits` gets a `SELECT` policy for `authenticated` on the own row and **no** `INSERT`/`UPDATE`/`DELETE` policy. Balance changes flow exclusively through the `SECURITY DEFINER` functions (seed, spend) and the service-role script (which bypasses RLS). This is what makes the balance unforgeable.
- **`auth.uid()` inside `SECURITY DEFINER`.** The function runs as its owner but must key off the *caller* — use `auth.uid()` (Supabase populates it from the request JWT even under `SECURITY DEFINER`) and set `search_path = ''`/`public` explicitly to avoid search-path hijack. Grant `EXECUTE` to `authenticated` only; revoke from `public`/`anon`.
- **Insufficient-credit signal.** `spend_credit()` returns the new balance on success and a distinguishable "insufficient" signal (a `NULL`/`-1` sentinel, or 0 rows) when the row is missing or already 0 — the service maps that to "blocked", never an exception.
- **Spend-after-save race.** Because the spend happens after the save, a `spend_credit()` that reports insufficient (a concurrent request drained the balance) arrives when the summary is already persisted. Do **not** fail the request — the content exists; report `creditsRemaining: 0`. This is the accepted concurrency window, not an error path.
- **Backfill the existing user.** The seed trigger only fires on *future* inserts; the migration must also backfill `user_credits` for users already in `auth.users` (the single MVP user) so they aren't stuck at "no row / blocked".

## Phase 1: Data layer — table, RLS, seed trigger, spend function

### Overview

One migration that creates `user_credits`, its read-only RLS, the new-user seed trigger + backfill, and the atomic `spend_credit()` function. Verifiable directly in Supabase Studio / psql before any app code changes.

### Changes Required:

#### 1. Credits table + RLS

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_user_credits.sql` (new — use `/new-migration` or a real UTC timestamp)

**Intent**: Store one mutable balance per user, cascade-deleted with the account, readable only by its owner and never client-writable.

**Contract**: `create table if not exists public.user_credits (user_id uuid primary key references auth.users(id) on delete cascade, balance integer not null default 5 check (balance >= 0), updated_at timestamptz not null default now())`. Enable RLS. Add exactly one policy, using the repo's idempotent style (`drop policy if exists "user_credits_select_authenticated" on public.user_credits;` then `create policy`) — `user_credits_select_authenticated` `for select to authenticated using (auth.uid() = user_id)`. Add **no** insert/update/delete policy (writes go through definer functions / service-role only).

#### 2. New-user seed trigger + backfill

**File**: same migration

**Intent**: Every new account starts at 5 credits, regardless of how it's created; existing accounts get a row too.

**Contract**: `create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$ begin insert into public.user_credits (user_id) values (new.id) on conflict (user_id) do nothing; return new; end; $$;` + `drop trigger if exists on_auth_user_created on auth.users;` then `create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();`. Then backfill: `insert into public.user_credits (user_id) select id from auth.users on conflict (user_id) do nothing;`.

#### 3. Atomic spend function

**File**: same migration

**Intent**: The only client-reachable balance mutation — an atomic, conditional decrement of the caller's own balance that cannot be used to increase it.

**Contract**: `create or replace function public.spend_credit() returns integer language plpgsql security definer set search_path = ''` that runs `update public.user_credits set balance = balance - 1, updated_at = now() where user_id = auth.uid() and balance > 0 returning balance` into a variable and returns it, or returns a "insufficient" sentinel (`-1`) when no row was updated. `revoke all on function public.spend_credit() from public;` then `grant execute on function public.spend_credit() to authenticated;`. (`handle_new_user` needs no `authenticated` grant — it runs from the trigger.)

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase migration up` (local stack running)
- Type checking / lint passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- After `supabase db reset`, a newly signed-up user has a `user_credits` row with `balance = 5`.
- The pre-existing user has a backfilled row (not missing).
- Calling `select public.spend_credit()` as that user (Studio SQL as the `authenticated` role / via `rpc`) decrements by 1 and returns the new balance; repeating past 0 returns the insufficient sentinel and never goes negative.
- A direct `update public.user_credits set balance = 999` as the `authenticated` role is **rejected** by RLS (no update policy); a `select` returns only the caller's own row.

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation (seed + spend + RLS-rejection checks in Studio) before starting Phase 2. Phase blocks use plain bullets — checkbox state lives in `## Progress`.

---

## Phase 2: Credits service + enforcement in the generation path

### Overview

Add a reusable `credits` service over the new table/function, type it into `AppDatabase`, and wire the read-gate + spend-on-success into `probe.ts`, returning `creditsRemaining`.

### Changes Required:

#### 1. Extend the DB type shape

**File**: `src/lib/services/summaries.ts` (the `AppDatabase` definition)

**Intent**: Teach the typed client about the new table and RPC so the service is type-safe.

**Contract**: Add a `user_credits` entry to `AppDatabase["public"]["Tables"]` (`Row: { user_id: string; balance: number; updated_at: string }`, `Insert`/`Update` partials) and add `spend_credit` to `Functions` (`{ Args: Record<string, never>; Returns: number }`). No behavior change to existing exports.

#### 2. Credits service

**File**: `src/lib/services/credits.ts` (new)

**Intent**: One place that owns "read my balance" and "spend one credit", so both the probe endpoint and the future S-01 endpoint share identical enforcement.

**Contract**: Export `getBalance(supabase: AppSupabaseClient, userId: string): Promise<number | null>` (RLS-scoped `select balance` on the own row; `null` if no row) and `spendCredit(supabase: AppSupabaseClient): Promise<{ ok: boolean; balance: number }>` wrapping `rpc("spend_credit")` — `ok: false` when the RPC returns the insufficient sentinel, else `ok: true` with the new balance. No throwing on "insufficient"; reserve throws for genuine DB errors.

#### 3. Enforce in the generation endpoint

**File**: `src/pages/api/summaries/probe.ts`

**Intent**: Block zero-credit callers before any paid call and spend exactly one credit per successful save, surfacing the remaining balance.

**Contract**: After the auth guard and before the transcript fetch, build the SSR client, read `getBalance`; if `null` or `≤ 0` → `402 { error: "You have no summary credits left" }` (no Supadata/OpenRouter call). Keep transcript/LLM/save unchanged. **After** a successful `upsertVideoAndAppendSummary`, call `spendCredit`; include `creditsRemaining` (the returned balance, or `0` if the post-save spend reports insufficient — see Critical Implementation Details) in the existing `Response.json({...})`. The `402` path must sit above the transcript fetch so a blocked user triggers no paid work. **Post-save spend errors must not fail the request:** because the summary is already persisted, a genuine DB error thrown by `spendCredit` (as opposed to the "insufficient" sentinel) must be caught, logged, and the response still returned `200` with the summary — set `creditsRemaining` from a best-effort re-read of `getBalance` (or omit it) rather than letting the throw surface as a `500`. Never return an error after a successful save.

### Success Criteria:

#### Automated Verification:

- Type checking / lint passes: `npm run lint`
- Build passes: `npm run build`
- Prettier clean: `npm run format`

#### Manual Verification:

- With balance 0, `POST /api/summaries/probe` returns `402` and (via `wrangler tail` / no Supadata/OpenRouter activity) makes no paid call.
- With balance > 0, a successful call returns the summary plus `creditsRemaining` one lower than before, and the `user_credits` row is decremented by exactly 1.
- A generation that fails at transcript (422) or LLM error leaves the balance unchanged (no spend).
- Signed-out request still returns `401` (unchanged).

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation of the block-at-zero + spend-once + no-charge-on-failure behavior before starting Phase 3.

---

## Phase 3: Balance display on the dashboard

### Overview

Show the user their remaining credits on the existing dashboard, server-rendered from the RLS-scoped read.

### Changes Required:

#### 1. Render the balance

**File**: `src/pages/dashboard.astro`

**Intent**: Give the single MVP user an at-a-glance view of their remaining budget.

**Contract**: In the frontmatter, build the SSR client (`createClient(Astro.request.headers, Astro.cookies)`) and read the balance via the `credits` service `getBalance` (or an inline own-row `select`). Render "N credits left" inside the existing glass card, matching the cosmic theme (`cn()`, existing Tailwind classes). Handle a `null`/missing row gracefully (treat as 0 / "—").

### Success Criteria:

#### Automated Verification:

- Type checking / lint passes: `npm run lint`
- Build passes: `npm run build`
- Prettier clean: `npm run format`

#### Manual Verification:

- The dashboard shows the correct current balance for the signed-in user.
- After a successful generation, reloading the dashboard shows the decremented count.
- No visual regression to the dashboard card / cosmic theme.

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation of the readout before starting Phase 4.

---

## Phase 4: Manual refill operator script

### Overview

A standalone Node script that lets the operator grant credits to a user by email, using the service-role key offline (never in the request path).

### Changes Required:

#### 1. Grant-credits script

**File**: `scripts/grant-credits.mjs` (new)

**Intent**: The manual-only refill mechanism — raise a user's balance without exposing any client-reachable increment.

**Contract**: A plain `.mjs` run via `node --env-file=.env scripts/grant-credits.mjs <email> <amount>`. Reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from env; builds a `@supabase/supabase-js` client with the service-role key (`auth: { autoRefreshToken: false, persistSession: false }`); resolves the `user_id` from `<email>` via `auth.admin.listUsers()`; runs `update user_credits set balance = balance + <amount>, updated_at = now() where user_id = …` (service-role bypasses RLS); prints the resulting balance. Validates that `<amount>` is a positive integer and that the user/row exists, exiting non-zero with a clear message otherwise.

#### 2. npm task + docs

**File**: `package.json`, `.env.example`, `README.md`

**Intent**: Make the refill runnable and document the required secret.

**Contract**: Add `"grant-credits": "node --env-file=.env scripts/grant-credits.mjs"` to `scripts` (invoked as `npm run grant-credits -- <email> <n>`). Add `SUPABASE_SERVICE_ROLE_KEY=###` to `.env.example` with a one-line note (the `service_role` key from `npx supabase status` locally / dashboard → Settings → API), and a short README subsection describing the refill command. No Worker/`astro.config.mjs` env-schema change — the key is used only by this offline script.

### Success Criteria:

#### Automated Verification:

- Lint/build unaffected: `npm run lint` && `npm run build`
- Prettier clean: `npm run format`

#### Manual Verification:

- `npm run grant-credits -- <existing-email> 5` raises that user's balance by 5 and prints the new value; the dashboard reflects it.
- A non-existent email or non-positive amount exits non-zero with a clear error and changes nothing.
- Running without `SUPABASE_SERVICE_ROLE_KEY` set fails fast with an actionable message.

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation of a real grant before considering the slice done.

---

## Testing Strategy

### Unit Tests:

- No unit-test harness exists in the repo; do not introduce one for this slice. Verification is `npm run lint` + `npm run build` + the manual steps below.

### Integration Tests:

- Covered by the manual E2E steps (seed → gate-at-zero → spend-on-success → no-charge-on-failure → refill).

### Manual Testing Steps:

1. `npx supabase db reset` (applies the new migration); sign up a throwaway user; confirm `user_credits.balance = 5` in Studio.
2. `POST /api/summaries/probe` with a good URL 5 times → each returns a decremented `creditsRemaining`; the 6th returns `402` with no Supadata/OpenRouter activity in `wrangler tail`.
3. Point at a video with no transcript → `422`, balance unchanged.
4. Attempt `update public.user_credits set balance = 999` as the authenticated user in Studio → rejected by RLS.
5. Load `/dashboard` → shows the current count; regenerate → reload shows it decremented.
6. `npm run grant-credits -- <email> 5` → balance rises by 5; dashboard reflects it; bad email/amount fails cleanly.
7. (Cross-check) Delete the account (if S-04 is present) → the `user_credits` row is gone via cascade.

## Performance Considerations

Negligible: one indexed primary-key `SELECT` per generation (the gate) and one single-row `UPDATE` (the spend); the dashboard adds one PK read per page load. No hot path.

## Migration Notes

Single additive migration — new table, policy, function, trigger, and a one-time backfill; no changes to existing tables, so no data migration risk. The `SUPABASE_SERVICE_ROLE_KEY` is required **only** for the offline operator script (local `.env`); it is **not** wired into the Worker runtime here. If S-04 (delete-account) later adds the same key to the Astro env schema for its endpoint, that is compatible and independent.

## References

- Roadmap slice S-05: `context/foundation/roadmap.md:146-159`
- Cascade-FK + RLS pattern: `supabase/migrations/20260613145120_videos_and_summaries.sql`
- Enforcement call site: `src/pages/api/summaries/probe.ts:18-64`
- DB typing to extend: `src/lib/services/summaries.ts:40-57`
- SSR anon client: `src/lib/supabase.ts`
- Delete-account cascade expectation: `context/changes/delete-account/plan.md:17,36`
- Change identity: `context/changes/summary-credits/change.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer — table, RLS, seed trigger, spend function

#### Automated

- [ ] 1.1 Migration applies cleanly: `npx supabase migration up`
- [ ] 1.2 Type checking / lint passes: `npm run lint`
- [ ] 1.3 Build passes: `npm run build`

#### Manual

- [ ] 1.4 New signup has a `user_credits` row with `balance = 5`
- [ ] 1.5 Pre-existing user has a backfilled row
- [ ] 1.6 `spend_credit()` decrements to 0 and then returns the insufficient sentinel without going negative
- [ ] 1.7 Direct client `UPDATE`/cross-user `SELECT` on `user_credits` is rejected by RLS

### Phase 2: Credits service + enforcement in the generation path

#### Automated

- [ ] 2.1 Type checking / lint passes: `npm run lint`
- [ ] 2.2 Build passes: `npm run build`
- [ ] 2.3 Prettier clean: `npm run format`

#### Manual

- [ ] 2.4 Balance 0 → `402` with no Supadata/OpenRouter call
- [ ] 2.5 Successful call returns `creditsRemaining` and decrements the row by exactly 1
- [ ] 2.6 Transcript-422 / LLM error leaves the balance unchanged
- [ ] 2.7 Signed-out request still returns `401`

### Phase 3: Balance display on the dashboard

#### Automated

- [ ] 3.1 Type checking / lint passes: `npm run lint`
- [ ] 3.2 Build passes: `npm run build`
- [ ] 3.3 Prettier clean: `npm run format`

#### Manual

- [ ] 3.4 Dashboard shows the correct current balance
- [ ] 3.5 Balance display decrements after a successful generation
- [ ] 3.6 No visual regression to the dashboard / cosmic theme

### Phase 4: Manual refill operator script

#### Automated

- [ ] 4.1 Lint/build unaffected: `npm run lint` && `npm run build`
- [ ] 4.2 Prettier clean: `npm run format`

#### Manual

- [ ] 4.3 `npm run grant-credits -- <email> <n>` raises the balance and prints the new value
- [ ] 4.4 Bad email / non-positive amount fails cleanly and changes nothing
- [ ] 4.5 Missing `SUPABASE_SERVICE_ROLE_KEY` fails fast with an actionable message
