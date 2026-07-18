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

Build backend-first in curl-verifiable increments, then the UI. Isolate the cross-cutting English-copy cleanup first (smallest, independent). Then: the DB primitive (variable spend), the pure cost policy, the prompt rewrite, the endpoint productionization, the confirmation gate, and finally the dashboard island. Each phase is independently verifiable; the UI phase is the only one requiring a browser.

## Critical Implementation Details

- **Migration immutability**: the credit migrations are live on cloud and must not be edited. Add one new forward migration; retire `spend_credit()` there with `drop function` (forward-safe on fresh replay).
- **Up-front gate ordering**: the minimum-1-credit balance check must stay **before** `fetchTranscript` so a zero-balance user never triggers a paid Supadata/OpenRouter call. The cost-specific gate (`balance < cost`) runs **after** transcript length is known.
- **Post-save spend is best-effort**: preserve the probe's existing contract — once the summary is persisted, a spend failure is logged and the balance re-read, but the request still returns 200 with the summary. A spend must never turn a saved summary into an error.
- **Double transcript fetch on confirm**: when a long video hits the 409 gate, the transcript was already fetched; the "Generate anyway" resubmit fetches it again. Accepted MVP tradeoff (usually a fast inline fetch; a rare Whisper re-trigger is the edge). The up-front toggle avoids it entirely for users who know a video is long.

---

## Phase 1: Existing UI copy → English

### Overview

Standardize the only Polish *chrome* to English so the app is consistent with the new English generation UI. Excludes the `llm.ts` system prompts (they produce Polish summaries — handled in Phase 4).

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

**Intent**: Create an atomic, owner-scoped, variable-amount spend that can only ever lower the caller's own balance; grant it to `authenticated` only (mirroring the existing least-privilege pattern); drop the now-unused `spend_credit()`.

**Contract**: Function shape mirrors `spend_credit()` (SECURITY DEFINER, `set search_path = ''`, returns new balance or `-1` sentinel). The signature is the contract Phase 2's service and later phases depend on:

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

drop function if exists public.spend_credit();
```

#### 2. Credits service: variable amount

**File**: `src/lib/services/credits.ts`

**Intent**: Let `spendCredit` spend N credits via the new RPC, defaulting to 1; keep the `-1` insufficient-sentinel handling and `SpendResult` shape unchanged.

**Contract**: `spendCredit(supabase, amount = 1)` calls `.rpc("spend_credits", { amount })`. Same `{ ok, balance }` return; `INSUFFICIENT_SENTINEL` logic unchanged.

#### 3. Function type update

**File**: `src/lib/services/summaries.ts`

**Intent**: Update the local `AppDatabase` Functions map to the new RPC.

**Contract**: Replace `spend_credit: { Args: Record<string, never>; Returns: number }` with `spend_credits: { Args: { amount?: number }; Returns: number }`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npx supabase migration up`
- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- In the SQL editor, `select public.spend_credits(2)` on a seeded user lowers the balance by 2 and returns the new balance; calling it with amount > balance returns `-1` and does not change the balance.
- `spend_credits` is not executable by `anon` (least privilege holds).

**Implementation Note**: After automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Cost policy

### Overview

Add the pure length→cost policy the endpoint will use to decide 1 vs 2 credits.

### Changes Required:

#### 1. Cost policy helper

**File**: `src/lib/services/summaries.ts`

**Intent**: Expose the long-transcript threshold and a pure function mapping transcript length to credit cost, so the endpoint stays thin and the policy is one testable place.

**Contract**: `export const LONG_TRANSCRIPT_CHARS = 40000;` and `export function summaryCost(transcriptLength: number): number` returning `2` when `transcriptLength > LONG_TRANSCRIPT_CHARS`, else `1`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`

#### Manual Verification:

- N/A (pure function, exercised via the endpoint in Phase 5/6).

**Implementation Note**: After automated verification passes, proceed (no manual gate needed for this pure-logic phase).

---

## Phase 4: Prompt engineering

### Overview

Rewrite the two system prompts to produce the PRD's two distinct output shapes with format and length guidance — the single biggest lever on the 75% "good-enough" success criterion. Prompts are authored in **English** with an explicit instruction to **answer in Polish**.

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

- A curl call to the endpoint (once Phase 5 lands) for an informational video returns a Polish bulleted key-facts list; an educational video returns a Polish learning-overview. Output language is Polish despite English prompts.

**Implementation Note**: After automated verification passes, pause for manual confirmation (prompt quality is the success criterion — spot-check both characters).

---

## Phase 5: Endpoint — rename & harden

### Overview

Promote the probe to the production generation endpoint: rename the file, spend the computed cost, and add upstream-error handling (the F-02 follow-up). The long-video confirmation gate is added in Phase 6; here a long video simply proceeds at cost 2.

### Changes Required:

#### 1. Rename the route

**File**: `src/pages/api/summaries/probe.ts` → `src/pages/api/summaries/generate.ts`

**Intent**: `git mv` to the production path; no other route references it (curl-only spike).

**Contract**: New route `POST /api/summaries/generate`; `export const prerender = false;` retained.

#### 2. Variable cost + upstream-error handling

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Compute the cost from transcript length and spend that many credits; gate on the cost after length is known; wrap the two external calls so Supadata/OpenRouter failures return a clean 502 instead of an unhandled 500. Preserve the existing up-front minimum-1 gate ordering and best-effort post-save spend.

**Contract**: After `fetchTranscript` succeeds, `const cost = summaryCost(transcript.content.length)`. If `balance < cost` → `402` (`"You need <cost> credits for this video; you have <balance>"`). `spendCredit(supabase, cost)` replaces the fixed spend. `fetchTranscript` and `summarize` are each wrapped in try/catch → `502 { error }` (log the real error server-side; do not leak internals). The unavailable-transcript branch stays `422`. Success response gains `cost` and `transcriptLength`: `{ summary, model, videoId, summaryId, creditsRemaining, cost, transcriptLength }`.

#### 3. Config-status reference

**File**: `src/lib/config-status.ts` (verify only)

**Intent**: Confirm no code references the old `probe` path; the config-status "Transcript / LLM" entry is unaffected.

**Contract**: No functional change; grep confirms `probe` has no remaining references.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- No stale references: `grep -rn "summaries/probe" src/` returns nothing

#### Manual Verification:

- `curl -X POST /api/summaries/generate` (authenticated) with a normal video returns 200, a Polish summary, `cost: 1`, and decrements the balance by 1; a new `summaries` row is written.
- A >40k-char video returns 200 with `cost: 2` and decrements by 2.
- A video with no transcript returns 422; forcing an upstream error (e.g. a bad key) returns 502, not 500, and spends no credit.

**Implementation Note**: After automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 6: Long-video confirmation gate

### Overview

Add the opt-in for the higher cost: an `allowLong` request flag plus a 409 "confirmation required" response when a long video hasn't been pre-authorized. Both the up-front toggle and the "Generate anyway" button (Phase 7) resolve to this one flag.

### Changes Required:

#### 1. `allowLong` flag + confirmation branch

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Accept `allowLong` in the request; when the transcript is long and `allowLong` is not set, return a distinct confirmation response *before* summarizing (no LLM call, no spend) so the client can ask the user to confirm the 2-credit cost.

**Contract**: `probeSchema` (now the generate schema) gains `allowLong: z.boolean().optional().default(false)`. After computing `cost`: `if (cost > 1 && !allowLong)` → `409 { error, requiresConfirmation: true, cost, transcriptLength }`. When `allowLong` is true, a long video proceeds and the existing `balance < cost` → 402 check still applies. A short video ignores `allowLong` and always costs 1.

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

## Phase 7: UI — dashboard generation form

### Overview

The user-facing surface: a React island on `/dashboard` that drives the endpoint, renders the summary inline, maps every failure to an English message, and handles the long-video confirmation.

### Changes Required:

#### 1. Generation form island

**File**: `src/components/summaries/GenerateSummaryForm.tsx`

**Intent**: A client island owning the full generate interaction — inputs, request, loading, result, errors, confirmation, and the live credit count. Styled to match the existing custom cosmic theme (reuse `Button` / the auth form field patterns).

**Contract**: Props `{ initialCredits: number | null }`. Local state: `url`, `character` (`"informational" | "educational"`, default informational), `allowLong` (default false), request status, `summary`/`cost`, error message, a `confirm` state (`{ cost, transcriptLength }` from a 409), and `credits` (seeded from `initialCredits`, updated to `creditsRemaining` on success). Client-side URL validation reuses `extractYoutubeId` (pure import) to enable/disable submit; submit is also disabled while loading or when `credits` is 0/null. POSTs `{ url, character, allowLong }` to `/api/summaries/generate`. Response handling:
- `200` → render summary (`whitespace-pre-wrap`), set `credits = creditsRemaining`, note credits spent.
- `409` → enter confirm state; show "This is a long video (~N chars). Generating costs {cost} credits." with a **"Generate anyway ({cost} credits)"** button that resubmits with `allowLong: true`; disable that button when `credits < cost` with a "not enough credits" note.
- `402` → credits message; `422` → "No transcript is available for this video."; `502` → "The transcript or summarization service failed. Please try again."; `503` → "Summary generation isn't configured."; `400`/`401` → validation / "Your session expired — sign in again."
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

The transcript fetch (possibly a polled Whisper job) dominates latency; the UI must show a loading state and tolerate multi-second waits. The 40k-char cap bounds worst-case LLM token cost/latency. The confirm path re-fetches the transcript (accepted tradeoff). No new N+1 or hot-path concerns; volumes are MVP-small.

## Migration Notes

One new forward migration only (`spend_credits`); existing live migrations are untouched. `spend_credit()` is dropped in the same migration and its sole caller (`credits.ts`) is switched in the same phase, so there is no window where the app references a missing function. Apply locally with `npx supabase migration up`; it must also be pushed to the cloud project before/with deploy.

## References

- Roadmap slice: `context/foundation/roadmap.md` (S-01)
- Proven pipeline: `src/pages/api/summaries/probe.ts` (to become `generate.ts`)
- Credit RPC pattern: `supabase/migrations/20260712175240_user_credits.sql:48-71`, `20260714140000_assert_least_privilege_functions.sql`
- F-02 follow-ups carried here: `context/changes/transcript-llm-probe/plan-brief.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Existing UI copy → English

#### Automated

- [ ] 1.1 Linting passes: `npm run lint`
- [ ] 1.2 Build passes: `npm run build`

#### Manual

- [ ] 1.3 Notice banner renders entirely in English with a key unset

### Phase 2: DB — variable-cost credit spend

#### Automated

- [ ] 2.1 Migration applies cleanly: `npx supabase migration up`
- [ ] 2.2 Type checking passes: `npm run build`
- [ ] 2.3 Linting passes: `npm run lint`

#### Manual

- [ ] 2.4 `spend_credits(2)` lowers balance by 2 / returns new balance; over-spend returns -1 and no change
- [ ] 2.5 `spend_credits` not executable by `anon` (least privilege holds)

### Phase 3: Cost policy

#### Automated

- [ ] 3.1 Type checking passes: `npm run build`
- [ ] 3.2 Linting passes: `npm run lint`

### Phase 4: Prompt engineering

#### Automated

- [ ] 4.1 Type checking passes: `npm run build`
- [ ] 4.2 Linting passes: `npm run lint`

#### Manual

- [ ] 4.3 Informational → Polish key-facts list; educational → Polish learning-overview (Polish output from English prompts)

### Phase 5: Endpoint — rename & harden

#### Automated

- [ ] 5.1 Type checking passes: `npm run build`
- [ ] 5.2 Linting passes: `npm run lint`
- [ ] 5.3 No stale references: `grep -rn "summaries/probe" src/` returns nothing

#### Manual

- [ ] 5.4 Normal video → 200, Polish summary, `cost: 1`, balance −1, row written
- [ ] 5.5 Long video → 200, `cost: 2`, balance −2
- [ ] 5.6 No-transcript → 422; forced upstream error → 502 (not 500), no spend

### Phase 6: Long-video confirmation gate

#### Automated

- [ ] 6.1 Type checking passes: `npm run build`
- [ ] 6.2 Linting passes: `npm run lint`

#### Manual

- [ ] 6.3 Long video without `allowLong` → 409 `requiresConfirmation`, `cost: 2`, no spend
- [ ] 6.4 Retry with `allowLong: true` → 200, balance −2
- [ ] 6.5 1-credit user → 409 then 402 (`need 2, have 1`) on the `allowLong` retry

### Phase 7: UI — dashboard generation form

#### Automated

- [ ] 7.1 Type checking passes: `npm run build`
- [ ] 7.2 Linting passes: `npm run lint`

#### Manual

- [ ] 7.3 Valid URL + character + submit → loading → Polish summary inline; credit count −1
- [ ] 7.4 Invalid URL blocked with a message
- [ ] 7.5 Long video → confirmation → "Generate anyway (2 credits)" → count −2
- [ ] 7.6 0 credits blocked; no-transcript shows message and spends nothing
- [ ] 7.7 Verified on latest Chrome and Firefox
