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
- **`resolved_via` is not a billing signal.** `src/types.ts:3` states it records the "observed fetch mechanism only, not a claim about native-caption vs Whisper-generated origin (Supadata's API doesn't expose that)", and `docs/supadata-transcript.md` §mode confirms the `auto` → `generate` fallback is silent. Any credit figure derived from it is an inference.
- **Whisper is billed per video minute**, and `duration_seconds` exists only if the metadata fetch succeeded — which happens *after* `summarize()` and not at all on the 422/413/409 exits.
- **`videos` is per-user** (`unique (user_id, youtube_id)`, `on delete cascade` to `auth.users`), so it cannot host a cross-user cache: one account deletion would erase a transcript other users depend on.

## Desired End State

Every persisted summary carries: input size in characters, four timings (transcript / LLM / metadata / total), OpenRouter cost and token counts, and a `resolved_via` that distinguishes a paid fetch from a cache reuse. Every real Supadata HTTP call — including ones on requests that returned 422, 413, 409 or 502 — has a row in an append-only ledger. A transcript fetched once is reused by any user for 30 days, then re-fetched and overwritten.

**Verification:** generating the same short video twice yields a second summary with `resolved_via = 'stored'`, near-zero `transcript_ms`, and **no new ledger rows**; a `select` over `supadata_calls` reconciles against `GET /v1/me`'s `usedCredits` delta.

### Key Discoveries:

- OpenRouter usage accounting is available in the installed provider, not just in theory: `usage?: { include: boolean }` on model settings (`node_modules/@openrouter/ai-sdk-provider/dist/index.d.ts:412`) and `providerMetadata.openrouter.usage` typed `OpenRouterUsageAccounting` with `cost?: number`, `promptTokens`, `completionTokens` (`:457-468`). The provider is callable as `(modelId, settings)` (`:739`).
- Definer-only table pattern to mirror: `enable row level security` with **no policies** plus `revoke all on table ... from public, anon, authenticated`, RPCs `security definer set search_path = ''`, `revoke all` then `grant execute ... to service_role` (`20260722130000_transcript_spend_guards.sql:24-27`).
- Idempotent additive-column precedent: `20260708162201` / `20260709120000` — one `add column if not exists` per line, RLS untouched.
- The `allowLong` quote cache (`transcript_quotes`) already caches per (user, video, character) for 10 minutes and is dropped after success (`transcript-guard.ts:172-193`). The new cache is broader and outlives it; the two coexist in this slice.

## What We're NOT Doing

- **No UI.** S-02 owns the summary list, S-06 owns styling. Nothing added here is rendered, and no request parameter is exposed to the user.
- **No `forceRefresh` parameter.** The only refresh mechanism is the 30-day window; a request past it re-fetches and overwrites.
- **No cache eviction or pruning.** Rows are overwritten, never deleted.
- **No persisted credit figure.** Credits are derived at query time from ledger rows; nothing stores a number built on the disclaimed `resolved_via` → Whisper inference.
- **No change to what a summary costs the user.** `summaryCost` and both char thresholds are untouched — this slice measures spend, S-09 bounds it.
- **No retiring of `transcript_quotes`.** It becomes largely redundant once the shared cache lands; removing a hardened path (F17/F24) is a separate change.
- **No backfill.** Existing rows keep null telemetry; the retrospective estimate is a document, not a migration.

## Implementation Approach

Facts are recorded where they are observed, and nothing derived is stored. Timings are measured around each external call in the endpoint. OpenRouter cost comes from the response the SDK already parses. Supadata calls are recorded by a small in-memory meter threaded into the two services that make HTTP calls, then flushed once in a `finally` — which is what lets a 422 (1 billable credit, no summary) leave a trace that columns on `summaries` structurally cannot.

The transcript cache is a user-agnostic table because the alternative — a column on `videos` — is per-user, cascades away on account deletion, and would duplicate up to 200k characters per account. Keyed by `youtube_id` alone, it deduplicates across users, holds no personal data, and still lets analytics join by `youtube_id`. The permanent per-summary record of input size lives on `summaries` as `transcript_chars`, because the cache row is **overwritten** on refresh and would otherwise lose the size of the text an older summary was actually built from.

## Critical Implementation Details

**Timing & lifecycle.** Three orderings are load-bearing:

1. The cache **write** happens immediately after a successful fetch and *before* the long-video 409 returns. A user who abandons the confirmation has still paid Supadata; caching first means the money buys something.
2. The cache **read** happens after the `allowLong` quote check and before `recordTranscriptAttempt`. A cache hit must not consume a rate-limit token — it makes no paid call.
3. The meter **flush** happens in a `finally` in `POST`, alongside the lease release. Every early return (422, 413, 409, 502, 500) must still write its ledger rows; that spend is precisely what a summary-column design would miss.

**Migration & rollback.** Phase 1's migration drops and recreates `persist_summary`, so from the moment it is pushed the deployed Worker calls a signature that no longer exists. This repeats the window S-08 documented and accepted: `persistSummaryAndSettle` throws, the caller refunds the reservation, the user is not charged — but the OpenRouter spend for any generation caught in it is lost. Mitigation is procedural and unchanged: `supabase db push` and `wrangler deploy` are ONE operation in Phase 5, run back to back. Rollback is re-applying `20260725120000_video_metadata.sql`'s function body.

**Debug & observability.** The retrospective estimate in Phase 1 runs *before* any schema change and costs nothing. It is the only pre-measurement sizing available, and its disagreement with the ledger's first real rows is itself a finding — it directly tests whether `resolved_via = 'job'` is a usable proxy for the Whisper path.

---

## Phase 1: Retrospective baseline + schema

### Overview

Size the problem with a zero-cost query over existing rows, then land every schema change in one migration: two new tables, eight telemetry columns, a widened CHECK constraint, and the widened `persist_summary`.

### Changes Required:

#### 1. Retrospective spend estimate (analysis artifact, no code)

**File**: `context/changes/persist-time-and-cost/docs/retrospective-spend.md`

**Intent**: Estimate what Supadata has already been spent, from data the DB already holds, before a single column is written. Establishes whether the derived formula is even plausible and gives Phase 5 something to compare the first real ledger rows against.

**Contract**: Run against the **local** stack (synced via `npm run db:sync-from-prod`) and record the output plus a live `GET /v1/me` reading. Estimate per summary: `inline` → 1 credit, `job` → `2 × ceil(duration_seconds / 60)`, plus 1 metadata credit for every summary created after S-08 shipped (2026-07-26). The query is non-obvious in one respect — rows whose `duration_seconds` is null cannot be costed at all and must be counted separately rather than silently treated as zero:

```sql
select s.resolved_via,
       count(*)                                            as summaries,
       count(*) filter (where v.duration_seconds is null)  as uncostable,
       sum(case when s.resolved_via = 'inline' then 1
                when s.resolved_via = 'job'
                     then 2 * ceil(v.duration_seconds / 60.0)
           end)                                            as est_transcript_credits
from public.summaries s
join public.videos v on v.id = s.video_id
group by s.resolved_via;
```

Write up the result with the caveat stated plainly: `resolved_via` is a fetch-mechanism observation, not a native-vs-Whisper claim (`src/types.ts:3`), so the `job` line is an upper bound on Whisper spend, not a measurement.

#### 2. Schema migration

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_generation_telemetry.sql`

**Intent**: Create the shared transcript cache and the Supadata call ledger, add the telemetry columns, widen `resolved_via` to admit `'stored'`, and swap `persist_summary` for a signature that can write the new columns.

**Contract**, in five parts:

*(a) `public.transcript_cache`* — `youtube_id text primary key`, `content text not null`, `lang text`, `available_langs text[]`, `requested_lang text`, `resolved_via text check (resolved_via in ('inline','job'))`, `fetched_at timestamptz not null default now()`. **No `user_id`**: the row is a cache of public third-party content shared by all users, holds no personal data, and must not vanish when one account is deleted. `enable row level security` with no policies, `revoke all ... from public, anon, authenticated`. `requested_lang` is diagnostic only — it records which `lang` the app asked for at fetch time and gates nothing.

*(b) `public.supadata_calls`* — `id uuid primary key default gen_random_uuid()`, `user_id uuid references auth.users (id) on delete set null`, `summary_id uuid references public.summaries (id) on delete set null`, `youtube_id text`, `operation text not null check (operation in ('transcript','transcript_poll','metadata'))`, `outcome text not null check (outcome in ('ok','unavailable','error'))`, `resolved_via text`, `created_at timestamptz not null default now()`. Both FKs are `set null`, not `cascade`: the operator's bill does not shrink when a user deletes their account or a summary, and erasing the link erases the personal data. Index on `(created_at)` and on `(user_id, created_at)`. Same definer-only RLS treatment as (a).

*(c) Telemetry columns on `summaries`*, each `add column if not exists`: `transcript_chars integer`, `generation_ms integer`, `transcript_ms integer`, `llm_ms integer`, `metadata_ms integer`, `cost_usd numeric`, `prompt_tokens integer`, `completion_tokens integer`. Comment `cost_usd` as OpenRouter's own reported figure, not a computed one.

*(d) Widened CHECK* — drop and re-add the constraint created inline by `20260709120000` so `resolved_via` admits `'stored'`. It is auto-named, so target `summaries_resolved_via_check` with `drop constraint if exists` before adding.

*(e) `persist_summary` swap* — drop the 15-argument function and create a 23-argument one adding `p_transcript_chars`, `p_generation_ms`, `p_transcript_ms`, `p_llm_ms`, `p_metadata_ms`, `p_cost_usd`, `p_prompt_tokens`, `p_completion_tokens`. **Everything about how the function decides is preserved verbatim** — the `for update` ledger lock, the replay guard, the status gate, the outcome tags, the settle, and the coalescing `on conflict` for the `videos` metadata columns. Only the `summaries` insert column list grows. Re-issue `revoke all` / `grant execute ... to service_role` against the **new** signature; the old signature's grants died with the function.

#### 3. Cache and ledger RPCs

**File**: same migration

**Intent**: Give the Worker service-role-only entry points for the three new operations, matching how every other definer table in this repo is reached.

**Contract**:
- `get_transcript_cache(p_youtube_id text, max_age_seconds integer) returns table (content text, lang text, available_langs text[], resolved_via text, fetched_at timestamptz)` — returns nothing when absent or older than the window.
- `save_transcript_cache(p_youtube_id text, p_content text, p_lang text, p_available_langs text[], p_requested_lang text, p_resolved_via text)` — upsert on `youtube_id`, overwriting **every** field including `fetched_at = now()`. Unlike `persist_summary`'s video upsert this must NOT coalesce: a refresh past the window is exactly the case where the new value must win.
- `record_supadata_calls(p_calls jsonb)` — inserts a batch in one statement, so a whole generation's ledger rows cost one round trip.

All three `security definer`, `set search_path = ''`, `revoke all` then `grant execute` to `service_role` only.

#### 4. Type declarations

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

- The retrospective estimate document exists, reports a per-`resolved_via` breakdown including the uncostable count, and states the `resolved_via` caveat
- The estimate is compared against a live `GET /v1/me` reading, and any gap is explained rather than ignored
- `summaries` accepts `resolved_via = 'stored'` and still rejects an unknown value

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

**Intent**: Read and write the shared transcript cache through the service-role RPCs, with the 30-day reuse window expressed as a named constant.

**Contract**: Export `TRANSCRIPT_CACHE_MAX_AGE_SECONDS = 2_592_000` (30 days) and two functions taking the admin client: `getCachedTranscript(admin, youtubeId)` returning `{ content, lang, availableLangs, resolvedVia, fetchedAt } | null`, and `saveCachedTranscript(admin, {...})` returning void. Both **best-effort and never throwing**, mirroring `transcript-guard.ts`: a cache miss on error just means a paid fetch, and a failed write must not fail a generation. Narrow the RPC result at the boundary rather than destructuring `any`, as the existing guards do.

#### 2. Supadata call meter and ledger writer

**File**: `src/lib/services/supadata-ledger.ts` (new)

**Intent**: Collect one record per real Supadata HTTP call during a request, then write them all in one round trip at the end — including on requests that never persist a summary.

**Contract**: `createSupadataMeter()` returns an object with `record({ operation, outcome, youtubeId, resolvedVia })`, `attachSummary(summaryId)` (stamps every collected row, called once after a successful persist), and `drain()`. Recording is a plain in-memory push and **cannot throw** — it runs inside the catch blocks that make the calling services total, so a throwing meter would defeat the totality guarantee those services provide. `flushSupadataCalls(admin, userId, meter)` posts the batch via `record_supadata_calls` and never throws; a lost ledger row is a lost measurement, not a failed generation.

#### 3. Meter the transcript calls

**File**: `src/lib/services/transcript.ts`

**Intent**: Record every HTTP call this module makes, distinguishing the billable transcript request from the free job polls.

**Contract**: `fetchTranscript` accepts an optional meter. Record one `operation: 'transcript'` per invocation with the observed outcome (`ok` / `unavailable` / `error`) and the `resolvedVia` when known; record one `operation: 'transcript_poll'` per `getJobStatus` call. **Polls are free** (`docs/supadata-transcript.md:80`) and must be a distinct operation so query-time derivation never prices them. A `transcript-unavailable` result is `outcome: 'unavailable'` and is **still billable** (`:81`) — that row is the single most valuable thing this ledger captures.

#### 4. Meter the metadata calls

**File**: `src/lib/services/metadata.ts`

**Intent**: Record each metadata attempt separately, so the retry path shows up as the second real credit it is.

**Contract**: `fetchVideoMetadata` accepts the same optional meter and records one `operation: 'metadata'` row **per `requestMetadata` call** — the retry at `:149` is a second billable request that a per-generation assumption of "1 metadata call" would miss. Recording happens inside the existing structure without weakening the function's totality contract.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build and type-check pass: `npm run build`
- The meter parameter is optional everywhere, so existing call sites compile unchanged

#### Manual Verification:

- A local generation with the transcript service exercised produces the expected in-memory record set (verified by log): one `transcript` row, N `transcript_poll` rows on the job path, one `metadata` row (two if the retry fired)
- `record_supadata_calls` inserts a hand-built batch correctly against the local DB, including null `user_id` and null `summary_id`

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

**Intent**: Reuse a transcript fetched within 30 days — by any user — instead of paying for it again.

**Contract**: After the `allowLong` quote-cache branch and **before** `recordTranscriptAttempt`, look up `getCachedTranscript`. On a hit, take `content`, `lang`, `availableLangs` from it, set `resolvedVia = 'stored'`, and skip both the rate-limit call and the fetch — the request makes no paid call, so it must consume no rate-limit token. On a miss, the existing fetch path runs unchanged and `saveCachedTranscript` is called immediately after a successful fetch, **before** the long-video 409 return at `:318`, so an abandoned confirmation still leaves the paid transcript cached.

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
- A forced 422 (a video with no transcript) writes a `transcript` / `unavailable` ledger row with null `summary_id`
- A cache row exists after the first generation and its `fetched_at` / `requested_lang` are correct

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

**Intent**: Prove the numbers are real against production, at a budgeted cost of roughly 2–3 Supadata credits.

**Contract**: Read `GET /v1/me` before and after. Generate one short video, then generate it again under the other character. Expected: run 1 writes `transcript` + `metadata` ledger rows and non-null cost/tokens/timings; run 2 writes `resolved_via = 'stored'`, no `transcript` row, and a `metadata` row (metadata is still fetched — only the transcript is cached). The `usedCredits` delta must equal the billable ledger rows. Record the outcome, then compare against Phase 1's retrospective estimate and state whether `resolved_via = 'job'` looks like a usable Whisper proxy.

#### 3. Tracker sync

**File**: `context/foundation/roadmap.md`

**Intent**: Keep the roadmap and Linear consistent with reality, per this project's recorded lessons.

**Contract**: Update S-07's Status, the At a glance row and the Backlog Handoff row in one edit, noting the change-id is `persist-time-and-cost` (the roadmap originally said `summary-generation-telemetry`), and record what S-09 can now decide from measured data. Move the matching Linear issue and comment on it.

### Success Criteria:

#### Automated Verification:

- `npx supabase migration list --linked` shows local and remote in sync
- `wrangler deploy` reports a new version and the deployed Worker serves a generation without a 500

#### Manual Verification:

- Two live generations behave exactly as specified above, and the `usedCredits` delta matches the billable ledger rows
- Telemetry on the live rows is plausible: `llm_ms` dominates on a short native video, `cost_usd` is in the ~1–2 ¢ range observed for this model
- The retrospective estimate is reconciled against measured data and the `resolved_via`-as-Whisper-proxy question is answered
- Roadmap and Linear both reflect the landed state

---

## Testing Strategy

There is no automated test suite in this project (Module-3 deferral), so verification is the type-checker, the migration runner, the linter, and structured manual passes.

### Manual Testing Steps:

1. Fresh `npx supabase migration up` on an empty DB — every migration applies in order.
2. Local generation of a short video: inspect the `summaries` row for eight populated telemetry columns, `supadata_calls` for one `transcript` + one `metadata` row, `transcript_cache` for one row.
3. Repeat with the other character: expect `'stored'`, no new `transcript` row, a new `metadata` row.
4. A video with no transcript: expect 422, a `transcript`/`unavailable` ledger row with null `summary_id`, and no summary.
5. A long video (>40k chars) up to the 409, then abandon: expect a cached transcript despite no summary, and ledger rows recorded.
6. Live pass per Phase 5, budgeted at 2–3 credits.

**Deliberately not verified live** (cost): the Whisper `job` path at 2 credits/minute, and the metadata retry. Both are exercised locally by reasoning and DB inspection; state this limitation in the verification record rather than implying full coverage.

## Performance Considerations

The cache read adds one DB round trip before a fetch that costs money and seconds — a favourable trade whenever it hits, and negligible when it misses. The ledger costs exactly one round trip per request regardless of how many calls were made, because rows are batched. Usage accounting adds no latency; the figures ride the response already being parsed. Cache growth is unbounded by design (one row per video, up to 200k chars) — accepted at MVP scale and worth revisiting only if the video count grows by orders of magnitude.

## Migration Notes

The migration is additive except for the `persist_summary` swap and the `resolved_via` CHECK replacement. No backfill: existing summaries keep null telemetry, and the retrospective estimate covers them instead. `transcript_cache` starts empty, so the first generation after rollout always pays — the cache earns from the second one onward.

## References

- Roadmap slice: `context/foundation/roadmap.md` §S-07 (F4, F5, T3, T4)
- Origin findings: `context/changes/transcript-llm-probe/reviews/impl-review-phase-4.md:57-75`
- Supadata pricing and limits: `context/changes/persist-video-metadata/docs/supadata-transcript.md` §Pricing, `supadata-account-limits.md`
- RPC-swap precedent and its accepted window: `supabase/migrations/20260725120000_video_metadata.sql:11-22`
- Definer-only table pattern: `supabase/migrations/20260722130000_transcript_spend_guards.sql:24-27`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Retrospective baseline + schema

#### Automated

- [ ] 1.1 Migration applies cleanly on a fresh local DB (`npx supabase migration up`)
- [ ] 1.2 Linting passes (`npm run lint`)
- [ ] 1.3 Build passes (`npm run build`)
- [ ] 1.4 Exactly one `persist_summary` exists in `pg_proc`
- [ ] 1.5 `persist_summary` is service_role-only (authenticated execute privilege is false)
- [ ] 1.6 Both new tables have RLS enabled and zero policies

#### Manual

- [ ] 1.7 Retrospective estimate document exists with per-`resolved_via` breakdown and uncostable count
- [ ] 1.8 Estimate compared against a live `GET /v1/me` reading, gap explained
- [ ] 1.9 `summaries` accepts `resolved_via = 'stored'` and rejects unknown values

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

#### Manual

- [ ] 3.4 Local generation produces the expected record set (transcript / polls / metadata)
- [ ] 3.5 `record_supadata_calls` inserts a hand-built batch including null `user_id` and `summary_id`

### Phase 4: Endpoint wiring

#### Automated

- [ ] 4.1 Linting passes (`npm run lint`)
- [ ] 4.2 Build and type-check pass (`npm run build`)
- [ ] 4.3 `npx supabase migration up` still applies cleanly from scratch

#### Manual

- [ ] 4.4 Local generation persists all eight telemetry columns, plausibly valued
- [ ] 4.5 Second generation of the same video returns `'stored'`, near-zero `transcript_ms`, no `transcript` ledger row
- [ ] 4.6 A forced 422 writes a `transcript`/`unavailable` ledger row with null `summary_id`
- [ ] 4.7 Cache row exists with correct `fetched_at` and `requested_lang`

### Phase 5: Rollout and live verification

#### Automated

- [ ] 5.1 `npx supabase migration list --linked` shows local and remote in sync
- [ ] 5.2 `wrangler deploy` reports a new version and a live generation returns without a 500

#### Manual

- [ ] 5.3 Two live generations behave as specified; `usedCredits` delta matches billable ledger rows
- [ ] 5.4 Live telemetry values are plausible (`llm_ms` dominates, `cost_usd` ~1–2 ¢)
- [ ] 5.5 Retrospective estimate reconciled; `resolved_via`-as-Whisper-proxy question answered
- [ ] 5.6 Roadmap (status, At a glance, Backlog Handoff) and Linear both updated
