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
- **No schema change to `summaries`** — we do not store per-summary credit cost, and `videos.title`/`thumbnail_url` stay null (no metadata fetch).
- **Token-accurate** cost measurement — character count is the proxy (see Cost policy).
- **Markdown rendering** of summaries — plain text with preserved line breaks.
- **Streaming** responses or structured LLM output.
- **Tests / test tooling** — manual verification only (roadmap defers testing to Module 3).
- Any change to **F-01's** existing columns or RLS.

## Implementation Approach

Build backend-first in curl-verifiable increments, then the UI. Isolate the cross-cutting English-copy cleanup first (smallest, independent). Then: the DB primitive (variable spend), the pure cost policy, the endpoint productionization, the confirmation gate, and the dashboard island. Prompt engineering comes last because judging and iterating on output quality is manual work and is most useful after the complete generation flow exists. Each phase is independently verifiable; the UI and final prompt-quality phases require manual browser/API checks.

## Critical Implementation Details

- **Migration immutability + expand/contract** (F3): the credit migrations are live on cloud and must not be edited. This slice's migration is **expand-only** — it *adds* `spend_credits`/`refund_credits` and leaves the old `spend_credit()` in place. Dropping `spend_credit()` in the same migration would open a deploy window (DB-first breaks the old Worker; Worker-first calls a not-yet-created RPC), so the drop is deferred to a **follow-up contract migration** made after the new Worker is live.
- **Up-front gate ordering**: the minimum-1-credit balance *read* gate stays **before** `fetchTranscript` so a zero-balance user never triggers a paid Supadata/OpenRouter call.
- **Debit before paid LLM work; refund on failure** (this replaces the probe's persist-then-best-effort-spend contract — see F1): after the transcript length is known and any 409 confirmation is resolved, `spend_credits(cost)` runs as an **atomic reservation** — its row-level `UPDATE … WHERE balance >= cost` is the concurrency serialization point, so parallel requests sharing one stale balance read cannot all overspend (the losers get the `-1` sentinel → 402). Only after a successful debit does the paid `summarize` call run. If `summarize` **or** the persist step fails, `refund_credits(cost)` releases the debit and the request returns 502/500 — the user is never charged for failed work. There is no persist-then-best-effort-spend and no "return 200 despite a failed spend." A race-losing request may still have paid the cheaper transcript fetch — the same accepted tradeoff as the confirm-path double fetch.
- **Double transcript fetch on confirm**: when a long video hits the 409 gate, the transcript was already fetched; the "Generate anyway" resubmit fetches it again. Accepted MVP tradeoff (usually a fast inline fetch; a rare Whisper re-trigger is the edge). The up-front toggle avoids it entirely for users who know a video is long.

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

**Contract**: `spendCredit(supabase, amount = 1)` calls `.rpc("spend_credits", { amount })`. Same `{ ok, balance }` return shape, but on the `-1` insufficient sentinel it **re-reads the caller's actual balance via `getBalance`** for `{ ok: false, balance }` instead of hard-coding `0` (F4) — otherwise a 2-credit spend at balance 1 would report 0 and the 402 "you have &lt;balance&gt;" message would be wrong. New `refundCredits(admin, userId, amount)` (admin = `createAdminClient()` result) calls `.rpc("refund_credits", { target_user: userId, amount })`; it is a best-effort compensating action — on error (including a null admin client when the service-role key is unset) it logs and resolves without throwing, so it never masks the original generation failure being returned to the user.

#### 3. Function type update

**File**: `src/lib/services/summaries.ts`

**Intent**: Update the local `AppDatabase` Functions map to the new RPCs.

**Contract**: Replace `spend_credit: { Args: Record<string, never>; Returns: number }` with `spend_credits: { Args: { amount?: number }; Returns: number }` and add `refund_credits: { Args: { target_user: string; amount: number }; Returns: undefined }`.

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

**Contract**: Flow (Phase 5 inserts the 409 confirmation between steps 3 and 4):
1. Up-front `getBalance` min-1 read gate before any paid call (`402` at 0) — unchanged.
2. `fetchTranscript` in try/catch → `502 { error }`; the unavailable branch stays `422`.
3. `const cost = summaryCost(transcript.content.length)`. **Hard-cap gate (F5)**: if `transcript.content.length > HARD_MAX_TRANSCRIPT_CHARS` → `413 { error }` ("This video's transcript is too long to summarize.") — before any 409, debit, or LLM call. This is what actually bounds worst-case token cost/latency; `summaryCost` only prices.
4. **Atomic debit**: `spendCredit(supabase, cost)`. On the insufficient sentinel → `402` (`"You need <cost> credits for this video; you have <balance>"`, balance re-read per F4). This debit — not a pre-read `balance < cost` compare — is the authoritative, race-safe cost gate.
5. In try/catch: `summarize` (failure → `502`) then persist the video+summary (failure → stable `500 { error }`, F7). **On any throw in this block, call `refundCredits(admin, userId, cost)` before returning** so the user isn't charged for failed work.
6. `200` — success response gains `cost` and `transcriptLength`: `{ summary, model, videoId, summaryId, creditsRemaining, cost, transcriptLength }`, where `creditsRemaining` is the balance returned by the successful debit.

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

**Contract**: `probeSchema` (now the generate schema) gains `allowLong: z.boolean().optional().default(false)`. The 409 is checked **after computing `cost` (step 3) and before the atomic debit (step 4)**, so a confirmation-required response never debits and never needs a refund: `if (cost > 1 && !allowLong)` → `409 { error, requiresConfirmation: true, cost, transcriptLength }`. When `allowLong` is true, a long video proceeds to the debit, where the insufficient sentinel still yields `402`. A short video ignores `allowLong` and always costs 1.

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

**Contract**: Props `{ initialCredits: number | null }`. Local state: `url`, `character` (`"informational" | "educational"`, default informational), `allowLong` (default false), request status, `summary`/`cost`, error message, a `confirm` state (`{ cost, transcriptLength }` from a 409), and `credits` (seeded from `initialCredits`, updated to `creditsRemaining` on success). Client-side URL validation reuses `extractYoutubeId` (pure import) to enable/disable submit; submit is also disabled while loading or when `credits` is 0/null. POSTs `{ url, character, allowLong }` to `/api/summaries/generate`. Response handling:
- `200` → render summary (`whitespace-pre-wrap`), set `credits = creditsRemaining`, note credits spent.
- `409` → enter confirm state; show "This is a long video (~N chars). Generating costs {cost} credits." with a **"Generate anyway ({cost} credits)"** button that resubmits with `allowLong: true`; disable that button when `credits < cost` with a "not enough credits" note.
- `402` → credits message; `413` → "This video is too long to summarize." (F5); `422` → "No transcript is available for this video."; `502` → "The transcript or summarization service failed. Please try again."; `503` → "Summary generation isn't configured."; `500` → "Something went wrong saving your summary. Please try again." (retryable — persistence failure, F7); `400`/`401` → validation / "Your session expired — sign in again."
Inputs are preserved across errors for retry.

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

**Intent**: Replace the one-line prompts with fuller prompts that (a) instruct the model to always respond in Polish, (b) define the output shape per character per the PRD, and (c) give length/format guidance so summaries are skimmable and support a watch/skip decision.

**Contract**: `SYSTEM_PROMPTS` keeps its `Record<ChannelCharacter, string>` type. Each prompt, in English, must specify: always respond in Polish; the video's transcript is the input; produce a summary whose purpose is to decide whether to watch the full video.
- **informational** → an exhaustive, scannable bulleted list of the key facts / data / conclusions from the video.
- **educational** → an overview of the topics and skills the viewer would learn, in a clear didactic structure.
Include a length ceiling appropriate to a skim (e.g. a bounded number of bullets / short sections). `summarize()`'s signature and return shape are unchanged.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- Using the completed dashboard flow (or an authenticated `curl.exe` call), an informational video returns a Polish bulleted key-facts list and an educational video returns a Polish learning-overview. Output language is Polish despite English prompts.

**Implementation Note**: After automated verification passes, pause for the final manual prompt-quality pass. Spot-check both characters and iterate on the prompts before closing S-01.

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

## Performance Considerations

The transcript fetch (possibly a polled Whisper job) dominates latency; the UI must show a loading state and tolerate multi-second waits. The 40k-char threshold only sets the 1→2 credit *price*; worst-case LLM token cost/latency is bounded by the `HARD_MAX_TRANSCRIPT_CHARS` reject gate (F5), which returns 413 before the LLM call for pathologically long transcripts. The confirm path re-fetches the transcript (accepted tradeoff). No new N+1 or hot-path concerns; volumes are MVP-small.

## Migration Notes

**Expand/contract, two migrations** (F3). Existing live migrations are untouched.

1. **Expand (this slice)**: one forward migration adds `spend_credits` + `refund_credits` and **leaves `spend_credit()` in place**. `credits.ts` is switched to `spend_credits` in the same phase. Deploy order is now safe in both directions: the DB has both functions, so the old Worker (still calling `spend_credit`) and the new Worker (calling `spend_credits`) each work. Apply locally with `npx supabase migration up`; push to cloud before/with the Worker deploy.
2. **Contract (follow-up, after the new Worker is live)**: a later migration runs `drop function if exists public.spend_credit();`. This is deferred because dropping it alongside the expand migration would open a deploy window — DB-first would break the still-running old Worker, and Worker-first would call an RPC not yet created. Nothing in this slice's scope references `spend_credit` after the `credits.ts` switch, so the drop is forward-safe once the new Worker is confirmed live.

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-01)
- Proven pipeline: `src/pages/api/summaries/probe.ts` (to become `generate.ts`)
- Credit RPC pattern: `supabase/migrations/20260712175240_user_credits.sql:48-71`, `20260714140000_assert_least_privilege_functions.sql`
- F-02 follow-ups carried here: `context/changes/transcript-llm-probe/plan-brief.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Existing UI copy → English

#### Automated

- [x] 1.1 Linting passes: `npm run lint` — 4f48536
- [x] 1.2 Build passes: `npm run build` — 4f48536

#### Manual

- [ ] 1.3 Notice banner renders entirely in English with a key unset

### Phase 2: DB — variable-cost credit spend

#### Automated

- [x] 2.1 Migration applies cleanly: `npx supabase migration up` — 23d59cc
- [x] 2.2 Type checking passes: `npm run build` — 23d59cc
- [x] 2.3 Linting passes: `npm run lint` — 23d59cc

#### Manual

- [ ] 2.4 `spend_credits(2)` lowers balance by 2 / returns new balance; over-spend returns -1 and no change
- [ ] 2.5 `spend_credits` not executable by `anon` (least privilege holds)
- [ ] 2.6 `refund_credits` executable only by `service_role` (denied for `authenticated`/`anon`)

### Phase 3: Cost policy

#### Automated

- [x] 3.1 Type checking passes: `npm run build` — b22d6f1
- [x] 3.2 Linting passes: `npm run lint` — b22d6f1

### Phase 4: Endpoint — rename & harden

#### Automated

- [ ] 4.1 Type checking passes: `npm run build`
- [ ] 4.2 Linting passes: `npm run lint`
- [ ] 4.3 No stale references (PowerShell): `Get-ChildItem -Recurse -File src | Select-String "summaries/probe"` returns nothing

#### Manual

- [ ] 4.4 Normal video → 200, Polish summary, `cost: 1`, balance −1, row written
- [ ] 4.5 Long video → 200, `cost: 2`, balance −2
- [ ] 4.6 Transcript over `HARD_MAX_TRANSCRIPT_CHARS` → 413 before any debit/LLM call, spends nothing
- [ ] 4.7 No-transcript → 422; forced upstream error → 502 (not 500), balance net-unchanged (debit then refund)

### Phase 5: Long-video confirmation gate

#### Automated

- [ ] 5.1 Type checking passes: `npm run build`
- [ ] 5.2 Linting passes: `npm run lint`

#### Manual

- [ ] 5.3 Long video without `allowLong` → 409 `requiresConfirmation`, `cost: 2`, no spend
- [ ] 5.4 Retry with `allowLong: true` → 200, balance −2
- [ ] 5.5 1-credit user → 409 then 402 (`need 2, have 1`) on the `allowLong` retry

### Phase 6: UI — dashboard generation form

#### Automated

- [ ] 6.1 Type checking passes: `npm run build`
- [ ] 6.2 Linting passes: `npm run lint`

#### Manual

- [ ] 6.3 Valid URL + character + submit → loading → Polish summary inline; credit count −1
- [ ] 6.4 Invalid URL blocked with a message
- [ ] 6.5 Long video → confirmation → "Generate anyway (2 credits)" → count −2
- [ ] 6.6 0 credits blocked; no-transcript shows message and spends nothing
- [ ] 6.7 Verified on latest Chrome and Firefox

### Phase 7: Prompt engineering

#### Automated

- [ ] 7.1 Type checking passes: `npm run build`
- [ ] 7.2 Linting passes: `npm run lint`

#### Manual

- [ ] 7.3 Informational → Polish key-facts list; educational → Polish learning-overview (Polish output from English prompts)
