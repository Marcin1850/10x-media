# Persist generation time and provider cost per summary (S-07) — Implementation Plan

## Overview

Every generation currently produces a summary and forgets everything about how it was made. This change records the facts: how long each external call took, what OpenRouter charged, exactly which Supadata calls were made (including on requests that never produced a summary), and how large the input was. It also stops paying twice for the same transcript by introducing a shared, user-agnostic transcript cache.

Two consumers justify it. The PRD's "75% good-enough" criterion needs speed and spend alongside content, and **S-09 cannot choose a lever without knowing how often `mode: "auto"` silently falls back to Whisper** — a rate nobody has measured. This slice measures; S-09 bounds.

## Current State Analysis

**What exists.** The generate endpoint (`src/pages/api/summaries/generate.ts`) runs a hardened pipeline: per-user generation lease → idempotency probe → balance read gate → transcript acquisition → cost pricing → hard cap → long-video 409 → atomic debit as a reservation → LLM → metadata → `persist_summary` RPC which writes and settles in one transaction. Failure paths refund. `summaries` records `model` and `resolved_via`; `videos` records descriptive metadata since S-08.

**What is missing.**

- No timing is recorded anywhere. The F-02 live run measured 33 s vs 254 s and that spread exists only in a review document.
- `getSummaryModel` (`src/lib/services/llm.ts:7-9`) constructs the model with no settings object, so OpenRouter usage accounting is off and `cost` never arrives.
- Nothing counts Supadata calls. A generation makes 1 billable transcript call plus up to 12 free polls (`transcript.ts:86-88`), 1 **or 2** metadata calls (`metadata.ts:143-150` retries), or **zero** on the `allowLong` quote-cache hit (`generate.ts:240-249`).
- `transcriptLength` is computed at `generate.ts:293` and returned to the client, then discarded.
- The transcript body is never persisted, so a second character re-fetches and pays again — S-01 accepted this explicitly.

**Key constraints discovered.**

- **`persist_summary` is the only writer of `videos`/`summaries`.** `20260726120000_videos_single_writer.sql` revoked `insert`/`update` from `authenticated` deliberately, to make vendor-reported values unforgeable. Any new column on either table must be reachable through that RPC.
- **The RPC cannot be widened in place.** `create or replace` with a different parameter list produces a *second overload*, and grants are signature-scoped — so S-08 dropped and recreated it (`20260725120000_video_metadata.sql:51-54`). Doing so opens a window where the live Worker calls a signature that no longer exists.
- **`resolved_via` is not a billing signal.** `src/types.ts:3` states it records the "observed fetch mechanism only, not a claim about native-caption vs Whisper-generated origin (Supadata's API doesn't expose that)", and `docs/supadata-transcript.md` §mode confirms the `auto` → `generate` fallback is silent. Any credit figure derived from it is an inference — and a *biased* one: a long native-caption video can return a `202` job and be billed 1 credit while `job` prices it at `2 × ceil(duration/60)`.
- **Supadata reports the actual bill per request.** `x-billable-requests` is documented as "included in every API response" (`docs/supadata-billable-requests.md`). It is the only vendor surface that attributes spend to a single call — including calls that returned an error and produced no summary. `GET /v1/me`'s `usedCredits` is a billing-period total, so it can reconcile but never attribute.
- **The SDK throws the header away.** `@supadata/js@1.4.0` funnels every method through one `fetchUrl` that reads headers only for `content-type` and returns `await res.json()`; the `Response` never escapes. There is no interceptor hook, and patching the global `fetch` fails because the module binds it at load time (`var f = fetch || T`). `src/lib/services/metadata.ts:43` already sets the precedent for the way out — call the REST endpoint directly and re-throw the vendor body as a `SupadataError` so downstream error handling is unchanged.
- **Whisper is billed per video minute**, and `duration_seconds` exists only if the metadata fetch succeeded — which happens *after* `summarize()` and not at all on the 422/413/409 exits.
- **`videos` is per-user** (`unique (user_id, youtube_id)`, `on delete cascade` to `auth.users`), so it cannot host a cross-user cache: one account deletion would erase a transcript other users depend on.

## Desired End State

Every persisted summary carries: input size in characters, four timings (transcript / LLM / metadata / total), OpenRouter cost and token counts, and a `resolved_via` that distinguishes a paid fetch from a cache reuse. Every real Supadata HTTP call — including ones on requests that returned 422, 413, 409 or 502 — has a row in an append-only ledger carrying **the credits Supadata itself reported billing for that call**. A transcript fetched once is reused by any user for 30 days, then re-fetched and overwritten.

**Verification:** generating the same short video twice yields a second summary with `resolved_via = 'stored'`, near-zero `transcript_ms`, and **no new transcript ledger row** (one metadata row is still expected — only the transcript is cached); `sum(billable_credits)` over `supadata_calls` reconciles against `GET /v1/me`'s `usedCredits` delta.

### Key Discoveries:

- OpenRouter usage accounting is available in the installed provider, not just in theory: `usage?: { include: boolean }` on model settings (`node_modules/@openrouter/ai-sdk-provider/dist/index.d.ts:412`) and `providerMetadata.openrouter.usage` typed `OpenRouterUsageAccounting` with `cost?: number`, `promptTokens`, `completionTokens` (`:457-468`). The provider is callable as `(modelId, settings)` (`:739`).
- Definer-only table pattern to mirror: `enable row level security` with **no policies** plus `revoke all on table ... from public, anon, authenticated`, RPCs `security definer set search_path = ''`, `revoke all` then `grant execute ... to service_role` (`20260722130000_transcript_spend_guards.sql:24-27`).
- Idempotent additive-column precedent: `20260708162201` / `20260709120000` — one `add column if not exists` per line, RLS untouched.
- The `allowLong` quote cache (`transcript_quotes`) already caches per (user, video, character) for 10 minutes and is dropped after success (`transcript-guard.ts:172-193`). The new cache is broader and outlives it; the two coexist in this slice.

## What We're NOT Doing

- **No UI.** S-02 owns the summary list, S-06 owns styling. Nothing added here is rendered, and no request parameter is exposed to the user.
- **No `forceRefresh` parameter.** The only refresh mechanism is the 30-day window; a request past it re-fetches and overwrites.
- **No cache eviction or pruning.** Rows are overwritten, never deleted.
- **No *inferred* credit figure, anywhere.** The ledger stores only what Supadata reported for that request (`x-billable-requests`). The `resolved_via` → Whisper formula is not used to price anything — not in a column, not in a document. A retrospective estimate built on it was planned and cut.
- **No change to what a summary costs the user.** `summaryCost` and both char thresholds are untouched — this slice measures spend, S-09 bounds it.
- **No retiring of `transcript_quotes`.** It becomes largely redundant once the shared cache lands; removing a hardened path (F17/F24) is a separate change.
- **No backfill and no pricing of history.** Existing rows keep null telemetry. Spend before the ledger exists stays unmeasured rather than estimated from a formula this slice just discredited.

## Implementation Approach

Facts are recorded where they are observed, and nothing derived is stored. Timings are measured around each external call in the endpoint. OpenRouter cost comes from the response the SDK already parses. Supadata cost comes from the `x-billable-requests` header on each response — which is why the transcript path stops going through `@supadata/js` and calls the REST endpoint directly, as `metadata.ts` already does: the SDK returns a parsed body and drops the `Response`, so the figure is unreachable through it. Supadata calls are recorded by a small in-memory meter threaded into the two services that make HTTP calls, then flushed once in a `finally` — which is what lets a 422 (1 billable credit, no summary) leave a trace that columns on `summaries` structurally cannot.

The transcript cache is a user-agnostic table because the alternative — a column on `videos` — is per-user, cascades away on account deletion, and would duplicate up to 200k characters per account. Keyed by `youtube_id` alone, it deduplicates across users, holds no personal data, and still lets analytics join by `youtube_id`. The permanent per-summary record of input size lives on `summaries` as `transcript_chars`, because the cache row is **overwritten** on refresh and would otherwise lose the size of the text an older summary was actually built from.

## Critical Implementation Details

**Timing & lifecycle.** Three orderings are load-bearing:

1. The cache **write** happens immediately after a successful fetch and *before* the long-video 409 returns. A user who abandons the confirmation has still paid Supadata; caching first means the money buys something.
2. The cache **read** happens after the `allowLong` quote check and before `recordTranscriptAttempt`. A cache hit must not consume a rate-limit token — it makes no paid call.
3. The meter **flush** happens in a `finally` in `POST`, alongside the lease release. Every early return (422, 413, 409, 502, 500) must still write its ledger rows; that spend is precisely what a summary-column design would miss.

**Migration & rollback.** Phase 1's migration drops and recreates `persist_summary`, so from the moment it is pushed the deployed Worker calls a signature that no longer exists. This repeats the window S-08 documented and accepted: `persistSummaryAndSettle` throws, the caller refunds the reservation, the user is not charged — but the OpenRouter spend for any generation caught in it is lost. Mitigation is procedural and unchanged: `supabase db push` and `wrangler deploy` are ONE operation in Phase 5, run back to back. Rollback is re-applying `20260725120000_video_metadata.sql`'s function body.

**Debug & observability.** Spend is measured, never estimated. A retrospective estimate over existing rows was planned here and **cut**: it could only have applied the `resolved_via` → Whisper formula that `x-billable-requests` supersedes, and the ledger reports the truth within days of rollout. History before the ledger stays unpriced, deliberately.

---

## Phase 1: Schema

### Overview

Land every schema change in one migration: two new tables, eight telemetry columns, two widened CHECK constraints, and the widened `persist_summary`.

### Changes Required:

#### 1. Schema migration

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_generation_telemetry.sql`

**Intent**: Create the shared transcript cache and the Supadata call ledger, add the telemetry columns, widen `resolved_via` to admit `'stored'`, and swap `persist_summary` for a signature that can write the new columns.

**Contract**, in five parts:

*(a) `public.transcript_cache`* — `youtube_id text primary key`, `content text not null`, `outcome text not null default 'ok' check (outcome in ('ok','empty','unavailable'))`, `lang text`, `available_langs text[]`, `requested_lang text`, `resolved_via text check (resolved_via in ('inline','job'))`, `fetched_at timestamptz not null default now()`. **No `user_id`**: the row is a cache of public third-party content shared by all users, holds no personal data, and must not vanish when one account is deleted. `enable row level security` with no policies, `revoke all ... from public, anon, authenticated`. `requested_lang` is diagnostic only — it records which `lang` the app asked for at fetch time and gates nothing.

`outcome` is what makes this a **negative cache as well as a positive one**, and the three values are not interchangeable:

| `outcome` | What the vendor did | Reuse means |
| --- | --- | --- |
| `ok` | Returned usable text | Summarize it — the paid fetch is skipped |
| `empty` | Returned success with whitespace-only content | 422 for free — an instrumental video is *permanently* wordless, so re-paying for it buys the same nothing |
| `unavailable` | Said `transcript-unavailable` (or completed a job with no content) | 422 for free — but on a **short window**, see below |

`content` stays `not null` and holds `''` for both negative outcomes; the `outcome` column, not the emptiness of `content`, is the thing code branches on. Recording them separately costs one column and preserves the distinction between "we were told there is nothing" and "we were given nothing", which the ledger's analytics would otherwise lose.

**`unavailable` rows carry their own, shorter TTL.** YouTube publishes auto-captions with a lag after upload, so a freshly uploaded video can legitimately answer `transcript-unavailable` now and succeed hours later. Caching that for the full 30 days would lock the video out for a month — and recent videos are a core use case for this app. Only `failed`/`timeout` outcomes are never cached at all (they are transient by construction); `unavailable` is cached briefly because it is *usually* but not *always* permanent.

*(b) `public.supadata_calls`* — `id uuid primary key default gen_random_uuid()`, `user_id uuid references auth.users (id) on delete set null`, `summary_id uuid references public.summaries (id) on delete set null`, `youtube_id text`, `operation text not null check (operation in ('transcript','transcript_poll','metadata'))`, `outcome text not null check (outcome in ('ok','unavailable','error'))`, `resolved_via text`, `billable_credits integer`, `created_at timestamptz not null default now()`. `billable_credits` is **nullable and stored verbatim** from the response's `x-billable-requests` header: `null` means the vendor reported nothing (or the response never arrived), `0` means it reported free. Keeping those two distinct is what makes a Phase 5 reconciliation gap diagnosable instead of merely visible; comment the column to say so. Both FKs are `set null`, not `cascade`: the operator's bill does not shrink when a user deletes their account or a summary, and erasing the link erases the personal data. Index on `(created_at)` and on `(user_id, created_at)`. Same definer-only RLS treatment as (a).

*(c) Telemetry columns on `summaries`*, each `add column if not exists`: `transcript_chars integer`, `generation_ms integer`, `transcript_ms integer`, `llm_ms integer`, `metadata_ms integer`, `cost_usd numeric`, `prompt_tokens integer`, `completion_tokens integer`. Comment `cost_usd` as OpenRouter's own reported figure, not a computed one.

*(d) Two widened CHECKs* — `resolved_via` must admit `'stored'` in **both** places it is constrained, not just one:

1. `summaries` — drop and re-add the constraint created inline by `20260709120000`. It is auto-named, so target `summaries_resolved_via_check` with `drop constraint if exists` before adding.
2. `transcript_quotes` — same treatment for the constraint at `20260722130000_transcript_spend_guards.sql:77-85`. **This one is easy to miss and fails silently.** A long video served from the shared cache arrives at the 409 gate with `resolvedVia = 'stored'` and calls `saveTranscriptQuote` (`generate.ts:307`); the widened TypeScript union compiles fine, the RPC rejects the row, and `transcript-guard.ts` swallows the error by design. The visible symptom is not an error — it is the confirmation retry paying Supadata again, i.e. the exact cost this slice exists to remove.

*(e) `persist_summary` swap* — drop the 15-argument function and create a 23-argument one adding `p_transcript_chars`, `p_generation_ms`, `p_transcript_ms`, `p_llm_ms`, `p_metadata_ms`, `p_cost_usd`, `p_prompt_tokens`, `p_completion_tokens`. **Everything about how the function decides is preserved verbatim** — the `for update` ledger lock, the replay guard, the status gate, the outcome tags, the settle, and the coalescing `on conflict` for the `videos` metadata columns. Only the `summaries` insert column list grows. Re-issue `revoke all` / `grant execute ... to service_role` against the **new** signature; the old signature's grants died with the function.

#### 2. Cache and ledger RPCs

**File**: same migration

**Intent**: Give the Worker service-role-only entry points for the three new operations, matching how every other definer table in this repo is reached.

**Contract**:
- `get_transcript_cache(p_youtube_id text, p_max_age_seconds integer, p_negative_max_age_seconds integer) returns table (content text, outcome text, lang text, available_langs text[], resolved_via text, fetched_at timestamptz)` — returns nothing when absent, or when the row is older than the window **that applies to its own `outcome`**: `p_max_age_seconds` for `'ok'`, `p_negative_max_age_seconds` for `'empty'` and `'unavailable'`. Expressing the two windows as separate arguments keeps the policy in the caller's named constants rather than baked into SQL.
- `save_transcript_cache(p_youtube_id text, p_content text, p_outcome text, p_lang text, p_available_langs text[], p_requested_lang text, p_resolved_via text)` — upsert on `youtube_id`, overwriting **every** field including `fetched_at = now()`. Unlike `persist_summary`'s video upsert this must NOT coalesce: a refresh past the window is exactly the case where the new value must win. A later successful fetch therefore replaces a negative row outright, which is how a video that gains captions heals.
- `record_supadata_calls(p_calls jsonb)` — inserts a batch in one statement, so a whole generation's ledger rows cost one round trip.

All three `security definer`, `set search_path = ''`, `revoke all` then `grant execute` to `service_role` only.

#### 3. Type declarations

**File**: `src/types.ts`, `src/lib/services/summaries.ts`

**Intent**: Reflect the new columns and the third `resolved_via` value so the compiler enforces the wider RPC signature at every call site.

**Contract**: `TranscriptResolvedVia` gains `"stored"`. `Summary` gains the eight telemetry fields. `AppDatabase["public"]["Functions"]["persist_summary"]["Args"]` grows to 23 entries; add `transcript_cache` / `supadata_calls` entries only if a typed client actually touches them (the services use the untyped admin client, so they likely do not).

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly on a fresh local DB: `npx supabase migration up`
- Linting passes: `npm run lint`
- Build passes: `npm run build`
- Exactly one `persist_summary` exists after the swap: `select count(*) from pg_proc where proname = 'persist_summary'` returns 1
- `persist_summary` is `service_role`-only: `has_function_privilege('authenticated', ..., 'execute')` is false
- Both new tables have RLS enabled and zero policies

#### Manual Verification:

- `summaries` accepts `resolved_via = 'stored'` and still rejects an unknown value
- **`transcript_quotes` also accepts `resolved_via = 'stored'`** — check this table explicitly, not just `summaries`; it is the constraint whose failure is silent
- `transcript_cache` rejects an `outcome` outside `('ok','empty','unavailable')`

**Implementation Note**: After this phase the local DB no longer matches the deployed Worker's expectations. Do not push to cloud until Phase 5.

---

## Phase 2: OpenRouter cost instrumentation

### Overview

Turn on usage accounting and return cost and token counts from `summarize()`. Self-contained: one file, one call site, no schema dependency beyond Phase 1's columns.

### Changes Required:

#### 1. Enable usage accounting and surface the figures

**File**: `src/lib/services/llm.ts`

**Intent**: Ask OpenRouter to include usage accounting in the response, then return the cost and token counts alongside the existing text and model so the endpoint can persist them.

**Contract**: `getSummaryModel` passes a settings object as the provider's second argument (`createOpenRouter({ apiKey })(SUMMARY_MODEL_SLUG, { usage: { include: true } })`). `SummarizeResult` gains `costUsd: number | null`, `promptTokens: number | null`, `completionTokens: number | null`, read from `providerMetadata?.openrouter?.usage`. Every field is optional in the provider's type (`cost?: number`), and `providerMetadata` itself is optional — read defensively and coalesce to null rather than asserting. A missing cost must never fail a generation that already produced a valid summary: this is telemetry attached to work that is already paid for.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build and type-check pass: `npm run build`
- No non-null assertion or unsafe cast is introduced around `providerMetadata`

#### Manual Verification:

- One real generation logs a non-null cost and token counts (temporary log or debugger), confirming the figures actually arrive rather than being silently absent
- The reported `promptTokens` is plausible against the transcript length submitted

---

## Phase 3: Supadata instrumentation — cache and ledger

### Overview

Two new services and metering inside the two modules that make Supadata HTTP calls. No endpoint changes yet; this phase builds the parts Phase 4 wires together.

### Changes Required:

#### 1. Transcript cache service

**File**: `src/lib/services/transcript-cache.ts` (new)

**Intent**: Read and write the shared transcript cache through the service-role RPCs, with both reuse windows expressed as named constants.

**Contract**: Export two windows — `TRANSCRIPT_CACHE_MAX_AGE_SECONDS = 2_592_000` (30 days, `outcome = 'ok'`) and `TRANSCRIPT_CACHE_NEGATIVE_MAX_AGE_SECONDS = 86_400` (24 hours, `'empty'` and `'unavailable'`) — and two functions taking the admin client: `getCachedTranscript(admin, youtubeId)` returning `{ content, outcome, lang, availableLangs, resolvedVia, fetchedAt } | null`, and `saveCachedTranscript(admin, {...})` returning void. Both **best-effort and never throwing**, mirroring `transcript-guard.ts`: a cache miss on error just means a paid fetch, and a failed write must not fail a generation. Narrow the RPC result at the boundary rather than destructuring `any`, as the existing guards do.

Comment the 24-hour constant with its reason — it is a *risk bound*, not a performance tuning knob. A negative row is a claim about a video that may stop being true (auto-captions arrive late on fresh uploads), so the window caps how long a wrong claim can be served. Widening it trades user-visible correctness for credits; the two constants exist separately so that trade can never be made by accident.

#### 2. Supadata call meter and ledger writer

**File**: `src/lib/services/supadata-ledger.ts` (new)

**Intent**: Collect one record per real Supadata HTTP call during a request, then write them all in one round trip at the end — including on requests that never persist a summary.

**Contract**: `createSupadataMeter()` returns an object with `record({ operation, outcome, youtubeId, resolvedVia, billableCredits })` — `billableCredits` is `number | null`, passed through untouched by the caller that read the header, `attachSummary(summaryId)` (stamps every collected row, called once after a successful persist), and `drain()`. Recording is a plain in-memory push and **cannot throw** — it runs inside the catch blocks that make the calling services total, so a throwing meter would defeat the totality guarantee those services provide. `flushSupadataCalls(admin, userId, meter)` posts the batch via `record_supadata_calls` and never throws; a lost ledger row is a lost measurement, not a failed generation.

#### 3. Meter the transcript calls

**File**: `src/lib/services/transcript.ts`

**Intent**: Record every HTTP call this module makes, distinguishing the billable transcript request from the free job polls, and capture what Supadata says each one cost.

**Contract**, two parts:

*(a) Replace the SDK transport with a direct `fetch`.* `@supadata/js` returns a parsed body and discards the `Response`, so `x-billable-requests` is unreachable through it (`docs/supadata-billable-requests.md` §"Why the SDK cannot supply it"). Call `GET /v1/transcript?url=…&text=true&mode=auto&lang=en` and `GET /v1/transcript/{jobId}` directly with the `x-api-key` header, following `metadata.ts:31-77` — which already does exactly this for `/v1/metadata` and is the implementation to copy. **Error semantics must be preserved verbatim**, because `fetchTranscript`'s `transcript-unavailable` branch (`transcript.ts:76`) and every caller depend on them: non-2xx with a JSON body → `new SupadataError(body)`; non-2xx without → `SupadataError({ error: 'internal-error', … })`; 2xx with a non-JSON content-type → the same. The `lang: "en"` decision and its long rationale comment (`transcript.ts:30-53`) are untouched — only the transport changes. Parse the header defensively: `null` when absent or unparseable, never a throw.

*(b) Split the failure reason.* `TranscriptResult`'s failure arm is today a single `{ ok: false; reason: "unavailable" }` that five distinct situations collapse into — the vendor's `transcript-unavailable` error (`transcript.ts:76`), a non-string `content` (`:64`), a job that completed with no content (`:100`), a job that **failed** (`:103`), and a poll budget **exhausted** after 12 attempts (`:110`). The first three are the vendor saying "there is no transcript"; the last two are transient, and the timeout is likeliest on exactly the long videos where Whisper runs longest. Widen the arm to `reason: "unavailable" | "failed" | "timeout"` so the endpoint can cache the permanent answer without ever caching a transient one. **The user-facing surface does not change** — all three still map to the same 422 at `generate.ts:277`; the distinction exists solely to gate the negative cache and to give the ledger a truthful `outcome`.

*(c) Meter each call.* `fetchTranscript` accepts an optional meter. Record one `operation: 'transcript'` per invocation with the observed outcome (`ok` / `unavailable` / `error`), the `resolvedVia` when known, and the header value; record one `operation: 'transcript_poll'` per job-status call with its own header reading. **Polls are documented free** (`docs/supadata-transcript.md:80`) and must stay a distinct operation — but record the header rather than assuming zero, since whether the `202` or the polls carry the charge is exactly the open question (`docs/supadata-billable-requests.md` §Unverified). A `transcript-unavailable` result is `outcome: 'unavailable'` and is **still billable** (`:81`) — that row, now carrying a measured credit figure rather than an assumed one, is the single most valuable thing this ledger captures.

#### 4. Meter the metadata calls

**File**: `src/lib/services/metadata.ts`

**Intent**: Record each metadata attempt separately, so the retry path shows up as the second real credit it is.

**Contract**: `fetchVideoMetadata` accepts the same optional meter and records one `operation: 'metadata'` row **per `requestMetadata` call** — the retry at `:149` is a second billable request that a per-generation assumption of "1 metadata call" would miss. This module already calls `fetch` directly (`:43`), so the `Response` is in hand: read `x-billable-requests` there and pass it into `record`, including on the error paths that throw `SupadataError`. Recording happens inside the existing structure without weakening the function's totality contract.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build and type-check pass: `npm run build`
- The meter parameter is optional everywhere, so existing call sites compile unchanged
- `transcript.ts` no longer calls `supadata.transcript(...)`, and still throws `SupadataError` with `error === 'transcript-unavailable'` on that vendor response
- `TranscriptResult`'s failure arm is `"unavailable" | "failed" | "timeout"`, and each of the five failure sites returns the reason matching its cause

#### Manual Verification:

- A local generation with the transcript service exercised produces the expected in-memory record set (verified by log): one `transcript` row, N `transcript_poll` rows on the job path, one `metadata` row (two if the retry fired)
- Every recorded row carries a `billableCredits` that is either an integer or `null` — never `NaN`, never a throw on a missing header
- A video with no transcript still returns `{ ok: false, reason: 'unavailable' }` after the transport swap, proving error handling survived
- `record_supadata_calls` inserts a hand-built batch correctly against the local DB, including null `user_id`, null `summary_id` and null `billable_credits`

---

## Phase 4: Endpoint wiring

### Overview

Wire the cache into the transcript acquisition path, measure the four timings, flush the ledger on every exit, and thread telemetry into the widened persist call.

### Changes Required:

#### 1. Meter lifecycle and flush

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Create the meter once per request and flush it on every exit path, so spend on requests that produce no summary is still recorded.

**Contract**: Create the meter in `POST` after the admin client is available, pass it into `runGeneration`, and flush it in the existing `finally` alongside `releaseGenerationLease`. The `finally` is the contract: 422 at `:279`, 413 at `:299`, 409 at `:318`, 502 at `:380` and every 500 must all flush. Call `attachSummary` immediately after a successful `persistSummaryAndSettle` so successful rows carry the link, while the rest stay null by design.

#### 2. Cache lookup and reuse

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Reuse what a previous request already paid for — by any user — whether that was a transcript or the knowledge that there isn't one.

**Contract**, three parts:

*(a) Read.* After the `allowLong` quote-cache branch and **before** `recordTranscriptAttempt`, look up `getCachedTranscript`. On an `outcome = 'ok'` hit, take `content`, `lang`, `availableLangs` from it, set `resolvedVia = 'stored'`, and skip both the rate-limit call and the fetch — the request makes no paid call, so it must consume no rate-limit token. On an `'empty'` or `'unavailable'` hit, return the same 422 the fetch path would have returned, immediately: no Supadata call, no rate-limit token, no debit.

*(b) Write.* On a miss, the existing fetch path runs unchanged and `saveCachedTranscript` is called immediately after the fetch resolves, **before** the long-video 409 return at `:318`, so an abandoned confirmation still leaves the paid transcript cached. Every *billable* outcome is cached, not just the useful one: `ok:true` with text → `'ok'`; `ok:true` with whitespace-only content → `'empty'`; `reason: 'unavailable'` → `'unavailable'`. `reason: 'failed'` and `reason: 'timeout'` are **never** written — they say nothing durable about the video.

*(c) Hoist the whitespace guard.* The rejection at `generate.ts:281-285` currently sits **inside** the fetch branch, so it never sees a cached transcript. Move it below the whole acquisition if/else so it covers all three sources. This is not tidying — it is load-bearing:

- `summaryCost(0)` returns `1` (`summaries.ts:131-133`), so an empty transcript reaching the main path clears the 413 and the 409, **debits a credit, and sends nothing to the LLM**.
- The quote cache is safe today only by accident: `saveTranscriptQuote` is called at the 409 gate, downstream of the guard, so it can never hold an empty. The shared cache is written straight after the fetch, so it can — this plan is what makes the latent bug reachable.

With the guard hoisted, an `'empty'` cache hit fails the same way a fresh empty fetch does, which is what makes (a) safe to write as an early 422 rather than a special case threaded through the rest of the function.

#### 3. Timings

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Measure each external call separately plus the request as a whole.

**Contract**: `transcript_ms` brackets whatever produced the transcript — the fetch, the quote read, or the cache read — so a `'stored'` row legitimately reads near zero and `resolved_via` explains why. `llm_ms` brackets `summarize()`. `metadata_ms` brackets `fetchVideoMetadata` (retry and its ~1.2 s sleep included; that delay is real latency the user waited through). `generation_ms` is wall-clock from the start of `runGeneration` to just before the success response. Use `Date.now()` deltas rounded to integers — the columns are `integer`.

#### 4. Thread telemetry through persistence

**File**: `src/lib/services/summaries.ts`

**Intent**: Carry the new values into the widened RPC.

**Contract**: `PersistSummaryParams` gains `transcriptChars`, the four timings, `costUsd`, `promptTokens`, `completionTokens` — all optional and defaulting to null, matching how `metadata` / `transcriptLang` were added in S-08. `persistSummaryAndSettle` passes them as the eight new `p_*` arguments. `transcriptChars` is `content.length`, the value already computed at `generate.ts:293`.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build and type-check pass: `npm run build`
- `npx supabase migration up` still applies cleanly from scratch

#### Manual Verification:

- Local generation persists a summary with all eight telemetry columns populated and plausible
- Second local generation of the same video (other character) returns `resolved_via = 'stored'`, near-zero `transcript_ms`, and writes **no** `transcript` ledger row
- A forced 422 (a video with no transcript) writes a `transcript` / `unavailable` ledger row with null `summary_id`, **and a `transcript_cache` row with `outcome = 'unavailable'`**
- Repeating that 422 video returns 422 again with **no new ledger row at all** — the negative cache served it and nothing was paid
- A cache row exists after the first generation and its `fetched_at` / `requested_lang` are correct
- A **long** video served from the shared cache reaches the 409 and its `transcript_quotes` row is actually written with `resolved_via = 'stored'` (query the table — a swallowed constraint failure looks identical to success from the client)

---

## Phase 5: Rollout and live verification

### Overview

Close the RPC-swap window with a back-to-back push and deploy, then spend a small, deliberate number of real credits proving the telemetry is true rather than merely present.

### Changes Required:

#### 1. Coordinated rollout

**File**: — (operational)

**Intent**: Apply the migration and deploy the Worker as one operation, because between them the live Worker calls a `persist_summary` signature that no longer exists.

**Contract**: `npx supabase db push --linked` immediately followed by `npx wrangler deploy`, with no other work in between — the same procedure S-08 used and documented. Confirm `npx supabase migration list --linked` is in sync afterwards. Any generation caught in the window refunds the user but loses its OpenRouter spend; do not run this while a generation is in flight.

#### 2. Live verification pass

**File**: `context/changes/persist-time-and-cost/reviews/manual-verification.md`

**Intent**: Prove the numbers are real against production, at a budgeted cost of roughly **6–9 Supadata credits** — the higher figure buys the one answer no cheaper run can produce (see run 3).

**Contract**: Read `GET /v1/me` before and after **each** run, not just at the ends; per-run deltas are what make an individual row's header value falsifiable.

*Run 1 — short native video.* Writes `transcript` + `metadata` ledger rows and non-null cost/tokens/timings.

*Run 2 — same video, other character.* Writes `resolved_via = 'stored'`, no `transcript` row, and a `metadata` row (metadata is still fetched — only the transcript is cached).

*Run 3 — a short video with no captions, forcing the `job`/Whisper path.* **This run exists to settle what `x-billable-requests` actually counts**, and runs 1 and 2 cannot: on a native call a request count and a credit count are both `1`, so they agree no matter which the header reports. Pick the shortest caption-less video that will do (~1–2 min, so 2–4 credits). Read off:

| `usedCredits` delta | Header reported | Conclusion |
| --- | --- | --- |
| `2 × ceil(min)` | the same figure | the header is **credits** — `billable_credits` is correctly named and self-sufficient |
| `2 × ceil(min)` | `1` | the header is a **request count** — rename the column `billable_requests`, and `resolved_via` + `duration_seconds` stay load-bearing for costing |

Record the answer in `docs/supadata-billable-requests.md` §Unverified and rename the column **before** any further rows accumulate — a column whose unit is discovered after people have reasoned from it is the same failure mode F1 raised about `resolved_via`.

**`sum(billable_credits)` over the new rows must equal the total `usedCredits` delta.** A mismatch is a finding, not a failure: record which rows came back `null` and which call shapes they belonged to, since that is what `docs/supadata-billable-requests.md` §"which responses" leaves open (the `202`, the free polls, the error responses). Run 3 doubles as the test for whether polls are genuinely free.

#### 3. Tracker sync

**File**: `context/foundation/roadmap.md`

**Intent**: Keep the roadmap and Linear consistent with reality, per this project's recorded lessons.

**Contract**: Update S-07's Status, the At a glance row and the Backlog Handoff row in one edit, noting the change-id is `persist-time-and-cost` (the roadmap originally said `summary-generation-telemetry`), and record what S-09 can now decide from measured data. Move the matching Linear issue and comment on it.

### Success Criteria:

#### Automated Verification:

- `npx supabase migration list --linked` shows local and remote in sync
- `wrangler deploy` reports a new version and the deployed Worker serves a generation without a 500

#### Manual Verification:

- All three live runs behave exactly as specified above, and the total `usedCredits` delta matches `sum(billable_credits)`; any gap is attributed to specific null-valued rows rather than left unexplained
- Telemetry on the live rows is plausible: `llm_ms` dominates on a short native video, `cost_usd` is in the ~1–2 ¢ range observed for this model
- **The header's unit is settled by run 3** and recorded in `docs/supadata-billable-requests.md`; if it is a request count, the column is renamed before any further rows accumulate
- Whether `resolved_via = 'job'` is a usable Whisper proxy is answered from run 3's measured figures
- Roadmap and Linear both reflect the landed state

---

## Testing Strategy

There is no automated test suite in this project (Module-3 deferral), so verification is the type-checker, the migration runner, the linter, and structured manual passes.

### Manual Testing Steps:

1. Fresh `npx supabase migration up` on an empty DB — every migration applies in order.
2. Local generation of a short video: inspect the `summaries` row for eight populated telemetry columns, `supadata_calls` for one `transcript` + one `metadata` row, `transcript_cache` for one row.
3. Repeat with the other character: expect `'stored'`, no new `transcript` row, a new `metadata` row.
4. A video with no transcript: expect 422, a `transcript`/`unavailable` ledger row with null `summary_id`, no summary, and a `transcript_cache` row with `outcome = 'unavailable'`. Repeat it: expect 422 with **zero** new ledger rows.
5. A long video (>40k chars) up to the 409, then abandon: expect a cached transcript despite no summary, and ledger rows recorded. Re-run it from cache and confirm the `transcript_quotes` row is written with `resolved_via = 'stored'`.
6. Live pass per Phase 5, budgeted at 6–9 credits.

**Deliberately not verified live** (cost): the metadata retry, and the negative cache's 24-hour expiry. Both are exercised locally by reasoning and DB inspection — the expiry by backdating `fetched_at` rather than waiting a day. State this limitation in the verification record rather than implying full coverage.

The Whisper `job` path **is** now verified live (Phase 5 run 3), reversing this plan's earlier position. It was excluded on cost while its only purpose was confirming a price already in the docs; it is included now because it is the sole run that can determine whether `x-billable-requests` reports credits or requests, and every figure the ledger accumulates depends on that answer.

## Performance Considerations

The cache read adds one DB round trip before a fetch that costs money and seconds — a favourable trade whenever it hits, and negligible when it misses. The ledger costs exactly one round trip per request regardless of how many calls were made, because rows are batched. Usage accounting adds no latency; the figures ride the response already being parsed. Cache growth is unbounded by design (one row per video, up to 200k chars) — accepted at MVP scale and worth revisiting only if the video count grows by orders of magnitude.

## Migration Notes

The migration is additive except for the `persist_summary` swap and the two `resolved_via` CHECK replacements. No backfill: existing summaries keep null telemetry and their spend stays unpriced. `transcript_cache` starts empty, so the first generation after rollout always pays — the cache earns from the second one onward, and the negative cache earns only from a repeated request for a video that has no transcript.

## References

- Roadmap slice: `context/foundation/roadmap.md` §S-07 (F4, F5, T3, T4)
- Origin findings: `context/changes/transcript-llm-probe/reviews/impl-review-phase-4.md:57-75`
- Supadata pricing and limits: `context/changes/persist-video-metadata/docs/supadata-transcript.md` §Pricing, `supadata-account-limits.md`
- Per-request credit header and why the SDK can't supply it: `context/changes/persist-time-and-cost/docs/supadata-billable-requests.md`
- RPC-swap precedent and its accepted window: `supabase/migrations/20260725120000_video_metadata.sql:11-22`
- Definer-only table pattern: `supabase/migrations/20260722130000_transcript_spend_guards.sql:24-27`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema

#### Automated

- [ ] 1.1 Migration applies cleanly on a fresh local DB (`npx supabase migration up`)
- [ ] 1.2 Linting passes (`npm run lint`)
- [ ] 1.3 Build passes (`npm run build`)
- [ ] 1.4 Exactly one `persist_summary` exists in `pg_proc`
- [ ] 1.5 `persist_summary` is service_role-only (authenticated execute privilege is false)
- [ ] 1.6 Both new tables have RLS enabled and zero policies

#### Manual

- [ ] 1.7 `summaries` accepts `resolved_via = 'stored'` and rejects unknown values
- [ ] 1.8 `transcript_quotes` also accepts `resolved_via = 'stored'`
- [ ] 1.9 `transcript_cache` rejects an `outcome` outside `('ok','empty','unavailable')`

### Phase 2: OpenRouter cost instrumentation

#### Automated

- [ ] 2.1 Linting passes (`npm run lint`)
- [ ] 2.2 Build and type-check pass (`npm run build`)
- [ ] 2.3 No non-null assertion or unsafe cast around `providerMetadata`

#### Manual

- [ ] 2.4 A real generation yields non-null cost and token counts
- [ ] 2.5 Reported `promptTokens` is plausible against the submitted transcript length

### Phase 3: Supadata instrumentation — cache and ledger

#### Automated

- [ ] 3.1 Linting passes (`npm run lint`)
- [ ] 3.2 Build and type-check pass (`npm run build`)
- [ ] 3.3 Meter parameter is optional; existing call sites compile unchanged
- [ ] 3.4 `transcript.ts` no longer calls `supadata.transcript(...)` and still throws `SupadataError` with `transcript-unavailable`
- [ ] 3.5 `TranscriptResult`'s failure arm is `"unavailable" | "failed" | "timeout"`, each site returning the reason matching its cause

#### Manual

- [ ] 3.6 Local generation produces the expected record set (transcript / polls / metadata)
- [ ] 3.7 Every recorded row carries an integer or null `billableCredits` — never `NaN`, never a throw
- [ ] 3.8 A video with no transcript still returns `{ ok: false, reason: 'unavailable' }` after the transport swap
- [ ] 3.9 `record_supadata_calls` inserts a hand-built batch including null `user_id`, `summary_id` and `billable_credits`

### Phase 4: Endpoint wiring

#### Automated

- [ ] 4.1 Linting passes (`npm run lint`)
- [ ] 4.2 Build and type-check pass (`npm run build`)
- [ ] 4.3 `npx supabase migration up` still applies cleanly from scratch

#### Manual

- [ ] 4.4 Local generation persists all eight telemetry columns, plausibly valued
- [ ] 4.5 Second generation of the same video returns `'stored'`, near-zero `transcript_ms`, no `transcript` ledger row
- [ ] 4.6 A forced 422 writes a `transcript`/`unavailable` ledger row with null `summary_id` and a `transcript_cache` row with `outcome = 'unavailable'`
- [ ] 4.7 Repeating that 422 video returns 422 with zero new ledger rows
- [ ] 4.8 Cache row exists with correct `fetched_at` and `requested_lang`
- [ ] 4.9 A long video served from cache reaches the 409 and its `transcript_quotes` row is written with `resolved_via = 'stored'`

### Phase 5: Rollout and live verification

#### Automated

- [ ] 5.1 `npx supabase migration list --linked` shows local and remote in sync
- [ ] 5.2 `wrangler deploy` reports a new version and a live generation returns without a 500

#### Manual

- [ ] 5.3 All three live runs behave as specified; total `usedCredits` delta matches `sum(billable_credits)`, any gap attributed to specific null rows
- [ ] 5.4 Live telemetry values are plausible (`llm_ms` dominates, `cost_usd` ~1–2 ¢)
- [ ] 5.5 Header unit settled by run 3 and recorded in `docs/supadata-billable-requests.md`; column renamed if it is a request count
- [ ] 5.6 `resolved_via`-as-Whisper-proxy question answered from run 3's measured figures
- [ ] 5.7 Roadmap (status, At a glance, Backlog Handoff) and Linear both updated
