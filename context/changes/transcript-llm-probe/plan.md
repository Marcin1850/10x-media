# Transcript → LLM Probe (F-02) Implementation Plan

## Overview

Verify — on the **deployed** Cloudflare Worker, not just local dev — that the core product path works end-to-end: a YouTube URL becomes a Polish-language summary via a managed transcript API plus a frontier LLM, and lands in the database. This is the roadmap's top-risk de-risk spike (`F-02`); it unblocks `S-01` (the north-star slice). It is deliberately thin: a single auth-protected `POST` endpoint delegating to services, exercised over `wrangler tail` against `10x-media.nightshiftlab.workers.dev`.

The probe also produces the **reusable seam** `S-01` keeps: a transcript service, an LLM service isolated behind `getSummaryModel()`, and a persistence service — so when `S-01` builds the real UI, the risky machinery is already proven on workerd.

## Current State Analysis

- **Runtime is already provisioned** for the target libraries. Astro 6 SSR (`output: "server"`) on `@astrojs/cloudflare` v13.5.0 ([`astro.config.mjs:11,16`](../../../astro.config.mjs)) with `compatibility_flags: ["nodejs_compat"]` and `compatibility_date: "2026-05-08"` ([`wrangler.jsonc:5-6`](../../../wrangler.jsonc)). No blocking incompatibility (see `research.md` → codebase-compatibility verdict).
- **Secrets come from `astro:env/server`**, declared in `astro.config.mjs` `env.schema`, never `process.env`/`import.meta.env` ([`src/lib/supabase.ts:3`](../../../src/lib/supabase.ts), [`src/lib/config-status.ts:1`](../../../src/lib/config-status.ts), CLAUDE.md). Only `SUPABASE_URL`/`SUPABASE_KEY` are declared today ([`astro.config.mjs:19-20`](../../../astro.config.mjs)).
- **F-01 tables exist** ([`supabase/migrations/20260613145120_videos_and_summaries.sql`](../../../supabase/migrations/20260613145120_videos_and_summaries.sql)): `videos` (with `unique (user_id, youtube_id)` and `unique (id, user_id)`) and `summaries` (`character` CHECK in `('informational','educational')`, `content`, FK `(video_id, user_id) → videos(id, user_id)`), both with per-user RLS. **`summaries` has no `model` column and no per-video/per-character unique constraint** — appending multiple summaries per video is already permitted by the schema.
- **DTOs exist** but lack `model` ([`src/types.ts:13-20`](../../../src/types.ts): `Summary`, `ChannelCharacter`).
- **API-route convention**: `export const prerender = false;` + uppercase handler ([`src/pages/api/auth/signin.ts:4`](../../../src/pages/api/auth/signin.ts)); new routes must zod-validate input (signin predates the rule). Business logic belongs in `src/lib/services/`.
- **Auth**: `context.locals.user` is resolved every request by middleware ([`src/middleware.ts:6-16`](../../../src/middleware.ts)); `PROTECTED_ROUTES` currently `["/dashboard"]` and unauthenticated hits are **redirected** (page-oriented, not a JSON 401).
- **`zod` is transitive-only** (`zod@4.4.3` in `node_modules`, not in `package.json`); AI SDK v7 supports zod v4 (its peer allows `zod ^3.25 || ^4.1`).
- **Target packages are all net-new** — clean install, no version conflicts.
- **`.env.example` is stale** ([`.env.example`](../../../.env.example): only `SUPABASE_URL`/`SUPABASE_KEY`).

## Desired End State

Hitting `POST https://10x-media.nightshiftlab.workers.dev/api/summaries/probe` with a valid session cookie and body `{ "url": "<youtube-url>", "character": "informational" | "educational" }` returns `200` with a Polish summary, and:

- A `videos` row exists for `(user_id, youtube_id)` (created once, reused on repeat).
- A **new** `summaries` row is appended on every successful call — carrying `content`, `character`, and the **actual served model slug** (from the `generateText` result's `finalStep.response.modelId`) in a new `model` column. Re-running the same video appends another row (all summaries retained for later manual comparison).
- `wrangler tail` shows the transcript API and OpenRouter both reachable from Cloudflare egress, the call succeeding, with no bundle / `nodejs_compat` errors, acceptable latency, and no CPU-limit failures on the free plan.
- The residual "transcript truly unavailable" case (Supadata `206`) returns a clear, non-500 error and writes no rows.

### Key Discoveries:

- **Direct transcript fetch from the Worker is a dead end** — YouTube blocks CF datacenter IPs. Managed API (Supadata, `mode: "auto"` Whisper fallback) is the mitigation. (`research.md` → Problem 1)
- **The single codebase-specific correction to every `docs/` snippet**: read each key from `astro:env/server` and **pass it explicitly** to the SDK constructor — `new Supadata({ apiKey })`, `createOpenRouter({ apiKey })`. Workers secrets are not mirrored onto `process.env`. (`research.md` → gotcha)
- **Do NOT import root `@anthropic-ai/sdk`** — pulls Node built-ins, breaks the Worker bundle. Not needed anyway: OpenRouter is reached via `@openrouter/ai-sdk-provider`. (`research.md` → Problem 2)
- **OpenRouter model IDs are slugs** (`anthropic/claude-sonnet-5`), not native Claude IDs; the `generateText` result's `response.modelId` returns the served slug. (`docs/openrouter.md`)
- **Both network calls are I/O-bound** → they don't count against the Workers CPU budget; the free-plan 10ms concern is largely mitigated. Confirm empirically. (`research.md` → CPU)
- **`supadata.transcript({ mode: "auto" })` genuinely returns an async job, not just a theoretical SDK type.** Videos longer than 20 minutes — and any AI-generation call that would otherwise take longer than ~60s — always come back as `{ jobId }` (HTTP 202) rather than an inline transcript. Supadata publishes no completion-time SLA for the job ("AI transcription time is correlated with video duration"); their own guidance is to poll `getJobStatus` every 1s, and status checks are free (no credits charged). (Phase 3 impl review `F1`; Supadata docs)
- **Cloudflare Workers HTTP-triggered requests have no hard wall-clock duration limit.** As long as the client stays connected, the Worker can keep making subrequests indefinitely. The actual cap on a polling loop is the **free-plan subrequest budget (50/invocation)**, not elapsed time — size poll attempts against that budget, not against a timeout. (Phase 3 impl review `F1`; Cloudflare docs)
- **AI SDK v7 deprecates `GenerateTextResult.response`** in favor of `finalStep.response` — the served model slug is `result.finalStep.response.modelId`, not `result.response.modelId` (the latter still works but is marked `@deprecated` in the shipped types). (Phase 3 impl review `F4`)

## What We're NOT Doing

- **No UI.** No trigger page, no result rendering — that is `S-01`. Verification is curl + `wrangler tail`.
- **No Cloudflare AI Gateway** in this probe (no `ai` binding in `wrangler.jsonc`). Deferred to a later change; the `getSummaryModel()` seam makes it a one-file add. (`research.md` → Open items)
- **No direct provider accounts** (Anthropic/Google/OpenAI). One OpenRouter key fronts all models — avoids the per-provider funding floor. Swap providers later without new packages/keys.
- **No summary listing, deletion, or CRUD surface** — those are `S-02`/`S-03`.
- **No changes to F-01's existing columns or RLS policies** — only an additive `model` column.
- **No streaming** — a single `generateText` call returning a Polish string is sufficient for the probe.
- **No structured (`generateObject`/zod-schema) LLM output** — plain text summary. zod is for input validation only here.

## Implementation Approach

Build bottom-up so each layer is independently verifiable, then deploy and observe on the live Worker:

1. **Plumb config + secrets + deps** (nothing else works without the keys reachable via `astro:env/server`).
2. **Additive migration** for `summaries.model` + DTO update (small, isolated, idempotent — mirrors F-01's reviewed migration style).
3. **Services** — transcript (Supadata), LLM (`getSummaryModel()` behind OpenRouter), and persistence (upsert video, append summary). The endpoint stays thin.
4. **Thin endpoint + live deploy/verify** — the actual de-risk. Secrets pushed via `wrangler secret put`, deployed, exercised against the live URL under `wrangler tail`.

## Critical Implementation Details

- **Secret access is the one universal correction.** Every `docs/` example uses `process.env.*`; on this codebase that finds nothing at runtime under the Cloudflare adapter. Import each key from `astro:env/server` and pass it explicitly into `new Supadata({ apiKey })` / `createOpenRouter({ apiKey })`. Verify on the **deployed** Worker (`wrangler tail`), not only local dev where `process.env` may behave differently.
- **Auth for an API route is a JSON 401, not a redirect.** `PROTECTED_ROUTES` in middleware redirects browsers to `/auth/signin` — correct for pages, wrong for a POST API. The endpoint must itself check `context.locals.user` and return `401` JSON. Do **not** rely solely on adding the path to `PROTECTED_ROUTES` (that yields a 302 to an HTML page for an API caller). Optionally still list it there as defense-in-depth, but the in-handler guard is authoritative.
- **Persistence is append-only for summaries, get-or-create for videos.** Insert the `videos` row with conflict handling on `(user_id, youtube_id)` to reuse an existing one; always `INSERT` the `summaries` row. Never upsert/replace a summary — retaining every generation is an explicit requirement (manual quality comparison).
- **Store the served model, not the requested one.** Persist `finalStep.response.modelId` from the `generateText` result (the slug that actually served the call — `result.response.modelId` is the same value but deprecated in AI SDK v7), so later comparison reflects reality even if `openrouter/auto`-style routing or fallback ever changes what ran.
- **Async transcript jobs need bounded, backing-off polling, not a flat retry or a hard timeout.** `supadata.transcript()` can return `{ jobId }` instead of a transcript inline; treating that shape as `{ ok: false, reason: "unavailable" }` (the naive read of the SDK's return type) silently drops the exact case the Whisper fallback exists for — see Phase 3 impl review `F1`. Poll `supadata.transcript.getJobStatus(jobId)` with exponential backoff (1s initial, ×2 factor, capped at 30s, 12 attempts ⇒ ~4 minutes of coverage at only 12 subrequests) — few subrequests, long real-time coverage — since Supadata publishes no completion-time SLA and summarization isn't a real-time interaction.

## Phase 1: Config, dependencies & secret plumbing

### Overview

Make the two API keys reachable through the project's `astro:env/server` convention and install the net-new packages, so services can be written against real config.

### Changes Required:

#### 1. Install dependencies

**File**: `package.json`

**Intent**: Add the net-new runtime packages plus an explicit `zod` (currently transitive-only) so the contract doesn't rest on a transitive dep.

**Contract**: `npm install @supadata/js@^1.4.0 ai@^7 @openrouter/ai-sdk-provider@^3 zod` — resolves `ai@7` (AI SDK v7), `@openrouter/ai-sdk-provider@3` (peers `ai@^7.0.0`), `@supadata/js@1.4.0`, and pins `zod` (v4, within AI SDK v7's `zod ^3.25 || ^4.1` peer range) as a direct dependency.

#### 2. Declare secrets in the env schema

**File**: `astro.config.mjs`

**Intent**: Add `SUPADATA_API_KEY` and `OPENROUTER_API_KEY` as server-only secrets alongside the existing Supabase fields, matching the graceful-degradation pattern.

**Contract**: Two new `env.schema` entries using the exact existing shape `envField.string({ context: "server", access: "secret", optional: true })`.

#### 3. Local dev + example secrets

**Files**: `.env`, `.dev.vars`, `.env.example`

**Intent**: Provide the keys for local dev (`.env` for Node, `.dev.vars` for `workerd` local) and update the stale committed example.

**Contract**: `.env.example` gains `SUPADATA_API_KEY=###` and `OPENROUTER_API_KEY=###` (keeping the existing placeholder style); `.env` and `.dev.vars` get real values (gitignored, not committed).

#### 4. (Optional) Surface missing keys in config status

**File**: `src/lib/config-status.ts`

**Intent**: Reuse the existing `configStatuses` idiom to report a "transcript/LLM not configured" state, mirroring the Supabase entry.

**Contract**: Import the two new keys from `astro:env/server`; append one or two `ConfigStatus` entries with `configured: Boolean(...)`. Non-blocking; can be trimmed if time-pressed.

### Success Criteria:

#### Automated Verification:

- Dependencies install cleanly: `npm install`
- Type checking passes: `npm run lint`
- Build succeeds on the Cloudflare adapter: `npm run build`

#### Manual Verification:

- `astro:env/server` exposes both new keys locally (no "not configured" surprise where a key is set).
- `.env.example` documents the two new keys.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Schema — add `model` to `summaries`

### Overview

Add the single additive column needed to record which model produced each summary, and reflect it in the DTOs. Keeps every summary distinguishable for later manual quality comparison.

### Changes Required:

#### 1. Migration: add `model` column

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_add_model_to_summaries.sql`

**Intent**: Add a nullable-safe `model` text column to `public.summaries` recording the served model slug. Additive and idempotent — no touch to existing columns, RLS, or F-01's migration.

**Contract**: `alter table public.summaries add column if not exists model text;`. No new RLS policies required (column inherits the table's existing per-user policies). No unique constraint added — multiple summaries per `(video_id, character)` remain valid by design.

#### 2. Update DTOs

**File**: `src/types.ts`

**Intent**: Add `model` to the `Summary` interface so services and future consumers see it.

**Contract**: `Summary` gains `model: string | null;`. (A `ChannelCharacter` already exists and is reused for the probe input.)

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly against local Supabase: `npx supabase db reset` (or `npx supabase migration up`)
- Type checking passes: `npm run lint`

#### Manual Verification:

- `summaries` table shows the new `model` column in local Studio (`http://localhost:54323`).
- Re-running the migration is a no-op (idempotent — `if not exists`).

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Services (transcript, LLM, persistence)

### Overview

Build the reusable, workerd-safe seam the endpoint (and later `S-01`) delegate to: fetch transcript, summarize in Polish, persist. Model selection is isolated in one function so the provider is a one-file swap.

### Changes Required:

#### 1. Transcript service

**File**: `src/lib/services/transcript.ts`

**Intent**: Fetch a plain-text transcript for a YouTube URL via Supadata, with the Whisper fallback (`mode: "auto"`), and surface the "truly unavailable" case as a typed result rather than a thrown 500.

**Contract**: Export an async function taking `{ url, lang?: "pl" }` and the API key, returning a discriminated result — e.g. `{ ok: true; content: string; lang: string }` or `{ ok: false; reason: "unavailable" }`. Internally: `new Supadata({ apiKey })` then `supadata.transcript({ url, lang: "pl", text: true, mode: "auto" })`; map Supadata's `206`/unavailable response to `{ ok: false }`. **Key is passed in explicitly** (from `astro:env/server` at the call site), never read from `process.env`.

**Revised (Phase 3 impl review `F1`)**: `supadata.transcript()` can return `{ jobId }` instead of a transcript inline (async processing — always the case for videos >20 min). When it does, poll `supadata.transcript.getJobStatus(jobId)` with exponential backoff — `1000ms` initial interval, `×2` factor, capped at `30000ms`, `12` max attempts (sequence: 1s/2s/4s/8s/16s/30s×7, ~4 minutes total coverage using 12 subrequests) — until the job's `status` is `"completed"` (map its `result.content` to `{ ok: true }`) or `"failed"`/attempts exhausted (map to `{ ok: false, reason: "unavailable" }`). Backoff, not a flat interval or hard timeout: Cloudflare Workers HTTP requests have no wall-clock duration limit, so the loop is bounded by attempt count (subrequest budget) rather than elapsed time; movie-length videos with very long Whisper jobs remain a known residual risk since Supadata publishes no completion-time SLA to size against — validate empirically in Phase 4's live `wrangler tail` run against real long-form content.

**Extended (post-review addendum)**: the `{ ok: true }` result also carries `resolvedVia: "inline" | "job"` — which branch actually produced the transcript. This names the **observed fetch mechanism only**; it is not a claim about whether Supadata served native YouTube captions or a Whisper-generated transcript. Supadata's response schema (`Transcript`/`JobResult` in its OpenAPI spec) exposes no such origin field, so `"native"`/`"generated"` would be an unverifiable inference — a fast Whisper job resolving within the sync window before ever needing a `jobId` would be indistinguishable from a native hit. `resolvedVia` is threaded through to persistence (see #3 below) to support later summary-quality comparison, with this caveat intact.

#### 2. LLM service + model selection

**File**: `src/lib/services/llm.ts`

**Intent**: Isolate model/provider choice in `getSummaryModel()` and expose a `summarize()` that turns transcript text into a Polish summary tailored to the channel character. The rest of the code never names a provider.

**Contract**:
- `getSummaryModel(apiKey)` → `createOpenRouter({ apiKey })("anthropic/claude-sonnet-5")` (slug, not native ID; confirm the exact slug on OpenRouter's models page at code time).
- `summarize({ transcript, character }, apiKey)` → calls `generateText({ model: getSummaryModel(apiKey), system, prompt })` and returns `{ text, model }` where `model` is `finalStep.response.modelId` (the **served** slug; `result.response.modelId` returns the same value but is deprecated in AI SDK v7 — Phase 3 impl review `F4`). System/prompt are in **Polish**, tailored to `informational` vs `educational` (FR-004/FR-005). No `thinking`/reasoning params; no streaming.

#### 3. Summary persistence service

**File**: `src/lib/services/summaries.ts` (or extend an existing service module)

**Intent**: Get-or-create the `videos` row, then **append** a `summaries` row carrying the served model. Never replace an existing summary.

**Contract**: A function taking the authenticated Supabase client, `user_id`, extracted `youtube_id`, `url`, `character`, `content`, and `model`. Upsert `videos` on the `(user_id, youtube_id)` unique constraint (reuse if present, returning its `id`); then `INSERT` into `summaries` with `{ user_id, video_id, character, content, model }`. Relies on the authenticated client so RLS `auth.uid() = user_id` passes. Extract `youtube_id` from the URL (small helper; reject non-YouTube URLs upstream in the endpoint's zod validation).

**Extended (post-review addendum)**: also accepts `resolvedVia: "inline" | "job" | null` and inserts it into `summaries.resolved_via` (new additive column — see Migration Notes). Recorded per summary generation, not per video, since transcripts are re-fetched fresh on every call rather than cached.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Build succeeds: `npm run build`

#### Manual Verification:

- Locally invoking `summarize()` on a sample transcript returns Polish text and a non-empty served `model` slug.
- The transcript service returns `{ ok: false, reason: "unavailable" }` (not a throw) for a video with no captions and no Whisper result.

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: API route + deploy & verify on the Worker

### Overview

Wire the thin endpoint over the services, push secrets to the live Worker, deploy, and run the actual de-risk: exercise the full path against `10x-media.nightshiftlab.workers.dev` while watching `wrangler tail`.

### Changes Required:

#### 1. Probe endpoint

**File**: `src/pages/api/summaries/probe.ts`

**Intent**: Accept `{ url, character }`, authenticate, orchestrate transcript → summary → persist, and return the summary. Thin — all logic lives in the services.

**Contract**:
- `export const prerender = false;` and `export const POST: APIRoute`.
- Read `SUPADATA_API_KEY` / `OPENROUTER_API_KEY` from `astro:env/server`; if missing, return `503` JSON.
- **Auth guard**: if `!context.locals.user`, return `401` JSON (do not redirect).
- **zod** schema validates the body: `url` (string, must be a YouTube URL), `character` ∈ `{ "informational", "educational" }`. On failure return `400` JSON with the zod message.
- Call transcript service → on `{ ok: false }` return a clear `422`/`206`-style JSON error and write nothing. On `{ ok: true }` → `summarize()` → persist (append) → return `200 { summary, model, videoId, summaryId }`.
- Use the request-scoped Supabase client (`createClient(context.request.headers, context.cookies)`) so the insert runs as the authenticated user (RLS).

#### 2. (Optional) Register the path for defense-in-depth

**File**: `src/middleware.ts`

**Intent**: Optionally add the probe path to `PROTECTED_ROUTES`. Note this only adds a browser redirect layer; the in-handler `401` remains the real guard for API callers.

**Contract**: If added, `PROTECTED_ROUTES` includes the probe path prefix. Skippable — the handler guard is sufficient.

#### 3. Push secrets & deploy

**Files**: (no repo change — operational)

**Intent**: Make the keys available as Workers Secrets and ship.

**Contract**: `npx wrangler secret put SUPADATA_API_KEY` and `npx wrangler secret put OPENROUTER_API_KEY`; then deploy (CI auto-deploys on merge to `master`, or `npx wrangler deploy` for an out-of-band probe).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Build succeeds on the Cloudflare adapter: `npm run build`
- Endpoint file exists with `export const prerender = false;` and a `POST` handler.

#### Manual Verification:

- Authenticated `POST` to the **live** `https://10x-media.nightshiftlab.workers.dev/api/summaries/probe` returns `200` with a Polish summary.
- `wrangler tail` shows: Supadata reachable from CF egress, OpenRouter call succeeds, **no** bundle / `nodejs_compat` errors, latency acceptable, **no** CPU-limit failure on the free plan.
- A `videos` row is created once and reused; **every** successful call appends a new `summaries` row carrying the served `model` slug (re-running the same video accumulates rows).
- Unauthenticated request → `401` JSON (not a redirect); invalid body → `400`; genuinely transcript-less video → clear non-500 error with no rows written.
- Verdict recorded: free Cloudflare plan is sufficient (expected), or the Railway escape hatch is needed (per `infrastructure.md`).

**Implementation Note**: This phase's manual verification **is** the F-02 deliverable — the live-Worker confirmation. Record the outcome (plan sufficiency, latency, any errors) back into `research.md`/`change.md` before archiving.

---

## Testing Strategy

### Unit Tests:

- (Optional for a probe) `youtube_id` extraction helper: valid `watch?v=`, `youtu.be/`, with query params; reject non-YouTube URLs.
- Transcript service maps Supadata `206`/unavailable to `{ ok: false }` rather than throwing.

### Integration Tests:

- Local end-to-end against `npm run dev` (workerd) with a real short video: `{ url, character }` → `200` + Polish summary + one appended summary row.
- Repeat call on the same video → second summary row, single video row.

### Manual Testing Steps:

1. `wrangler secret put` both keys; deploy.
2. Sign in; obtain the session cookie.
3. `curl` the live probe URL with the cookie and a valid `{ url, character }`; confirm `200` + Polish summary while watching `wrangler tail`.
4. Query `summaries` in Supabase — confirm the row has the served `model` slug; re-run and confirm a second row appears.
5. Try a caption-less/unavailable video → confirm clear non-500 error, no rows.
6. Try without the cookie → `401` JSON.

## Performance Considerations

Both external calls are I/O-bound, so on-Worker CPU is limited to JSON/zod parsing — expected to stay within the free-plan budget. The live `wrangler tail` run is what confirms this empirically (an explicit F-02 unknown). If it fails, `infrastructure.md` documents the Railway (`@astrojs/node`) escape hatch.

The transcript service's async-job polling path (`mode: "auto"` jobs that don't resolve inline) is bounded by **subrequest count, not CPU time or wall-clock duration** — Workers HTTP requests have no hard duration limit, but the free plan caps at 50 subrequests/invocation. The exponential-backoff poll (12 attempts) uses at most 12 of those, leaving headroom for the request's other calls (auth, initial transcript call, LLM call, 2 DB writes) plus anything added later.

## Migration Notes

Single additive, idempotent migration (`add column if not exists model text`) on `summaries`. No backfill required (existing rows get `NULL` model). No RLS change. Reversible by dropping the column if ever needed.

**Second additive migration (post-review addendum)**: `supabase/migrations/20260709120000_add_resolved_via_to_summaries.sql` adds `resolved_via text check (resolved_via in ('inline', 'job'))` to `summaries`, same idempotent `if not exists` pattern, no RLS change, no backfill (existing rows get `NULL`). Added to support later summary-quality comparison — see Phase 3 `#3` for the naming rationale.

## References

- Internal + external research: `context/changes/transcript-llm-probe/research.md`
- Per-library API docs: `context/changes/transcript-llm-probe/docs/` (Supadata, Vercel AI SDK, OpenRouter, Cloudflare AI Gateway)
- F-01 schema: `supabase/migrations/20260613145120_videos_and_summaries.sql`
- Endpoint pattern: `src/pages/api/auth/signin.ts:4`
- Secret pattern: `src/lib/supabase.ts:3`, `astro.config.mjs:17-22`
- Auth middleware: `src/middleware.ts:4,18-23`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Config, dependencies & secret plumbing

#### Automated

- [x] 1.1 Dependencies install cleanly: `npm install` — cdc3a14
- [x] 1.2 Type checking passes: `npm run lint` — cdc3a14
- [x] 1.3 Build succeeds on the Cloudflare adapter: `npm run build` — cdc3a14

#### Manual

- [x] 1.4 `astro:env/server` exposes both new keys locally — cdc3a14
- [x] 1.5 `.env.example` documents the two new keys — cdc3a14

### Phase 2: Schema — add `model` to `summaries`

#### Automated

- [x] 2.1 Migration applies cleanly against local Supabase — 16e5b6c
- [x] 2.2 Type checking passes: `npm run lint` — 16e5b6c

#### Manual

- [x] 2.3 `summaries` shows the new `model` column in local Studio — 16e5b6c
- [x] 2.4 Re-running the migration is a no-op (idempotent) — 16e5b6c

### Phase 3: Services (transcript, LLM, persistence)

#### Automated

- [x] 3.1 Type checking passes: `npm run lint` — fcc63c2
- [x] 3.2 Build succeeds: `npm run build` — fcc63c2

#### Manual

- [x] 3.3 `summarize()` returns Polish text + non-empty served `model` slug — fcc63c2
- [x] 3.4 Transcript service returns `{ ok: false, reason: "unavailable" }` (no throw) for a caption-less video — fcc63c2

### Phase 4: API route + deploy & verify on the Worker

#### Automated

- [ ] 4.1 Type checking passes: `npm run lint`
- [ ] 4.2 Build succeeds on the Cloudflare adapter: `npm run build`
- [ ] 4.3 Endpoint file exists with `export const prerender = false;` and a `POST` handler

#### Manual

- [ ] 4.4 Authenticated `POST` to the live Worker returns `200` + Polish summary
- [ ] 4.5 `wrangler tail`: Supadata + OpenRouter reachable, no bundle/`nodejs_compat` errors, latency acceptable, no free-plan CPU failure
- [ ] 4.6 `videos` created-once/reused; every call appends a `summaries` row with the served `model` slug
- [ ] 4.7 Unauthenticated → `401` JSON; invalid body → `400`; transcript-less video → clear non-500 error, no rows
- [ ] 4.8 Verdict recorded: free plan sufficient (or Railway escape hatch needed)
