# Generate and Save a Video Summary (S-01) Implementation Plan

## Overview

S-01 is the roadmap's north star: paste a YouTube URL, pick the channel character (informational or educational), and get a Polish summary that is saved. The transcript→LLM→persist backend was already built and verified live on the Worker during the F-02 probe (`POST /api/summaries/probe`). This plan turns that proven spike into the user-facing feature — a dashboard form and inline result — while carrying F-02's three deferred follow-ups (prompt-engineering, transcript-length guard, upstream-error handling) and adding a variable-cost path for long videos.

## Current State Analysis

The entire generation pipeline exists and works:

- **`src/pages/api/summaries/probe.ts`** — auth guard (401), zod validation (400), credit read-gate (402), `fetchTranscript` (422 on unavailable), `summarize`, append-only persist, `spendCredit`. Returns `{ summary, model, videoId, summaryId, creditsRemaining }`.
- **Services** (`src/lib/services/`): `transcript.ts` (Supadata, polls Whisper jobs, returns `{ ok, content, resolvedVia }`), `llm.ts` (OpenRouter `anthropic/claude-sonnet-5`, one-line Polish system prompts), `summaries.ts` (`extractYoutubeId` URL validation + get-or-create video + append summary), `credits.ts` (`getBalance`, `spendCredit` → `spend_credit()` RPC, spends exactly **1**).
- **Schema** (F-01 + S-05): `videos`/`summaries` with per-user RLS, `summaries.model` + `summaries.resolved_via` columns; `user_credits` (read-only RLS, seed trigger, atomic `spend_credit()`).
- **Middleware** protects `/dashboard`, `/account`; resolves `context.locals.user`.
- **Dashboard** (`src/pages/dashboard.astro`) shows the credit count but has **no generation UI**.
- **Copy** is mostly English (auth, dashboard); the only Polish *chrome* is `config-status.ts` messages + the notice banner in `Layout.astro` (`Uwaga:`, `Dokumentacja` fallback). The `llm.ts` system prompts are Polish because they *produce* Polish summaries (product content, not chrome).

### Key Discoveries

- The probe endpoint (`src/pages/api/summaries/probe.ts:19-89`) is effectively the production endpoint minus a proper name, the long-video cost path, and upstream-error handling.
- `spend_credit()` (`supabase/migrations/20260712175240_user_credits.sql:48-71`) spends exactly 1; a variable cost needs a new atomic `spend_credits(amount)` RPC following the same SECURITY-DEFINER / empty-`search_path` / `-1` sentinel shape.
- Least-privilege for functions is enforced by `20260714140000_assert_least_privilege_functions.sql` (`authenticated`-only EXECUTE; `anon`/`public` revoked; default privileges revoked for `anon`). New functions must repeat this pattern in their own migration.
- Migrations are **already live on the cloud project** (roadmap S-05 note) — they are immutable. All changes go in a new forward migration; dropping `spend_credit()` there is forward-safe.
- `extractYoutubeId` (`src/lib/services/summaries.ts:82`) is a pure function whose only imports are type-only — safe to reuse in a client island (types erase at build).
- The existing form/UI pattern is custom Tailwind on the cosmic theme (`src/components/auth/FormField.tsx`, `SubmitButton.tsx`, `ui/button.tsx`), not shadcn primitives.

## Desired End State

A signed-in user on `/dashboard` sees a generation form: a YouTube URL field, an informational/educational selector, and an "allow long videos" toggle. Submitting shows a loading state, then renders the Polish summary inline below the form and decrements the visible credit count. A summary of a **long** video (>40k transcript chars) costs **2 credits** instead of 1; if the user hasn't pre-authorized that, the server asks for confirmation and the UI offers a "Generate anyway (2 credits)" button. Every failure mode (no credits, no transcript, upstream failure, not configured) surfaces as a clear English inline message with the inputs preserved for retry. The de-risk-era `probe` route no longer exists; the production route is `POST /api/summaries/generate`.

Verify: sign in, generate a normal video (1 credit spent, Polish summary shown, saved to `summaries`), generate a >40k-char video (confirmation → 2 credits), exhaust credits (blocked at 0), and try an unavailable-transcript video (clear message, no credit spent).

## What We're NOT Doing

- **Browsing** the summary list (S-02) or a summary **detail/permalink** page — the result is shown transiently inline; it is persisted and S-02 will surface it.
- **Deleting** summaries (S-03).
- Full **design-system** restyle (S-06) — the form matches the existing custom cosmic theme; polish comes later.
- ~~**No schema change to `summaries`** — we do not store per-summary credit cost, and `videos.title`/`thumbnail_url` stay null (no metadata fetch).~~ **Amended (impl-review F16)**: `summaries.reservation_id` was added in `20260722120000` — a nullable, unique link to the `credit_reservations` row that paid for the summary, composite-FK'd to `(id, user_id)` so the link is DB-validated as same-user. It is billing provenance (what makes reconciliation and F22 replay possible), not a per-summary cost display: there is still no credit-cost column, and `videos.title`/`thumbnail_url` stay null.
- **Token-accurate** cost measurement — character count is the proxy (see Cost policy).
- ~~**Markdown rendering** of summaries — plain text with preserved line breaks.~~ **Amended in Phase 7**: summaries are now authored as Markdown and rendered with `react-markdown` in the dashboard island (themed `components` map, HTML escaped by default). Pulled in at the user's request during the Phase 7 manual-quality pass — S-06 concerns app design, not summary content formatting.
- **Streaming** responses or structured LLM output.
- **Tests / test tooling** — manual verification only (roadmap defers testing to Module 3).
- Any change to **F-01's** existing columns or RLS. (Still holds after the amendment above: `summaries.reservation_id` is an *added* nullable column — no existing column, constraint, or policy was altered.)

## Implementation Approach

Build backend-first in curl-verifiable increments, then the UI. Isolate the cross-cutting English-copy cleanup first (smallest, independent). Then: the DB primitive (variable spend), the pure cost policy, the endpoint productionization, the confirmation gate, and the dashboard island. Prompt engineering comes next-to-last because judging and iterating on output quality is manual work and is most useful after the complete generation flow exists. A final **contract migration (Phase 8)** drops the retired `spend_credit()` — but only after the phases 1–7 Worker (which calls the new `spend_credits`) is confirmed live on cloud, since dropping it any earlier reopens the deploy window this slice deliberately avoids. Each phase is independently verifiable; the UI and prompt-quality phases require manual browser/API checks.

## Critical Implementation Details

> **Amended 2026-07-23 (impl-review F25).** The bullets below are the **current, normative** contract, resynchronized with the accepted post-review fixes F1–F24. The primitives the original plan named — a bare `spend_credits`/`refund_credits` pair, a single expand migration, an accepted double transcript fetch, plain-text output — were superseded during implementation. Superseded behavior is kept only as the labeled *Superseded* history under each bullet, so Phases 2–6 and Phase 8 read against one source of truth.

- **Migration immutability + expand/contract** (F3): live migrations are never edited; every change is a new forward migration, and every one of them is **expand-only** — the superseded function is left in place so the running Worker keeps working until the new one is deployed. Nine forward migrations now chain this way: `20260719120000` (variable spend) → `20260720133000` (generation locks) → `20260720160000` (reservation ledger) → `20260720170000` (owner-scoped lease) → `20260722120000` (summary↔reservation link + reconcile) → `20260722130000` (transcript spend guards) → `20260723120000` (atomic persist+settle) → `20260723130000` (idempotency key) → `20260723140000` (quote lifecycle). Every drop is deferred to the single deploy-gated **contract migration (Phase 8)**.
- **Up-front gate ordering**: unchanged — the minimum-1-credit balance *read* gate stays **before** any paid Supadata/OpenRouter call, so a zero-balance user never triggers one. It is a gate, not a serialization point; the atomic debit below is.
- **One generation in flight per user** (impl-review F4/F10): the endpoint holds an owner-scoped **generation lease** around the whole pipeline — `acquire_generation_lease` returns an opaque lease id, and `release_generation_lease` (in a `finally`) verifies that id before releasing. Without it, concurrent requests would each pay for their own transcript fetch before the atomic debit rejected all but the affordable ones. The lease id is what makes stale-lock takeover safe: a displaced request's release is a logged no-op instead of unlocking a successor that is still running. Contention → `429`.
- **Debit before paid LLM work, as a durable reservation** (F1, extended by impl-review F9/F16/F22): after the transcript length is known and any 409 confirmation is resolved, the debit runs through **`begin_generation(target_user, request, amount)`** — service-role only — which in ONE transaction claims the client's request key and opens a `credit_reservations` row in `reserved`. Its row-level `UPDATE … WHERE balance >= cost` is the concurrency serialization point, so parallel requests sharing one stale balance read cannot all overspend (losers come back `insufficient` → 402). Only after a successful debit does the paid `summarize` call run; on any failure past it, `refund_reservation` releases the debit (best-effort, idempotent, never throws) and the request returns 502/500. A row left `reserved` is a durable, queryable debt rather than a silently charged user — `reconcile_reservation()` is the recovery path. A race-losing request may still have paid the cheaper transcript fetch (bounded by the rate limit below).
  - *Superseded*: the bare `spend_credits(cost)` / `refund_credits(user, amount)` pair. A bare refund could neither survive its own failure (nothing recorded the debt) nor be safely retried (nothing distinguished a retry from a second credit), which is why the ledger replaced it.
- **Persist and settle in one transaction** (impl-review F23): the summary insert and the settlement are a single service-role RPC, **`persist_summary()`**, which locks the `reserved` row, upserts the video, inserts the linked summary, and marks the reservation `settled` — atomically. A rollback therefore persists nothing, so refunding is unambiguously correct, and a later owner-initiated summary delete cannot rewrite the billing outcome. `summarize()` carries an explicit `AbortSignal.timeout(300_000)` deadline, chosen to sit under the 600s lease window (after the transcript poll's ~240s worst case) and far below the one-hour reconciliation sweep.
  - *Superseded*: an RLS-client insert followed by a best-effort settle. `settleReservation` is gone from `credits.ts`; the `settle_reservation()` RPC remains in the database as an operator recovery tool only.
- **Idempotent retries** (impl-review F22): the request carries an optional client-generated `requestId` (UUID). A partial unique index on `credit_reservations (user_id, request_id) where request_id is not null and status <> 'refunded'` makes a repeat POST detectable, and `begin_generation` answers `reserved` / `fresh` / `replay` / `in_progress` / `unavailable` / `insufficient`. A **replay** returns the original summary verbatim — no second charge, no second OpenRouter call, no second row. The endpoint asks the identity question twice: a cheap probe (`amount: null`) *before* the paid transcript fetch, and again atomically at the debit, which is what actually decides. A null key skips deduplication entirely, which is what keeps the migration expand-only for a cached pre-F22 client.
- **Paid transcript fetches are guarded, not repeated** (impl-review F17/F24): every genuine paid fetch first passes a per-user rate limit (`record_transcript_attempt`, 10 attempts / 10 min) that fails **closed** on a DB error and returns `429` when capped. A long video's 409 caches the transcript as a short-lived **quote** (`save_transcript_quote`, 10-min TTL) that the `allowLong` retry reuses, so confirmation costs nothing extra. A quote dies at the earliest of: consumed (`discard_transcript_quote`, called once the summary commits), superseded (exact-key expired delete), pruned (`prune_transcript_quotes`, bounded, driven from both quote RPCs so the table is self-limiting with no scheduled job), or cascaded on account deletion.
  - *Superseded*: "**Double transcript fetch on confirm** — when a long video hits the 409 gate the transcript was already fetched, and the 'Generate anyway' resubmit fetches it again. Accepted MVP tradeoff." A re-fetch now happens only when the quote is missing or expired.
- **Empty transcripts are unavailable** (impl-review F13): a whitespace-only or empty transcript returns the same `422` as a missing one — before pricing, before any debit, before the LLM call.
- **Summaries render as Markdown behind an allow-list** (impl-review F2): LLM output is untrusted (transcript content can steer it), so the island renders it with `react-markdown` restricted to `SUMMARY_ALLOWED_ELEMENTS` plus `unwrapDisallowed`. `img`/`a` cannot render (no attacker-controlled fetch or navigation target) and raw HTML is escaped by react-markdown's default, so no extra sanitizer is needed.

---

## Phase 1: Existing UI copy → English

### Overview

Standardize the only Polish *chrome* to English so the app is consistent with the new English generation UI. Excludes the `llm.ts` system prompts (they produce Polish summaries — handled in Phase 7).

### Changes Required:

#### 1. Config-status messages

**File**: `src/lib/config-status.ts`

**Intent**: Translate the two `message` strings and the `docsLabel` to English, matching the app's English chrome.

**Contract**: `configStatuses[].message` and `docsLabel` become English (e.g. "Supabase is not configured — authentication features are disabled."; "Transcript/LLM is not configured — summary generation is disabled."; docsLabel → "See the configuration guide"). `name` fields may stay or be Englishized ("Transcript / LLM"); no structural change.

#### 2. Notice banner chrome

**File**: `src/layouts/Layout.astro`

**Intent**: Translate the inline banner labels that live in the layout, not in the config object.

**Contract**: `<strong>Uwaga:</strong>` → `<strong>Notice:</strong>`; the `?? "Dokumentacja"` fallback → `?? "Documentation"`. No logic change.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- With a key intentionally unset, the notice banner renders entirely in English.

**Implementation Note**: After automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: DB — variable-cost credit spend

### Overview

Add an atomic `spend_credits(amount)` RPC so a generation can cost more than 1 credit, retire the fixed `spend_credit()`, and route the credits service through the new function.

> **Amended 2026-07-23 (impl-review F25).** This phase landed as written (`23d59cc`) and its migration is immutable, so the SQL below stays as the historical record of what shipped. It is **no longer the live contract**: `spend_credits`/`refund_credits` were superseded by the F9 reservation ledger (`20260720160000`) and then by F22's `begin_generation` on the generate path. The current shape of the two code files this phase touched is recorded under items 2 and 3; the superseded RPCs are dropped in Phase 8.

### Changes Required:

#### 1. New migration: `spend_credits(amount)`

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_spend_credits_variable.sql`

**Intent**: Create (a) an atomic, owner-scoped, variable-amount **spend** that can only ever lower the caller's own balance, granted to `authenticated` only, and (b) a **refund** that restores a debit on a failed generation. Because refund *raises* a balance, a user-callable refund would let anyone self-credit — so `refund_credits` takes an explicit `user_id` and is granted to **`service_role` only** (invoked via the admin client, never the user's SSR client). This migration is **expand-only**: it leaves the old `spend_credit()` in place (the contract-phase drop is deferred — see F3 / Migration Notes).

**Contract**: Both functions mirror `spend_credit()`'s shape (SECURITY DEFINER, `set search_path = ''`). `spend_credits` returns the new balance or the `-1` sentinel. Its signature is the contract Phase 2's service and later phases depend on:

```sql
create or replace function public.spend_credits(amount integer default 1)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_balance integer;
begin
  if amount is null or amount < 1 then
    raise exception 'amount must be a positive integer, got: %', amount;
  end if;
  update public.user_credits
  set balance = balance - amount, updated_at = now()
  where user_id = auth.uid() and balance >= amount
  returning balance into new_balance;
  if new_balance is null then
    return -1;
  end if;
  return new_balance;
end;
$$;

revoke all on function public.spend_credits(integer) from public, anon;
grant execute on function public.spend_credits(integer) to authenticated;

-- Refund restores a debit after a failed generation. It RAISES a balance, so it
-- must never be user-callable: service_role only, invoked via the admin client.
create or replace function public.refund_credits(target_user uuid, amount integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if amount is null or amount < 1 then
    raise exception 'amount must be a positive integer, got: %', amount;
  end if;
  update public.user_credits
  set balance = balance + amount, updated_at = now()
  where user_id = target_user;
end;
$$;

revoke all on function public.refund_credits(uuid, integer) from public, anon, authenticated;
grant execute on function public.refund_credits(uuid, integer) to service_role;

-- NOTE (F3): do NOT drop spend_credit() here. This migration is expand-only so
-- the old Worker keeps working until the new one is deployed. The drop lands in a
-- later contract migration once the new Worker (calling spend_credits) is live.
```

#### 2. Credits service: variable amount

**File**: `src/lib/services/credits.ts`

**Intent**: Let `spendCredit` spend N credits via the new RPC, defaulting to 1; keep the `-1` insufficient-sentinel handling and `SpendResult` shape unchanged. Add a `refundCredits` that reverses a debit on a failed generation via the **admin** client.

**Contract (superseded — what this phase shipped)**: `spendCredit(supabase, amount = 1)` calls `.rpc("spend_credits", { amount })`. Same `{ ok, balance }` return shape, but on the `-1` insufficient sentinel it **re-reads the caller's actual balance via `getBalance`** for `{ ok: false, balance }` instead of hard-coding `0` (F4) — otherwise a 2-credit spend at balance 1 would report 0 and the 402 "you have &lt;balance&gt;" message would be wrong. New `refundCredits(admin, userId, amount)` (admin = `createAdminClient()` result) calls `.rpc("refund_credits", { target_user: userId, amount })`; it is a best-effort compensating action — on error (including a null admin client when the service-role key is unset) it logs and resolves without throwing, so it never masks the original generation failure being returned to the user.

**Contract (current, after F9/F22/F23)**: `credits.ts` exports four functions, and `spendCredit`/`refundCredits` are gone.
- `getBalance(supabase, userId?)` — unchanged; RLS-scoped when `userId` is omitted, `null` when no row exists.
- `reserveCredits(supabase, amount = 1)` → `reserve_credits()`; opens a `reserved` ledger row and returns `{ ok, balance, reservationId }` discriminated on `ok`, still re-reading the real balance on the `-1` sentinel (F4 preserved). **Superseded on the generate path by `beginGeneration`** and retained only for the expand/contract window — removed with its RPC in Phase 8.
- `beginGeneration(admin, { userId, requestId, amount })` → `begin_generation()`; the idempotent debit (F22). `amount: null` probes without charging. Returns the discriminated `BeginGenerationResult` (`reserved` / `fresh` / `replay` / `inProgress` / `unavailable` / `insufficient`); `replay` carries the original summary, ids, cost, and balance. Admin client only — it debits an explicit user and reads back their summary.
- `refundReservation(admin, userId, reservationId)` → `refund_reservation()`; reverses a debit after failed work. Idempotent (only refunds a row still `reserved`), best-effort, and **never throws** — a transport-level rejection is caught too, so it can never mask the generation failure being returned. Returns `false` when the debit was not reversed, and logs a `CREDIT_LEAK` marker; the row stays `reserved` and is recoverable via `reconcile_reservation()`.
- There is deliberately **no** `settleReservation`: settling is now inside `persistSummaryAndSettle`'s transaction (F23).

#### 3. Function type update

**File**: `src/lib/services/summaries.ts`

**Intent**: Update the local `AppDatabase` Functions map to the new RPCs.

**Contract (superseded — what this phase shipped)**: Replace `spend_credit: { Args: Record<string, never>; Returns: number }` with `spend_credits: { Args: { amount?: number }; Returns: number }` and add `refund_credits: { Args: { target_user: string; amount: number }; Returns: undefined }`.

**Contract (current)**: the `Functions` map declares `reserve_credits`, `begin_generation`, `settle_reservation`, `refund_reservation`, and `persist_summary` — the table-returning ones typed as one-element arrays, which is how PostgREST delivers them. `spend_credits` / `refund_credits` remain only under a "legacy, kept for the expand/contract window" comment and are removed together with `reserve_credits` in Phase 8. `SummaryRow`/`SummaryInsert` also carry `reservation_id: string | null` (F16). `summaries.ts` additionally owns the persistence entry point `persistSummaryAndSettle` (F23) — see Phase 4.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase migration up`
- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- `spend_credits` debits the *caller's* row via `auth.uid()`, so a bare `select public.spend_credits(2)` in the SQL editor has no `auth.uid()` and won't debit the seeded user (F6). Verify under an authenticated context — either set the JWT claims in the SQL editor (`select set_config('request.jwt.claims', json_build_object('sub','<user-uuid>')::text, true); set local role authenticated; select public.spend_credits(2);`) or call the generate endpoint with an authenticated session. Under that context, a 2-credit spend lowers the balance by 2 and returns the new balance; a spend of amount > balance returns `-1` and does not change the balance.
- `spend_credits` is not executable by `anon` (least privilege holds).
- `refund_credits` is executable only by `service_role` — a call as `authenticated`/`anon` is denied (prevents self-crediting).

**Implementation Note**: After automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Cost policy

### Overview

Add the pure length→cost policy the endpoint will use to decide 1 vs 2 credits.

### Changes Required:

#### 1. Cost policy helper

**File**: `src/lib/services/summaries.ts`

**Intent**: Expose the long-transcript threshold, a **hard maximum** that actually bounds LLM cost/latency (F5), and a pure function mapping transcript length to credit cost, so the endpoint stays thin and the policy is one testable place.

**Contract**: `export const LONG_TRANSCRIPT_CHARS = 40000;` (the 1→2 credit boundary), `export const HARD_MAX_TRANSCRIPT_CHARS = 200000;` (the reject-above bound — well above the long threshold so only pathological transcripts hit it), and `export function summaryCost(transcriptLength: number): number` returning `2` when `transcriptLength > LONG_TRANSCRIPT_CHARS`, else `1`. `summaryCost` only prices; the hard cap is enforced by the endpoint before the LLM call (Phase 4).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

**Implementation Note**: After automated verification passes, proceed (no manual gate needed for this pure-logic phase).

---

## Phase 4: Endpoint — rename & harden

### Overview

Promote the probe to the production generation endpoint: rename the file, spend the computed cost, and add upstream-error handling (the F-02 follow-up). The long-video confirmation gate is added in Phase 5; here a long video simply proceeds at cost 2.

### Changes Required:

#### 1. Rename the route

**File**: `src/pages/api/summaries/probe.ts` → `src/pages/api/summaries/generate.ts`

**Intent**: `git mv` to the production path; no other route references it (curl-only spike).

**Contract**: New route `POST /api/summaries/generate`; `export const prerender = false;` retained.

#### 2. Variable cost + upstream-error handling

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Compute the cost from transcript length, then **debit before the paid LLM call** and **refund on any downstream failure** (F1). Wrap the external calls so Supadata/OpenRouter failures return a clean 502 instead of an unhandled 500, and wrap persistence so a post-debit failure refunds and returns a stable 500 (F7). Preserve only the up-front minimum-1 *read* gate ordering; the best-effort post-save spend is removed.

**Contract (superseded — the flow as originally planned)**: Phase 5 inserts the 409 confirmation between steps 3 and 4.
1. Up-front `getBalance` min-1 read gate before any paid call (`402` at 0).
2. `fetchTranscript` in try/catch → `502 { error }`; the unavailable branch stays `422`.
3. `const cost = summaryCost(transcript.content.length)`. **Hard-cap gate (F5)**: `413` above `HARD_MAX_TRANSCRIPT_CHARS`, before any 409, debit, or LLM call.
4. **Atomic debit**: `spendCredit(supabase, cost)`; insufficient sentinel → `402`.
5. In try/catch: `summarize` (→ `502`) then persist (→ stable `500`, F7); on any throw, `refundCredits(admin, userId, cost)` first.
6. `200 { summary, model, videoId, summaryId, creditsRemaining, cost, transcriptLength }`.

**Contract (current, after F4/F9/F10/F13/F17/F22/F23/F24)**: the endpoint is `POST /api/summaries/generate`, `prerender = false`, zod-validated (`url`, `character`, `allowLong`, optional `requestId: z.uuid()`). Preflight requires both provider keys **and** the admin client (`503` otherwise) — without the service-role key the refund path could not run at all, so a failure would silently leave the user charged. Then `401` unauthenticated, `400` on invalid input. The pipeline proper:

0. **Generation lease**: `acquireGenerationLease(admin, userId)` before any paid work; `null` → `429`. An RPC failure → `500`. Everything below runs inside a `try`/`finally` that releases the lease with its lease id on every exit path.
1. **Idempotency probe** (F22, only when `requestId` is present): `beginGeneration(admin, { userId, requestId, amount: null })`. `replay` → `200` with the original summary; `inProgress` → `429`; `unavailable` → `409` ("start a new generation"); anything else falls through. Runs **before** the paid fetch because the work cannot be priced until the transcript exists, so deferring to the debit would pay Supadata for a transcript it then discards. Fails **closed** (`500`) — proceeding on an unknown idempotency state is the double-charge this guard exists to prevent.
2. **Balance read gate**: `getBalance` → `402` at `null`/0; a throw → stable `500` with the generic (non-persistence) message (F14).
3. **Transcript acquisition** (F17): on `allowLong`, try `getTranscriptQuote` first — a hit skips both the rate limit and the paid fetch. On a miss, `recordTranscriptAttempt` (fails **closed** → `500`; capped → `429`), then `fetchTranscript` in try/catch → `502`; `!ok` → `422`; whitespace-only content → the same `422` (F13), before pricing or any debit.
4. `transcriptLength = content.length`; `cost = summaryCost(transcriptLength)`. **Hard-cap gate (F5)**: above `HARD_MAX_TRANSCRIPT_CHARS` → `413`, before any 409, debit, or LLM call. This is what bounds worst-case token cost/latency; `summaryCost` only prices.
5. **409 confirmation gate** (Phase 5): `cost > 1 && !allowLong` → `saveTranscriptQuote` then `409 { error, requiresConfirmation: true, cost, transcriptLength }` — no debit, no refund needed.
6. **Atomic idempotent debit**: `beginGeneration(admin, { userId, requestId, amount: cost })`. The same three repeat outcomes as step 1 are mapped identically (shared helper), `insufficient` → `402` (`"You need <cost> credits for this video; you have <balance>"`, actual balance per F4), `reserved` yields `{ reservationId, balance }`. A `fresh` outcome from a debiting call is a contract violation and throws. This debit — not a pre-read compare — is the authoritative, race-safe cost **and** identity gate; the step-1 probe is only an early exit on a possibly-stale read.
7. `summarize` (with its 300s deadline) — on failure: `refundReservation`, then `502`.
8. `persistSummaryAndSettle(admin, {...reservationId})` — one transaction writing video + linked summary and settling the reservation (F23). A throw → `refundReservation` then `500` with the retryable "saving your summary" message (F7). `ok: false` (the reservation was already resolved by a sweep) → fail closed with the same `500` and **no** refund, since the row is already resolved.
9. `discardTranscriptQuote` on the success path only, guarded on `allowLong` — the only path that can have written a quote (F24). Best-effort; never turns a delivered, charged summary into an error.
10. `200 { summary, model, videoId, summaryId, creditsRemaining, cost, transcriptLength }`. The replay `200` of step 1/6 omits `transcriptLength` — that is a property of the fetch, not of the saved summary, and the client only uses it on the confirmation path.

Log real errors server-side; never leak internals in the `error` field.

#### 3. Stale `probe` references

**Files**: `src/pages/api/account/delete.ts` (update comment), `src/lib/config-status.ts` (verify only)

**Intent**: Remove every lingering reference to the old `probe` path so the no-stale-refs gate can actually pass (F6). `account/delete.ts:46` has a comment (`matches src/pages/api/summaries/probe.ts`) that must be repointed to `generate.ts`. The config-status "Transcript / LLM" entry is unaffected.

**Contract**: Update the `account/delete.ts` comment to reference `generate.ts`; no functional change. A repo-wide search (see the PowerShell command in Success Criteria — `grep` is unavailable in this environment, F6) confirms `summaries/probe` has no remaining references.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- No stale references (PowerShell, F6): `Get-ChildItem -Recurse -File src | Select-String "summaries/probe"` returns nothing

#### Manual Verification:

- `curl.exe -X POST /api/summaries/generate` (authenticated) with a normal video returns 200, a Polish summary, `cost: 1`, and decrements the balance by 1; a new `summaries` row is written.
- A >40k-char video returns 200 with `cost: 2` and decrements by 2.
- A transcript longer than `HARD_MAX_TRANSCRIPT_CHARS` returns `413` before any debit or LLM call and spends nothing (F5).
- A video with no transcript returns 422 (before any debit); forcing an upstream error (e.g. a bad OpenRouter key) returns 502, not 500, and leaves the balance unchanged net (the cost is debited then refunded — confirm the balance is back to its pre-request value).

**Implementation Note**: After automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 5: Long-video confirmation gate

### Overview

Add the opt-in for the higher cost: an `allowLong` request flag plus a 409 "confirmation required" response when a long video hasn't been pre-authorized. Both the up-front toggle and the "Generate anyway" button (Phase 6) resolve to this one flag.

### Changes Required:

#### 1. `allowLong` flag + confirmation branch

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Accept `allowLong` in the request; when the transcript is long and `allowLong` is not set, return a distinct confirmation response *before* summarizing (no LLM call, no spend) so the client can ask the user to confirm the 2-credit cost.

**Contract**: `probeSchema` (now the generate schema) gains `allowLong: z.boolean().optional().default(false)`. The 409 is checked **after computing `cost` and before the atomic debit**, so a confirmation-required response never debits and never needs a refund: `if (cost > 1 && !allowLong)` → `409 { error, requiresConfirmation: true, cost, transcriptLength }`. When `allowLong` is true, a long video proceeds to the debit, where an insufficient balance still yields `402`. A short video ignores `allowLong` and always costs 1.

> **Amended 2026-07-23 (impl-review F17/F24).** The 409 now also **caches the transcript it already paid for** (`saveTranscriptQuote`, 10-min TTL) immediately before returning, and the `allowLong` retry reads that quote first — so the confirmation round-trip no longer pays Supadata twice and consumes no rate-limit token. The quote is discarded once the resulting summary commits. `allowLong` is therefore both the consent flag and the cache-read switch: it is the only path that can have written a quote, which is why the read and the discard are both guarded on it.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- A >40k-char video with no `allowLong` returns `409` with `requiresConfirmation: true` and `cost: 2`, and spends no credit.
- Resubmitting the same request with `allowLong: true` returns 200 and spends 2 credits.
- A user with 1 credit hitting a long video gets 409, then 402 on the `allowLong` retry (`need 2, have 1`).

**Implementation Note**: After automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 6: UI — dashboard generation form

### Overview

The user-facing surface: a React island on `/dashboard` that drives the endpoint, renders the summary inline, maps every failure to an English message, and handles the long-video confirmation.

### Changes Required:

#### 1. Generation form island

**File**: `src/components/summaries/GenerateSummaryForm.tsx`

**Intent**: A client island owning the full generate interaction — inputs, request, loading, result, errors, confirmation, and the live credit count. Styled to match the existing custom cosmic theme (reuse `Button` / the auth form field patterns).

**Contract**: Props `{ initialCredits: number | null }`. Local state: `url`, `character` (`"informational" | "educational"`, default informational), `allowLong` (default false), request status, `summary`/`cost`, error message, a `confirm` state (`{ cost, transcriptLength, url, character }` from a 409 — the URL/character are the exact inputs the quote was priced for, so "Generate anyway" replays them rather than the live form), and `credits` (seeded from `initialCredits`, updated to `creditsRemaining` on success). Client-side URL validation reuses `extractYoutubeId` (pure import) to enable/disable submit; submit is also disabled while loading or when `credits` is `0`. A `null` balance means the display read failed, **not** that the user is broke — generation stays enabled and the endpoint answers 402 if credits truly ran out (F5). POSTs `{ url, character, allowLong }` to `/api/summaries/generate`. Response handling:
- `200` → render summary, set `credits = creditsRemaining`, note credits spent. ~~(`whitespace-pre-wrap`)~~ **Amended (impl-review F2 / Phase 7)**: rendered with `react-markdown` through a themed `components` map, restricted to `SUMMARY_ALLOWED_ELEMENTS` (`p, ul, ol, li, strong, em, h2, h3, code`) with `unwrapDisallowed`, so untrusted LLM output cannot emit `img`/`a` and raw HTML stays escaped. **Amended (impl-review F18)**: a `response.ok` outcome is applied **before** the stale-sequence guard — a saved, charged summary is never discarded because the form was edited mid-flight — and `SuccessState` carries the submitted `url`, rendered on the result card so a result that no longer matches the live form is unambiguous.
- `409` → enter confirm state; show "This is a long video (~N chars). Generating costs {cost} credits." with a **"Generate anyway ({cost} credits)"** button that resubmits with `allowLong: true`; disable that button when `credits < cost` with a "not enough credits" note.
- `402` → credits message; `413` → "This video is too long to summarize." (F5); `422` → "No transcript is available for this video."; `502` → "The transcript or summarization service failed. Please try again."; `503` → "Summary generation isn't configured."; `500` → prefer the server-supplied `error` so a pre-save infrastructure failure (lock/balance/reserve) keeps its own message; fall back to a generic "Something went wrong. Please try again." only for a non-JSON framework 500 — a persistence failure supplies the retryable "saving your summary" message from the server (F7, F14); `400`/`401` → validation / "Your session expired — sign in again."
Inputs are preserved across errors for retry.

> **Amended 2026-07-23 (impl-review F11/F20/F22/F26).** The island gained four things the original contract does not describe:
> - **Stale-response discard (F11)**: a monotonic `requestSeq` ref, bumped on every submit *and* on every quote-relevant input change. Advisory outcomes (409/402/errors) whose seq is stale are dropped, so a late 409 for video A can never install a quote for video B. Successful (paid) responses are exempt — see the F18 amendment above.
> - **Idempotency key (F22)**: a `pendingRequest` ref holding `{ key, url, character }`. Each submit sends `requestId` — reusing the held key only when `url`+`character` match, otherwise minting a fresh `crypto.randomUUID()`. The key is retained across a **network error only** (the sole ambiguous outcome, where the request may have been delivered and its reply lost) and cleared on *any* HTTP response, so the next submit is a genuinely new operation.
> - **Inline URL validation (F20)**: a non-empty unparseable URL shows "Enter a valid YouTube video URL." on the field rather than only silently disabling submit; an empty field stays clean, matching the auth forms.
> - **`429` mapping**: the endpoint returns 429 for three distinct causes — generation-lease contention, a repeat request whose original attempt is still running (F22), and the transcript-attempt rate cap (F17) — each with its own server message. `messageForStatus` currently ignores `serverError` for 429 and always renders the lock-contention wording; see impl-review F26.

#### 2. Character selector + toggle controls

**File**: `src/components/summaries/GenerateSummaryForm.tsx` (same island; sub-components optional)

**Intent**: A two-option character selector (radiogroup semantics, segmented-button look) and an "allow long videos (may cost 2 credits)" checkbox.

**Contract**: Accessible fieldset/radio for character; a labeled checkbox bound to `allowLong`. No new shadcn primitives required; match existing Tailwind form styling.

#### 3. Mount on the dashboard

**File**: `src/pages/dashboard.astro`

**Intent**: Replace the static credit card with the island so the credit count lives in one place and updates after generation; keep the server-side `getBalance` read as the initial value.

**Contract**: Import and render `<GenerateSummaryForm client:load initialCredits={credits} />` where the static credit card was. The existing `getBalance` computation and its error handling stay; the island owns display + live updates.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- Signed in on `/dashboard`: pasting a valid URL + character + submit shows a loading state, then the Polish summary inline; the credit count drops by 1.
- Pasting an invalid URL disables/blocks submit with a clear message.
- A long video shows the confirmation prompt; "Generate anyway (2 credits)" completes and the count drops by 2.
- With 0 credits, generation is blocked with a message; an unavailable-transcript video shows its message and spends nothing.
- Verified on latest Chrome and Firefox (NFR).

**Implementation Note**: After automated verification passes, pause for manual confirmation — this is the end-to-end acceptance of S-01.

---

## Phase 7: Prompt engineering

### Overview

Rewrite the two system prompts to produce the PRD's two distinct output shapes with format and length guidance — the single biggest lever on the 75% "good-enough" success criterion. Prompts are authored in **English** with an explicit instruction to **answer in Polish**. This phase intentionally comes last so prompt iteration and manual quality judgment happen against the completed endpoint and dashboard flow.

### Changes Required:

#### 1. Character-tailored prompts

**File**: `src/lib/services/llm.ts`

**Intent**: Replace the one-line prompts with fuller prompts that (a) instruct the model to always respond in Polish, (b) define the output shape per character per the PRD, and (c) give length/format guidance serving both jobs a summary does — the watch/skip decision and the substitute-for-watching read.

**Contract**: `SYSTEM_PROMPTS` keeps its `Record<ChannelCharacter, string>` type. Each prompt, in English, must specify: always respond in Polish; the video's transcript is the input; produce a summary that both supports a watch/skip decision **and** stands in for the video when the user skips it.
- **informational** → an exhaustive, scannable bulleted list of the key facts / data / conclusions from the video.
- **educational** → an overview of the topics and skills the viewer would learn, in a clear didactic structure.

Each prompt is **layered** so one output serves both jobs: one or two framing sentences up front (the watch/skip verdict), then complete coverage of the content (the substitute read). Length **follows the video's actual content** — no fixed ceiling; important points must not be dropped to stay short, and padding is equally disallowed. `summarize()`'s signature and return shape are unchanged.

> **Amended 2026-07-20 (impl-review F1).** This contract originally required "a length ceiling appropriate to a skim (e.g. a bounded number of bullets / short sections)." The Phase 7 manual quality pass found the ceiling cut material the reader needed, and the prompts shipped content-driven instead (`af3bea3`). The impl-review flagged the mismatch; the decision was to keep the implemented behavior and correct this contract, because a summary's second job — replacing the video rather than triaging it — is incompatible with a fixed cap. The PRD's Success Criteria and FR-005 output description were updated to name both jobs. **Unbounded output length is an accepted, unmeasured cost vector**: cost is priced off transcript length (input) only, so a fact-dense video yields a long, more expensive completion at the same credit price. Revisit if per-summary cost drifts.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- Using the completed dashboard flow (or an authenticated `curl.exe` call), an informational video returns a Polish bulleted key-facts list and an educational video returns a Polish learning-overview. Output language is Polish despite English prompts.

**Implementation Note**: After automated verification passes, pause for the final manual prompt-quality pass. Spot-check both characters and iterate on the prompts before closing S-01.

---

## Phase 8: Contract migration — drop the six superseded RPCs

### Overview

The expand/contract close-out. Four generations of credit RPC and two generations of generation-lock RPC now coexist, each left in place for the same deploy-window reason, and this phase drops all of them in one migration:

| Function | Added | Superseded by | Why it is still there |
| --- | --- | --- | --- |
| `spend_credit()` | `20260712175240` | `spend_credits(amount)` | Phase 2 expand-only |
| `spend_credits(integer)` | `20260719120000` | `reserve_credits(amount)` | F1 ledger expand-only |
| `refund_credits(uuid, integer)` | `20260719120000` | `refund_reservation(uuid, uuid)` | F1 ledger expand-only |
| `reserve_credits(integer)` | `20260720160000` | `begin_generation(uuid, uuid, integer)` | F22 idempotency expand-only |
| `acquire_generation_lock(uuid, integer)` | `20260720133000` | `acquire_generation_lease(uuid, integer)` | F2 lease expand-only |
| `release_generation_lock(uuid)` | `20260720133000` | `release_generation_lease(uuid, uuid)` | F2 lease expand-only |

> **Amended 2026-07-23 (impl-review F22/F25).** `reserve_credits(integer)` joined the list: `begin_generation()` superseded it on the generate path, leaving it with no caller. Unlike the other five it is still *referenced* in code — `reserveCredits` in `credits.ts` and its entry in `AppDatabase["public"]["Functions"]` — so this phase must delete that dead wrapper along with the RPC, or the drop leaves an exported function that calls a non-existent RPC. `settle_reservation()` is **not** dropped: F23 removed its wrapper from `credits.ts`, but the RPC is deliberately retained as an operator-side recovery tool alongside `reconcile_reservation()`.

They are dropped **together** because they share one precondition (the phases 1–7 Worker is live), so splitting them across migrations would buy nothing and leave dead SECURITY DEFINER functions in the schema for longer.

**Why this is not cosmetic.** Each is `SECURITY DEFINER`, running as `postgres`. `spend_credit`/`spend_credits` are granted to `authenticated`; `refund_credits` raises balances on an explicit `target_user`. `20260714140000` makes exactly this argument: an unused definer function is latent blast radius waiting for someone to extend it. `refund_credits` is the sharpest case — it credits an arbitrary user by amount, with no reservation to check against, so it is precisely the primitive the F1 ledger exists to remove. `release_generation_lock` is the same class of hazard for the lock: it releases by `user_id` alone, which is exactly the ownerless release the F2 lease replaced.

**Deploy-ordering gate (do this phase LAST, after deploy).** This migration must run **only after the phases 1–7 Worker is live on cloud** — i.e. the deployed Worker calls `reserve_credits`/`settle_reservation`/`refund_reservation` and `acquire_generation_lease`/`release_generation_lease`, and none of the five legacy functions. Running the drop while an older Worker still serves traffic reopens exactly the deploy window §Migration Notes avoids: DB-first would break it mid-generation, and for `refund_credits` that break is **silent** — `refundCredits` logged and swallowed failures, so an in-flight failed generation would leave the user charged with no error surfaced. A dropped `release_generation_lock` is likewise silent (release is best-effort), leaving the user locked out for one stale window.

### Changes Required:

#### 1. New contract migration

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_drop_legacy_rpcs.sql`

**Intent**: Remove all six superseded RPCs. `drop function if exists` keeps the migration idempotent and safe to re-run.

**Contract**:

```sql
-- Contract half of the expand/contract chains opened in S-01 (Phase 8).
-- Safe only after the phases 1-7 Worker is live on cloud (see plan §Migration Notes).
--
-- spend_credit -> spend_credits (20260719120000) -> reserve_credits (20260720160000)
--                                                -> begin_generation (20260723130000)
-- refund_credits (20260719120000)                 -> refund_reservation (20260720160000)
-- acquire/release_generation_lock (20260720133000) -> ..._generation_lease (20260720170000)
--
-- All six are SECURITY DEFINER and unreferenced by the shipped Worker; refund_credits in
-- particular credits an arbitrary user by amount with no reservation to validate against, and
-- release_generation_lock releases by user_id alone — the ownerless release F2 replaced.
-- settle_reservation() is intentionally NOT dropped: it has no wrapper since F23 but is kept
-- as an operator recovery tool, alongside reconcile_reservation().
drop function if exists public.spend_credit();
drop function if exists public.spend_credits(integer);
drop function if exists public.refund_credits(uuid, integer);
drop function if exists public.reserve_credits(integer);
drop function if exists public.acquire_generation_lock(uuid, integer);
drop function if exists public.release_generation_lock(uuid);
```

#### 2. Remove the dead `reserveCredits` wrapper

**Files**: `src/lib/services/credits.ts`, `src/lib/services/summaries.ts`

**Intent**: `reserve_credits` is the one drop that still has code pointing at it. Deleting the RPC without the wrapper would leave an exported function calling something that no longer exists.

**Contract**: Delete `reserveCredits` and the `ReserveResult` type from `credits.ts` (and `INSUFFICIENT_SENTINEL` if it becomes unused), and remove the `reserve_credits`, `spend_credits`, and `refund_credits` entries from `AppDatabase["public"]["Functions"]` in `summaries.ts`. No behavior change — `generate.ts` has called `beginGeneration` since F22. The other five drops need no code change: those switches already happened in Phase 2 (`spend_credits`), the F1 fix (`reserve_credits`), and the F2 fix (`acquire_generation_lease`).

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase migration up`
- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- No stale references (PowerShell): `Get-ChildItem -Recurse -File src supabase/migrations | Select-String "spend_credit\b|spend_credits|refund_credits|reserve_credits|generation_lock\("` returns nothing outside the drop migration itself and the historical migrations that define them (`20260712175240`, `20260719120000`, `20260720133000`, `20260720160000`).
- `AppDatabase["public"]["Functions"]` in `src/lib/services/summaries.ts` no longer declares `spend_credits` / `refund_credits` / `reserve_credits` (their "legacy, kept for the expand/contract window" entries are removed with the drop), and `reserveCredits` is gone from `credits.ts`.

#### Manual Verification:

- **Precondition**: confirm the cloud Worker in production is the build calling `begin_generation` + `persist_summary` and `acquire_generation_lease` (not `spend_credit`/`spend_credits`/`reserve_credits`/`acquire_generation_lock`) before applying to cloud.
- After the migration, each of `select public.spend_credit();`, `select public.spend_credits(1);`, `select public.refund_credits('<uuid>', 1);`, `select public.reserve_credits(1);`, `select public.acquire_generation_lock('<uuid>');`, and `select public.release_generation_lock('<uuid>');` errors with `function ... does not exist`.
- `select public.settle_reservation('<uuid>','<uuid>');` and `select public.reconcile_reservation(...)` still exist — they are the retained operator recovery tools, not part of the drop.
- A normal and a long generation still succeed end-to-end (they use `begin_generation` + `persist_summary`), and a forced failure still refunds (via `refund_reservation`), confirming nothing regressed.

**Implementation Note**: This is the roadmap's former `S-01-fu` (`drop-spend-credit-contract`), folded in as the closing phase and widened to cover the F1 ledger's two additional legacy functions. It is gated on deployment, so it lands in a separate commit/PR after phases 1–7 ship — sequence it after the Worker is live rather than bundling the drops into the pre-deploy work.

---

## Testing Strategy

Per the roadmap's Module-3 deferral, S-01 uses **manual verification only** (no test tooling). The backend phases are curl-verifiable before any UI exists.

### Manual Testing Steps:

1. **Normal generation**: sign in, paste a standard YouTube URL, pick informational, submit → Polish key-facts list appears; balance −1; row in `summaries`.
2. **Educational shape**: same with educational → Polish learning-overview (distinct shape).
3. **Long video**: paste a long-form video (>40k-char transcript) without the toggle → confirmation prompt → "Generate anyway" → balance −2.
4. **Toggle path**: enable "allow long videos", submit a long video → proceeds directly, balance −2; a short video with the toggle on still costs 1.
5. **No credits**: exhaust the balance → generation blocked at 0 (402 message).
6. **No transcript**: paste a video with no transcript → 422 message, no spend.
7. **Upstream error**: temporarily break a key → 502 message, no spend, no crash.
8. **Invalid URL**: paste a non-YouTube URL → blocked with a message.
9. **Copy**: unset a key → English notice banner.

#### Post-review scenarios (added after the impl-review re-review fixes F9–F24)

These exercise behavior that changed after the phases landed and are **not yet recorded** in the Progress section — run them against the amended build before release acceptance:

10. **Markdown allow-list** (Phase 6): a summary containing an image/link/raw HTML renders with those elements stripped/unwrapped (text still shows), no network fetch to an untrusted URL.
11. **Unknown balance** (F5 accepted): with the display balance read failing/unavailable (`null`), submission stays **enabled**; a truly-broke user is still stopped by the 402.
12. **Lock contention 429** (F10): two concurrent generations for the same user → the second returns 429 ("already being generated").
13. **Stale-lock takeover + ownership** (F10 lease): after a stale takeover, the displaced request's release is a no-op (`false`, logged) and the successor's lock survives; a third request stays blocked until the successor releases.
14. **In-flight confirmation race** (F11): submit video A, edit inputs to B while A is loading; A's late 409 does **not** install a quote for B, and "Generate anyway" (if shown) generates only the quoted request — never B without its own confirmation.
15. **Empty transcript** (F13): a video whose transcript is whitespace/empty → 422 "unavailable", **no** credit reserved, no LLM call.
16. **Refund-failure handling** (F9 ledger): force a post-debit failure (break the LLM/persist path) → the reservation is refunded; if the refund itself fails, the row stays `reserved` (recoverable via the reconciliation query), never a silent charge.
17. **Error-message accuracy** (F14): a pre-save infrastructure 500 (e.g. lock/balance/reserve failure) shows the generic "Something went wrong" message, distinct from the persistence "saving your summary" 500.
18. **Reconciliation classification** (F16): a `reserved` row *with* a linked summary is settled by `reconcile_reservation()`, one *without* is refunded — and a delivered summary can no longer be misclassified, since F23 settles it inside the writing transaction.
19. **Transcript rate cap** (F17): more than 10 paid transcript fetches inside 10 minutes for one user → `429` with the cooldown message, before any Supadata call; a `record_transcript_attempt` DB failure fails **closed** (500), never open.
20. **Quote reuse on confirm** (F17): a long video's 409 followed by "Generate anyway" performs **one** Supadata fetch total and consumes one rate-limit token, not two.
21. **Atomic persist + settle** (F23): force a persist failure after a successful `summarize` → no summary row, reservation refunded, `500` with the "saving your summary" message; on success the reservation is `settled` in the same transaction that wrote the summary, and deleting that summary afterwards does **not** change the billing outcome.
22. **Idempotent retry** (F22): repeat a POST with the same `requestId` after a delivered generation → `200` replaying the original summary with **no** second charge and **no** second `summaries` row; repeat while the first is still running → `429`; omit `requestId` entirely (pre-F22 client) → normal, undeduplicated behavior.
23. **Quote lifecycle** (F24): a quote is gone after the generation that used it commits; an abandoned, never-revisited expired quote is drained by a later unrelated `save_transcript_quote`; a live (unexpired) quote is never pruned.
24. **LLM deadline** (F23): a `summarize` call exceeding 300s aborts → refund + `502`, well before the generation lease's stale window and the one-hour reconciliation sweep.

## Performance Considerations

The transcript fetch (possibly a polled Whisper job) dominates latency; the UI must show a loading state and tolerate multi-second waits. The 40k-char threshold only sets the 1→2 credit *price*; worst-case LLM token cost/latency is bounded by the `HARD_MAX_TRANSCRIPT_CHARS` reject gate (F5), which returns 413 before the LLM call for pathologically long transcripts, and by `summarize()`'s 300s abort deadline (F23). ~~The confirm path re-fetches the transcript (accepted tradeoff).~~ **Amended (F17)**: the confirm path reuses the cached quote, so it re-fetches only on a quote miss/expiry; paid fetches are additionally capped per user (10 / 10 min). Worst-case request latency is bounded by the 300s LLM deadline on top of the transcript poll's ~240s, both under the 600s generation-lease stale window. No new N+1 or hot-path concerns; volumes are MVP-small.

## Migration Notes

**Expand/contract** (F3). Existing live migrations are untouched.

1. **Expand (this slice)**: one forward migration adds `spend_credits` + `refund_credits` and **leaves `spend_credit()` in place**. `credits.ts` is switched to `spend_credits` in the same phase. Deploy order is now safe in both directions: the DB has both functions, so the old Worker (still calling `spend_credit`) and the new Worker (calling `spend_credits`) each work. Apply locally with `npx supabase migration up`; push to cloud before/with the Worker deploy.
2. **Expand (F1 ledger, `20260720160000_credit_reservations.sql`)**: adds the `credit_reservations` table plus `reserve_credits` / `settle_reservation` / `refund_reservation`, and **leaves `spend_credits` and `refund_credits` in place** for the same reason step 1 left `spend_credit()`. Both orders stay safe: the DB carries old and new functions, so the previous Worker and the reservation-aware Worker each work throughout rollout.
3. **Expand (F2 lease, `20260720170000_generation_lock_lease.sql`)**: adds `generation_locks.lock_id` plus `acquire_generation_lease` / `release_generation_lease`, and **leaves `acquire_generation_lock` / `release_generation_lock` in place** for the same reason. The new column is defaulted, so the legacy acquire keeps writing valid rows during the overlap window.
4. **Expand (F16 link, `20260722120000_link_summary_to_reservation.sql`)**: adds the nullable `summaries.reservation_id` (unique, composite FK to `credit_reservations (id, user_id)`) and `reconcile_reservation()`, which settles linked reservations and refunds only unlinked ones. Nullable, so rows written by the previous Worker stay valid; the old migration's refund-everything runbook is redirected to `reconcile_reservation`.
5. **Expand (F17 guards, `20260722130000_transcript_spend_guards.sql`)**: adds `transcript_attempts` / `transcript_quotes` with `record_transcript_attempt`, `get_transcript_quote`, `save_transcript_quote` — all new, definer-only, service-role-granted tables and functions, so nothing existing changes shape.
6. **Expand (F23 atomic persist, `20260723120000_atomic_persist_summary.sql`)**: adds `persist_summary()` (lock reservation → upsert video → insert linked summary → settle, in one transaction). `settle_reservation()` and `reconcile_reservation()` are deliberately left **unchanged** so they still classify rows written by the pre-F23 Worker during rollout — which is why no one-time classification pass is needed.
7. **Expand (F22 idempotency, `20260723130000_idempotent_generation.sql`)**: adds the nullable `credit_reservations.request_id`, a **partial** unique index (`request_id is not null and status <> 'refunded'`), and `begin_generation()`. Partial in both directions on purpose: keyless/pre-F22 rows are outside the constraint (so this is safe to apply ahead of the Worker that writes keys), and a refund releases the key (so a retry after genuinely failed work can actually re-run). `reserve_credits()` is untouched; `begin_generation` with a null `request` behaves exactly like it.
8. **Expand (F24 lifecycle, `20260723140000_transcript_quote_lifecycle.sql`)**: adds `discard_transcript_quote()` and the bounded `prune_transcript_quotes(max_rows default 100)`, and replaces `save_transcript_quote` / `get_transcript_quote` **without changing their signatures, return types, or result semantics** — so the deployed pre-F24 Worker keeps working. Because rows are created only by `save_transcript_quote` and every such call drains up to `max_rows` expired rows, the table is self-limiting with no scheduled job required (the function is granted to `service_role` so pg_cron *may* call it; nothing depends on that).
9. **Contract (Phase 8, after the new Worker is live)**: one later migration drops **all six** superseded functions together — `spend_credit()`, `spend_credits(integer)`, `refund_credits(uuid, integer)`, `reserve_credits(integer)`, `acquire_generation_lock(uuid, integer)`, `release_generation_lock(uuid)` — since they share the single precondition "the phases 1–7 Worker is live". Gated on deployment because dropping any of them alongside its expand migration would open a deploy window: DB-first breaks the still-running Worker, Worker-first calls an RPC not yet created. For `refund_credits` that breakage is silent (failures were logged and swallowed), which is why it waits for the gate rather than going early. Folded in from the former roadmap `S-01-fu` (`drop-spend-credit-contract`) and widened to the full set; see Phase 8.

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-01)
- Proven pipeline: `src/pages/api/summaries/probe.ts` (to become `generate.ts`)
- Credit RPC pattern: `supabase/migrations/20260712175240_user_credits.sql:48-71`, `20260714140000_assert_least_privilege_functions.sql`
- F-02 follow-ups carried here: `context/changes/transcript-llm-probe/plan-brief.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

> **Deployment (2026-07-24):** Phases 1–7 are live in production. `generate-and-save-summary`
> fast-forwarded into `master` (`99adfea..f415f12`); CI + deploy both green (Worker deployed via
> `wrangler deploy`). The 9 expand migrations (`20260719120000` … `20260723140000`) were applied to
> prod Supabase (`ukbptccdffiigkdekzcn`) with `supabase db push` **before** the Worker deploy; prod
> reports fully in sync. This satisfies Phase 8's precondition (phases 1–7 Worker live) — Phase 8 is
> now **unblocked but not yet started** (migration file not created; steps 8.1–8.7 pending).

### Phase 1: Existing UI copy → English

#### Automated

- [x] 1.1 Linting passes: `npm run lint` — 4f48536
- [x] 1.2 Build passes: `npm run build` — 4f48536

#### Manual

- [x] 1.3 Notice banner renders entirely in English with a key unset — manual e2e 2026-07-24

### Phase 2: DB — variable-cost credit spend

#### Automated

- [x] 2.1 Migration applies cleanly: `npx supabase migration up` — 23d59cc
- [x] 2.2 Type checking passes: `npm run build` — 23d59cc
- [x] 2.3 Linting passes: `npm run lint` — 23d59cc

#### Manual

- [x] 2.4 `spend_credits(2)` lowers balance by 2 / returns new balance; over-spend returns -1 and no change — manual e2e 2026-07-23
- [x] 2.5 `spend_credits` not executable by `anon` (least privilege holds) — manual e2e 2026-07-23
- [x] 2.6 `refund_credits` executable only by `service_role` (denied for `authenticated`/`anon`) — manual e2e 2026-07-23

### Phase 3: Cost policy

#### Automated

- [x] 3.1 Type checking passes: `npm run build` — b22d6f1
- [x] 3.2 Linting passes: `npm run lint` — b22d6f1

### Phase 4: Endpoint — rename & harden

#### Automated

- [x] 4.1 Type checking passes: `npm run build` — 9072baa
- [x] 4.2 Linting passes: `npm run lint` — 9072baa
- [x] 4.3 No stale references (PowerShell): `Get-ChildItem -Recurse -File src | Select-String "summaries/probe"` returns nothing — 9072baa

#### Manual

- [x] 4.4 Normal video → 200, Polish summary, `cost: 1`, balance −1, row written — manual e2e 2026-07-23
- [x] 4.5 Long video → 200, `cost: 2`, balance −2 — manual e2e 2026-07-23
- [x] 4.6 Transcript over `HARD_MAX_TRANSCRIPT_CHARS` → 413 before any debit/LLM call, spends nothing — manual e2e 2026-07-24 (forced via a 200,001-char injected `transcript_quotes` row reused on `allowLong:true`; 413, balance/reservations/summaries all unchanged)
- [x] 4.7 No-transcript → 422; forced upstream error → 502 (not 500), balance net-unchanged (debit then refund) — manual e2e 2026-07-24 (502-half: debit reserved then `refunded`, balance net-unchanged; no-transcript 422 half: forced via a temporary, reverted fixture-scoped `fetchTranscript` mock — `ok:false` sentinel → 422 before any debit)

### Phase 5: Long-video confirmation gate

#### Automated

- [x] 5.1 Type checking passes: `npm run build` — 17817f2
- [x] 5.2 Linting passes: `npm run lint` — 17817f2

#### Manual

- [x] 5.3 Long video without `allowLong` → 409 `requiresConfirmation`, `cost: 2`, no spend — manual e2e 2026-07-23
- [x] 5.4 Retry with `allowLong: true` → 200, balance −2 — manual e2e 2026-07-23
- [x] 5.5 1-credit user → 409 then 402 (`need 2, have 1`) on the `allowLong` retry — manual e2e 2026-07-23

### Phase 6: UI — dashboard generation form

#### Automated

- [x] 6.1 Type checking passes: `npm run build` — 10b3ffa
- [x] 6.2 Linting passes: `npm run lint` — 10b3ffa

#### Manual

- [x] 6.3 Valid URL + character + submit → loading → Polish summary inline; credit count −1 — manual e2e 2026-07-23
- [x] 6.4 Invalid URL blocked with a message — manual e2e 2026-07-23
- [x] 6.5 Long video → confirmation → "Generate anyway (2 credits)" → count −2 — manual e2e 2026-07-23
- [x] 6.6 0 credits blocked; no-transcript shows message and spends nothing — manual e2e 2026-07-24 (0-credits: 2026-07-23; no-transcript half: form submit of a sentinel `ok:false` id → red "No transcript is available for this video." banner, badge unchanged, DB net-unchanged, via the reverted fixture-scoped mock)
- [x] 6.7 Verified on latest Chrome and Firefox — Chrome: manual e2e 2026-07-23; Firefox: manual pass by user 2026-07-24 (passed)

### Phase 7: Prompt engineering

#### Automated

- [x] 7.1 Type checking passes: `npm run build` — af3bea3
- [x] 7.2 Linting passes: `npm run lint` — af3bea3

#### Manual

- [x] 7.3 Informational → Polish key-facts list; educational → Polish learning-overview (Polish output from English prompts) — af3bea3

### Phase 8: Contract migration — drop the six superseded RPCs

> Gated: apply to cloud only after the phases 1–7 Worker is live (calls `begin_generation` + `persist_summary` + `acquire_generation_lease`).
> **Gate satisfied 2026-07-24** — phases 1–7 Worker is live in production. This phase is now actionable; migration not yet created.

#### Automated

- [ ] 8.1 Migration applies cleanly: `npx supabase migration up`
- [ ] 8.2 Type checking passes: `npm run build`
- [ ] 8.3 Linting passes: `npm run lint`
- [ ] 8.4 No stale `spend_credit(` / `reserve_credits` / `generation_lock(` references outside the drop migration and the migrations that define them; `reserveCredits` removed from `credits.ts`

#### Manual

- [ ] 8.5 Cloud Worker confirmed on the phases 1–7 build before applying to cloud
- [ ] 8.6 `select public.spend_credit();` errors (function no longer exists); normal + long generation still succeed
- [ ] 8.7 `settle_reservation` / `reconcile_reservation` still exist (retained operator recovery tools)
