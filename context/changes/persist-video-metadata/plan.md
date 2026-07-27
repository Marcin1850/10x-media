# Persist Video Metadata Implementation Plan

## Overview

Populate `videos` with the descriptive metadata a saved summary needs to be recognisable — thumbnail, title, channel, duration, upload date — plus two diagnostic columns recording which language the transcript actually came back in. Data comes from one new Supadata `/metadata` call and from the `lang` / `availableLangs` fields the existing transcript call already returns and discards. This slice is **persistence only**; rendering belongs to S-02, which S-08 gates so the list ships with metadata rather than being retrofitted.

## Current State Analysis

- **`videos.title` and `videos.thumbnail_url` exist but are permanently null.** They were created by F-01 (`20260613145120_videos_and_summaries.sql:9-10`) and nothing has ever written them. The cause is not the application code — it is the RPC: `persist_summary()` hardcodes `insert into public.videos (user_id, url, youtube_id) values (target_user, p_url, p_youtube_id)` (`20260723120000_atomic_persist_summary.sql:112-115`). Since F23 no application code touches `videos` directly, so the columns are unreachable without widening the function.
- **No columns exist for channel, duration, upload date or language.**
- **The transcript response already carries language data that is thrown away.** `Transcript` in the SDK is `{ content, lang, availableLangs }`; `TranscriptResult` (`src/lib/services/transcript.ts:4-6`) keeps `content` and `lang` but has no `availableLangs`, and the call site discards `lang` entirely (`src/pages/api/summaries/generate.ts:275-276`).
- **The app requests `lang: "pl"`** (`transcript.ts:24` default, `generate.ts:260` explicit). Per the vendor docs this is a *preference among existing caption tracks*, not a translation request — translation is a separate endpoint the app never calls. Polish output comes entirely from the prompt (`src/lib/services/llm.ts:23,52`), so `lang: "pl"` buys nothing on a foreign-language video and, if YouTube auto-translated tracks enter the pool, can actively hand the model a machine-translated transcript instead of the original.
- **The SDK already types the metadata endpoint.** `@supadata/js@^1.4.0` exposes `metadata: (params: { url: string }) => Promise<Metadata>`.
- **No test framework exists.** `package.json` has `lint`, `build`, `format` only. Automated verification is limited to migration apply, ESLint (type-checked) and the Astro build; everything behavioural is manual.
- **Supadata budget is tight.** Measured 2026-07-25 via `GET /v1/me`: plan "Free (100/mo)", `maxCredits: 100`, `usedCredits: 29` — 71 remaining. `/metadata` is a flat 1 credit, so this slice halves the native-transcript ceiling from ~100 to ~50 generations/month.

## Desired End State

After a successful generation **on the fresh-transcript path**, the `videos` row for that YouTube ID carries `title`, `thumbnail_url_reported`, `channel_name`, `duration_seconds`, `published_at`, `transcript_lang` and `transcript_available_langs` — with nulls only where Supadata genuinely had nothing or the metadata call failed.

One accepted exception: a generation resumed from a cached quote (the `allowLong` confirmation path) always leaves `transcript_lang` and `transcript_available_langs` null, because the quote cache stores no language fields and widening it is explicitly out of scope. The five descriptive columns still populate on that path. The transcript request no longer sends `lang`, so the returned track is whatever Supadata considers first-available rather than a Polish track that may be machine-translated. Nothing renders yet.

Verify with a real generation against a local Supabase stack, then:

```sql
select title, thumbnail_url_reported, channel_name, duration_seconds, published_at,
       transcript_lang, transcript_available_langs
from public.videos order by created_at desc limit 1;
```

### Key Discoveries:

- The RPC — not the insert code — is why `title`/`thumbnail_url` are dead (`20260723120000_atomic_persist_summary.sql:112-115`).
- **`thumbnail_url` has never held a value and has no readers** — only two type declarations (`src/types.ts:12`, `src/lib/services/summaries.ts:10`). That makes renaming it to `thumbnail_url_reported` free *now* and expensive after S-02 renders it.
- Widening a Postgres function's parameter list via `create or replace` produces a **second overload**, not a replacement, and PostgREST then has to disambiguate. Grants are signature-scoped too (`20260723120000_atomic_persist_summary.sql:136-139`).
- `Metadata.media` is a union (`VideoMedia | ImageMedia | CarouselMedia | PostMedia`); only `VideoMedia` has `duration` and `thumbnailUrl`. `Metadata.title` is `string | null`.
- **The long-video confirmation path has no transcript in hand.** `transcript_quotes` stores `transcript_content` + `resolved_via` only (`transcript-guard.ts:51-52`), so an `allowLong` resubmit has no `lang`/`availableLangs`. Accepted: those two columns are diagnostic, and null on that path is tolerable.
- Free-plan rate limit is 1 request/second, which is why the two Supadata calls must be ordered rather than parallelised.

## What We're NOT Doing

- **No UI.** No changes to `GenerateSummaryForm.tsx`, no list page, no change to the generate endpoint's response body. S-02 owns rendering and must supply the null fallback.
- **No backfill.** Existing `videos` rows keep null metadata. No operator script, no lazy fill.
- **No storage copy of thumbnails** — the CDN URL is hotlinked.
- **No repair of a dead thumbnail URL.** `thumbnail_url_reported` records what the vendor returned and is never rewritten to reflect whether it resolves. The `hqdefault` fallback is applied at render time by S-02 and never persisted — see §Migration Notes.
- **No `language` column meaning "the video's spoken language".** That field is only obtainable from the YouTube Data API (`snippet.defaultAudioLanguage`), which needs a new key and quota. The two columns here are named `transcript_lang` / `transcript_available_langs` precisely so they cannot be mistaken for it.
- **No cost guardrail.** `mode: "auto"` stays, `HARD_MAX_TRANSCRIPT_CHARS` stays, `summaryCost` stays. That is S-09.
- **No widening of `save_transcript_quote`** to carry language through the confirmation path.
- **No use of the deprecated `GET /v1/youtube/video`** endpoint.
- **No unused metadata fields** — `description`, `stats`, `tags`, `author.avatarUrl`, `additionalData.channelId` are available but out of scope.

## Implementation Approach

Three code phases, each independently verifiable, then a production rollout. The ordering isolates the riskiest element — swapping the `persist_summary` signature — from the behavioural change on the paid transcript path, so a failure in either is unambiguous about which change caused it.

Phase 1 lands the schema and the widened RPC while passing nulls for every new field, proving the swap in isolation. Phase 2 turns on the language signals, which cost nothing extra. Phase 3 adds the paid metadata call. Phase 4 ships.

## Critical Implementation Details

**The RPC swap has a deployment window.** `drop function` + `create function` in one migration means that between `supabase db push` and `wrangler deploy` the live Worker calls a function that no longer exists. The failure is survivable — `persistSummaryAndSettle` throws, the caller refunds the reservation and returns 500 (`generate.ts:379-384`), so no user is charged — but the OpenRouter spend for that generation is lost. Run the two commands back to back; do not push the migration and defer the deploy.

**The upsert must not overwrite good metadata with nulls.** `persist_summary` gets-or-creates the video, and a second generation of the same video (the other `character`) re-runs the same upsert. If that run's metadata fetch failed, a plain `set title = excluded.title` would erase metadata captured on the first run. Coalesce each new column, keeping `url` as the one unconditional overwrite it already is:

```sql
on conflict (user_id, youtube_id) do update set
  url = excluded.url,
  title = coalesce(excluded.title, videos.title),
  thumbnail_url_reported =
    coalesce(excluded.thumbnail_url_reported, videos.thumbnail_url_reported),
  -- …same shape for channel_name, duration_seconds, published_at,
  --    transcript_lang, transcript_available_langs
```

Note the unqualified `videos.` prefix: inside `ON CONFLICT DO UPDATE` the insert target is aliased by its bare table name even though the function runs under `set search_path = ''`.

**A malformed vendor value must not kill a paid generation.** `published_at` is `timestamptz` and `duration_seconds` is `integer`; a bad `createdAt` string or a non-finite `duration` from Supadata would abort the persist transaction, triggering a refund and discarding a summary that was already paid for. The metadata service must normalise before returning: parse `createdAt` and re-emit ISO, or null; round `duration` only when finite, else null. Never pass a raw vendor value into a typed column.

**Retry only what is transient.** One retry, only for a network-level failure or `limit-exceeded` (the 1 req/s breach). `not-found`, `invalid-request`, `transcript-unavailable`, `internal-error`, `upgrade-required` and `unauthorized` are permanent — retrying them just appends latency to an already-completed generation. Space the retry past the rate-limit window (~1.2 s). The SDK's error union is exactly `invalid-request | internal-error | transcript-unavailable | not-found | unauthorized | upgrade-required | limit-exceeded` (`node_modules/@supadata/js/dist/index.d.ts:41-50`) — there is no `forbidden` code, so do not branch on one.

**Totality is load-bearing, so the boundary must be outer, not typed.** The metadata call sits after the debit and the paid LLM call but *before* the persistence `try`/`catch` (`generate.ts:347-384`). Anything that escapes `fetchVideoMetadata()` therefore bypasses the immediate refund and leaves the reservation for later reconciliation. The catch must wrap the **entire** retry operation, not each typed branch: `SupadataError` is only what the SDK throws when it recognises the response — a DNS failure, a socket reset or a Workers subrequest cap surfaces as a raw rejection with no `error` field. Classify inside the catch (retry on `limit-exceeded` or a recognised transport rejection, return null on everything else including anything unrecognised), and never let the classifier itself throw on an unexpected shape.

**Subrequest budget.** Cloudflare's free plan allows 50 subrequests per invocation; the transcript poll alone can use 13 (`transcript.ts:17`). Adding at most 2 more is comfortable, but the metadata call must stay outside any loop.

---

## Phase 1: Schema and widened persist path

### Overview

Add the five new columns, replace `persist_summary` with a signature that accepts all seven metadata fields, and thread those fields through `persistSummaryAndSettle` — passing nulls for now. The application behaves exactly as before; the columns exist and stay empty.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/20260725120000_video_metadata.sql`

**Intent**: Add the metadata columns to `videos`, rename `thumbnail_url` to say what it actually holds, and replace `persist_summary` so it can write them all. Additive on the table (matching the `model` / `resolved_via` precedent); a hard swap on the function, because a differing parameter list would otherwise create a second overload.

**Contract**: Five idempotent `alter table public.videos add column if not exists` statements — `channel_name text`, `duration_seconds integer`, `published_at timestamptz`, `transcript_lang text`, `transcript_available_langs text[]`. RLS untouched: the existing per-user `videos` policies cover new columns, and `user_id`'s `on delete cascade` already covers S-04 erasure.

Then one `alter table public.videos rename column thumbnail_url to thumbnail_url_reported;`. The name states provenance rather than quality: the column records what the vendor last returned, and nothing in this system ever repairs it against whether the URL actually resolves. This is a breaking rename accepted deliberately: the column has been null in every row since F-01 created it, and its only references are two type declarations (`src/types.ts:12`, `src/lib/services/summaries.ts:10`) — nothing reads it, nothing renders it. This slice is the last moment the rename is free. Note that `rename column` has no `if not exists` form, so unlike the additions this statement is **not** idempotent; it is correct exactly once against a database that still has the old name.

Document the column's rationale in the schema itself, so a future reader does not mistake a derivable value for a redundant one:

```sql
comment on column public.videos.thumbnail_url_reported is
  'Thumbnail URL exactly as last reported by Supadata — a record of the vendor '
  'response, never curated or repaired. Derivable from youtube_id, but persisted '
  'because it arrives free in a metadata call already made and typically carries '
  'a higher resolution than a fixed guess. NOT guaranteed to resolve: the vendor '
  'returns maxresdefault.jpg, which is absent below 480p. Consumers fall back at '
  'render time to https://i.ytimg.com/vi/<youtube_id>/hqdefault.jpg and must not '
  'write that fallback back into this column.';
```

Then `drop function if exists public.persist_summary(uuid, uuid, text, text, text, text, text, text);` followed by a `create function` whose parameters are the existing eight plus `p_title text`, `p_thumbnail_url_reported text`, `p_channel_name text`, `p_duration_seconds integer`, `p_published_at timestamptz`, `p_transcript_lang text`, `p_transcript_available_langs text[]`. The body is unchanged except for the `videos` upsert, which gains the new columns with the coalescing conflict clause from §Critical Implementation Details. Return type, outcome tags (`persisted` / `already_persisted` / `not_reserved`), the `for update` ledger lock, the replay guard and the settle are all preserved verbatim — this migration changes what the function writes, not how it decides.

Close with `revoke all … from public, anon, authenticated` and `grant execute … to service_role` naming the **new** signature in full. The old signature's grants disappear with the dropped function.

**Header comment** must state why this is a drop rather than an expand/contract pair, and that `db push` and `wrangler deploy` are a single operation.

#### 2. Persist service

**File**: `src/lib/services/summaries.ts`

**Intent**: Teach the typed RPC surface and the wrapper about the seven new parameters so callers can supply metadata.

**Contract**: `AppDatabase["public"]["Functions"]["persist_summary"]["Args"]` gains the seven new keys with their TS types (`string | null`, `number | null`, `string[] | null`), including `p_thumbnail_url_reported`. `PersistSummaryParams` gains a single optional grouping — `metadata` for the five video-descriptive fields and `transcriptLang` / `transcriptAvailableLangs` for the two diagnostic ones — and `persistSummaryAndSettle` forwards them to the `rpc()` call, defaulting to null when absent. `VideoRow` in the same file gains the five new columns **and** renames its `thumbnail_url` key to `thumbnail_url_reported` (line 10), tracking the migration.

#### 3. Shared types

**File**: `src/types.ts`

**Intent**: Keep the exported `Video` entity in sync with the table so S-02 can consume it.

**Contract**: `Video` gains `channel_name: string | null`, `duration_seconds: number | null`, `published_at: string | null`, `transcript_lang: string | null`, `transcript_available_langs: string[] | null`, and renames `thumbnail_url` to `thumbnail_url_reported: string | null` (line 12). Type-checked ESLint is what proves both renames are complete — there are no other consumers today, so a missed rename surfaces at build time rather than at runtime.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly against a fresh local stack: `npx supabase migration up`
- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- One real generation on the local stack still succeeds end-to-end and returns a summary
- `select * from public.videos order by created_at desc limit 1` shows the five new columns present and null, and `thumbnail_url_reported` in place of `thumbnail_url`; `\d+ public.videos` shows the rationale comment attached to the renamed column
- `select proname, pronargs from pg_proc where proname = 'persist_summary'` returns exactly one row
- `credit_reservations` shows the run's reservation as `settled`, confirming the swapped function still closes the ledger

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Transcript language signals

### Overview

Stop asking Supadata for a Polish caption track, start recording which track it actually returned, and warn when the available-language pool is large enough to imply auto-translation. Costs nothing extra — the data is already in the response being parsed.

### Changes Required:

#### 1. Transcript service

**File**: `src/lib/services/transcript.ts`

**Intent**: Remove the `lang` preference, surface `availableLangs`, and log when the returned pool looks like it contains YouTube auto-translations.

**Contract**: `fetchTranscript`'s parameter object drops `lang` entirely (not merely defaulted away — there is one caller, and an unset optional invites reintroduction), and the SDK call becomes `supadata.transcript({ url, text: true, mode: "auto" })`. `mode` is unchanged; the cost guardrail is S-09.

The `ok: true` branch of `TranscriptResult` gains `availableLangs: string[]`, populated on both the inline path and the job path (`JobResult<Transcript>.result` carries the same field).

Add a module-level threshold constant with a comment recording the reasoning: a native caption set is typically 1–3 tracks while a YouTube auto-translation pool exposes 100+, so a value around 15 separates them without firing on channels that publish a handful of human translations. When `availableLangs.length` exceeds it, `console.warn` once with the video URL, the returned `lang` and the pool size. This is the observational half of the open vendor question — whether auto-translated tracks enter the pool at all — and the threshold is explicitly a first guess to be revisited once real rows exist.

#### 2. Generation endpoint

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Stop discarding the language fields and carry them to the persist call.

**Contract**: Remove `lang: "pl"` from the `fetchTranscript` call (line 260). Alongside the existing `content` / `resolvedVia` locals, capture `transcriptLang: string | null` and `transcriptAvailableLangs: string[] | null`, set from the transcript result on the fetch path and left null on the `cachedQuote` path — the quote cache carries neither. Pass both into `persistSummaryAndSettle`. Add a brief comment at the cached-quote branch noting that the nulls are known and accepted, so a future reader does not read it as an oversight.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- A generation on a non-Polish video populates `transcript_lang` with that video's language rather than `pl`
- `transcript_available_langs` is populated as a Postgres array and readable via `select transcript_available_langs[1]`
- The summary itself is still returned in Polish, confirming the prompt — not the `lang` parameter — is what controls output language
- On a video with a large translation pool the warning appears in the dev server console with URL, lang and pool size

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Supadata metadata fetch

### Overview

Add the second Supadata call and populate the five remaining descriptive fields. Best-effort: any failure logs and persists nulls rather than discarding a summary that has already been paid for.

### Changes Required:

#### 1. Metadata service

**File**: `src/lib/services/metadata.ts` (new)

**Intent**: Wrap `supadata.metadata()` in a total function that either returns normalised, column-safe values or null, and never throws.

**Contract**: Export `VideoMetadata` — `{ title: string | null; thumbnailUrl: string | null; channelName: string | null; durationSeconds: number | null; publishedAt: string | null }` — and `fetchVideoMetadata({ url }: { url: string }, apiKey: string): Promise<VideoMetadata | null>`.

Field mapping: `title` → `title`, `media.thumbnailUrl` → `thumbnailUrl`, `author.displayName` → `channelName`, `media.duration` → `durationSeconds`, `createdAt` → `publishedAt`. The DTO field stays vendor-shaped as `thumbnailUrl`; it is the persist layer that maps it onto the `thumbnail_url_reported` column. `media` is a union, so `duration` and `thumbnailUrl` are reachable only behind a `media.type === "video"` narrow; a non-video response yields nulls for those two while the others still populate.

Normalisation is mandatory before returning, per §Critical Implementation Details — `publishedAt` is re-emitted as ISO only if parseable, `durationSeconds` only if finite, otherwise null.

Retry policy: one retry after ~1.2 s, and only when the failure is a network error or `SupadataError` with `error === "limit-exceeded"`. Every other `SupadataError` code returns null immediately. Per §Critical Implementation Details the `try`/`catch` wraps the whole retry operation — including the second attempt and the classifier — so a raw transport rejection (no `error` field) is caught and mapped to null exactly like a structured one. Failures go to `console.error` with the URL.

#### 2. Generation endpoint

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Fetch metadata once the paid work has succeeded and hand it to the persist call.

**Contract**: Between the `summarize()` block (ends line 358) and the `persistSummaryAndSettle` call, invoke `fetchVideoMetadata({ url }, supadataKey)` and pass the result — possibly null — into the persist params. Wrap the call in a defensive `try`/`catch` that falls back to `null` even though the service is meant to be total: this is a decorative call sitting between the paid work and the persistence `try`/`catch`, so a regression that makes it throw would strand a reservation rather than lose a thumbnail. The redundancy is deliberate and the comment should say so.

Placement is load-bearing for three separate reasons, and the comment at the call site should say so: it keeps the two Supadata requests seconds apart on a 1 req/s plan; it means the 402/413/409 exit paths never spend a credit on a generation that does not happen; and it keeps the `allowLong` resubmit from paying for metadata twice. Do not move it earlier without revisiting all three — that relocation is S-09 lever B's job.

The endpoint's response body is unchanged.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- A generation populates all seven fields; `duration_seconds` matches the real video length and `published_at` matches its upload date
- The thumbnail URL loads in a browser — checked on **two** videos: a modern HD upload and the old low-resolution one from §Edge cases. Supadata's documented shape is `maxresdefault.jpg`, which does not exist below 480p (probed 2026-07-25: `jNQXAC9IVRw` returns 404 for both `maxresdefault` and `sddefault`, 200 for `hqdefault`). A 404 on the low-res video is recorded, not fixed here
- With `SUPADATA_API_KEY` temporarily pointed at an invalid key *after* the transcript is served from a cached quote, the generation still succeeds and persists nulls for the five metadata fields — proving the call is non-fatal
- A *transport-level* rejection (not a `SupadataError`) is equally non-fatal: point the SDK's `baseUrl` at an unroutable host, or temporarily `throw new TypeError("fetch failed")` at the top of the metadata call, and confirm the generation still returns a summary, persists null metadata, and leaves `credit_reservations` `settled` rather than `reserved`
- A second generation of the same video with the other `character` does not null out metadata captured by the first run
- Supadata `GET /v1/me` shows `usedCredits` rising by exactly 2 for one native-transcript generation

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Production rollout

### Overview

Apply the migration and deploy the Worker as a single operation, then confirm on production.

### Changes Required:

#### 1. Deploy

**File**: — (operational)

**Intent**: Close the window in which the live Worker calls a `persist_summary` signature that no longer exists.

**Contract**: `npx supabase db push` immediately followed by `npx wrangler deploy`, run back to back with no gap and no intervening review. No new Worker secrets are required — `SUPADATA_API_KEY` is already set and is the same key the metadata endpoint uses.

#### 2. Roadmap and tracker sync

**File**: `context/foundation/roadmap.md`, `context/changes/persist-video-metadata/change.md`

**Intent**: Keep the three status surfaces and the Linear issue consistent with reality, per `context/foundation/lessons.md`.

**Contract**: Flip S-08's status in the At a glance table, the slice's own `- **Status:**` line and the Backlog Handoff row, re-deriving S-02's readiness now that its hard prerequisite is met. Set `change.md` `status` and `updated`. Move the Linear issue and comment on it.

### Success Criteria:

#### Automated Verification:

- `npx supabase db push` reports the migration applied
- `npx wrangler deploy` completes without error

#### Manual Verification:

- One generation on the deployed app succeeds and its production `videos` row carries the full field set
- No 500s in the Worker logs for the deploy window
- Production `credit_reservations` shows the run `settled`, not `reserved`
- `GET /v1/me` confirms the expected credit delta and that remaining budget is understood post-halving

---

## Testing Strategy

There is no test framework in this repository, so the strategy is migration-level assertions plus a small number of deliberately chosen real runs.

### Automated:

- `npx supabase migration up` on a fresh local stack proves the migration is self-consistent and idempotent
- `npm run lint` (type-checked ESLint) is the only static guarantee that the widened RPC argument types line up with the call sites
- `npm run build` proves the Astro/Cloudflare bundle still compiles

### Manual Testing Steps:

1. Reset the local stack and apply migrations; confirm exactly one `persist_summary` exists in `pg_proc`
2. Generate a summary for a short Polish video; assert every field
3. Generate for a short non-Polish video; assert `transcript_lang` is that language, not `pl`, and the summary is still Polish
4. Generate again for the same video with the other `character`; assert metadata survives
5. Force a metadata failure (invalid key, transcript served from cache); assert the summary still saves with null metadata
6. Check `GET /v1/me` before and after to confirm the per-generation credit cost

### Edge cases worth one deliberate run each:

- A YouTube Short — confirms `media.type === "video"` still holds and `duration_seconds` is small but present
- An old low-resolution video (e.g. `jNQXAC9IVRw`, a 2005 240p upload) — records whether Supadata hands back a `maxresdefault.jpg` that 404s or picks an existing variant itself. Open the persisted URL directly; a 404 here is the expected-and-tolerated outcome that S-02 must fall back from, not a Phase 3 failure
- A video with a large translation pool — exercises the Phase 2 warning
- The `allowLong` confirmation path — confirms the two language columns are null there and that this is the accepted behaviour, not a crash

## Performance Considerations

The metadata call adds one round trip *after* the LLM call, which is by far the dominant cost in the request (the F-02 probe measured 33 s inline and 254 s on the job path). One extra HTTP call, plus at most one retry, is noise against that. Subrequest usage rises by at most 2 against a 50-per-invocation budget already peaking near 20.

The real cost is monetary, not latency: `/metadata` is a flat 1 credit, doubling the Supadata cost of a native-transcript generation and taking the monthly ceiling from ~100 to ~50 on the current Free plan.

## Migration Notes

- The `videos` column additions are `if not exists` and safe to re-run. The `thumbnail_url` → `thumbnail_url_reported` rename is **not** re-runnable — `alter table ... rename column` has no `if not exists` form and fails on a second application. Accepted because migrations are applied once and the column is empty everywhere.
- The rename is a **breaking schema change**, taken deliberately while it is free: the column has held null in every row since F-01 and has no readers beyond two type declarations. Anything written against `videos.thumbnail_url` after this migration — S-02's renderer above all — must use the new name.
- The `persist_summary` swap is **not** expand/contract and has a deployment-order dependency — see §Critical Implementation Details. It is the one step in this plan that cannot be applied ahead of the Worker.
- Rollback: re-applying `20260723120000_atomic_persist_summary.sql` restores the eight-parameter function; the added columns can be left in place, since nothing reads them until S-02. The rename must be reversed with it (`alter table public.videos rename column thumbnail_url_reported to thumbnail_url;`), because the restored eight-argument body inserts into `videos` by the old column name.
- Existing rows are not backfilled. S-02 must render a null-metadata fallback regardless, because a failed metadata fetch produces the same shape on new rows.
- **The fallback is render-time only — S-02 must not write it back.** `thumbnail_url_reported` is a record of the vendor response; the only writer is the persist path after a successful `/metadata` call, where `coalesce` lets a fresh non-null value replace the stored one. Repairing a dead URL in the database is explicitly rejected: the 404 is detected in the browser (`<img onerror>`), so a write-back would need a new authenticated endpoint and an `update` RLS policy on `videos` that do not exist, and it would persist a value (`hqdefault.jpg`) already derivable for free from `youtube_id` on every row.
- **S-02's thumbnail fallback must cover two cases, not one: a null `thumbnail_url_reported` *and* a stored URL that 404s.** Supadata returns `maxresdefault.jpg`, which does not exist for videos never uploaded above 480p. In both cases the fallback is the derived `https://i.ytimg.com/vi/<youtube_id>/hqdefault.jpg` — `hqdefault` exists for every video (verified 2026-07-25 against a 2005 240p upload), needs no key, referrer or CORS, and `youtube_id` is on every `videos` row including the un-backfilled ones. Use `<img onerror>` or equivalent; this slice stores the vendor string unvalidated by design, so nothing upstream guarantees it resolves.

## References

- Change identity: `context/changes/persist-video-metadata/change.md`
- API reference: `context/changes/persist-video-metadata/docs/` — `supadata-metadata.md` (response schema, field mapping, pricing), `supadata-transcript.md` (`lang` semantics, `mode`, error enum), `supadata-account-limits.md` (plan envelope, rate limits)
- Roadmap slice: `context/foundation/roadmap.md` §S-08, and §S-09 for the coupling
- The function being replaced: `supabase/migrations/20260723120000_atomic_persist_summary.sql:45-139`
- Additive-column precedent: `supabase/migrations/20260709120000_add_resolved_via_to_summaries.sql`
- Function-drop precedent: `supabase/migrations/20260724120000_drop_legacy_rpcs.sql`

## Manual Verification Findings (2026-07-26)

Two things the manual suite established that the plan had assumed differently. Both are recorded here because the plan is the input to S-02.

### Edge-case correction — Supadata does not always hand back `maxresdefault`

§Manual Verification 3.4 and §Migration Notes both assume Supadata returns `maxresdefault.jpg` and that it 404s for videos never uploaded above 480p. Probed 2026-07-26 on `jNQXAC9IVRw` (2005, 240p), the vendor returned `https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=…&rs=…`, which **loads** (HTTP 200, `image/webp`, 15.8 KB). Bare `maxresdefault.jpg` for that video 404s and bare `hqdefault.jpg` 200s — so the vendor picked an existing variant itself rather than emitting a dead URL. The modern HD upload `dQw4w9WgXcQ` did return `vi_webp/…/maxresdefault.webp` (HTTP 200).

**What this changes**: nothing about the requirement, something about the rationale. S-02 still needs the derived-`hqdefault` fallback, because `thumbnail_url_reported` is null on every pre-S-08 row and on every failed metadata fetch — that is the dominant case, and it is unaffected. But the second case the plan insisted on, "a stored URL that 404s", did not reproduce. Keep the `<img onerror>` branch (one probe is not a guarantee, and the column stores the vendor string unvalidated by design), but treat that branch as defensive rather than expected.

### The open vendor question has an answer: the returned track is often not the original

`mode: "auto"` does not reliably return the video's original-language caption track.

| Video | Spoken language | Pool size | Returned |
|---|---|---|---|
| `jNQXAC9IVRw` | English | 2 | **`de`** |
| `iG9CE55wbtY` | English | 61 | **`af`** (first in pool) |
| `dQw4w9WgXcQ` | English | 5 | `en` |

Two of three runs summarised a **translated** track rather than the source — and it shows: the "Me at the zoo" summary describes the elephants' "Rüssel", straight out of the German captions. Output language is unaffected (the prompt controls it, confirmed by 2.5), but summary *fidelity* now rides on a translation the app never chose. This is a content-quality risk for S-01/S-02, not a schema defect, and it is precisely what the diagnostic columns were added to surface. Supadata exposes no way to request "the original track", so there is no fix inside S-08 — it needs a follow-up.

Second observation, on the threshold: the observed pools are 2, 5 and 61, and the 61 is TED, which publishes *human* translations. Neither ordinary video came near the 100+ auto-translation scale `LARGE_LANG_POOL_THRESHOLD = 15` was guessing at. As set, the warning fires on large human-translated catalogues rather than on auto-translation. It is doing no harm, but it is not yet measuring what it was written to measure — revisit once production rows accumulate, as the constant's own comment anticipates.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema and widened persist path

#### Automated

- [x] 1.1 Migration applies cleanly against a fresh local stack — bd307b2
- [x] 1.2 Linting passes — bd307b2
- [x] 1.3 Build passes — bd307b2

#### Manual

- [x] 1.4 One real generation on the local stack still succeeds end-to-end — 2026-07-26, `jNQXAC9IVRw` 200 in 25s, summary returned
- [x] 1.5 The five new columns are present and null, and `thumbnail_url` is renamed to `thumbnail_url_reported` with its rationale comment attached — 2026-07-26, `\d+ public.videos`
- [x] 1.6 Exactly one `persist_summary` exists in `pg_proc` — 2026-07-26, 1 row, `pronargs` 15
- [x] 1.7 The run's reservation is `settled` — 2026-07-26, `settled` / amount 1

### Phase 2: Transcript language signals

#### Automated

- [x] 2.1 Linting passes — 6553ac0
- [x] 2.2 Build passes — 6553ac0

#### Manual

- [x] 2.3 A non-Polish video populates `transcript_lang` with its own language — 2026-07-26, `de` on `jNQXAC9IVRw`, `en` on `dQw4w9WgXcQ`, `af` on `iG9CE55wbtY`; never `pl`. See the vendor caveat below
- [x] 2.4 `transcript_available_langs` is a readable Postgres array — 2026-07-26, `array_length` 2 / 5 / 61, `[1]` reads back
- [x] 2.5 The summary is still returned in Polish — 2026-07-26, Polish output from `de` and `af` transcripts; the prompt, not `lang`, controls output
- [x] 2.6 The large-pool warning appears in the console — 2026-07-26, fired on `iG9CE55wbtY` with URL, lang `af`, 61 languages

### Phase 3: Supadata metadata fetch

#### Automated

- [x] 3.1 Linting passes — 17e9730
- [x] 3.2 Build passes — 17e9730

#### Manual

- [x] 3.3 All seven fields populate with correct values — 2026-07-26, `jNQXAC9IVRw`: "Me at the zoo" / jawed / 19s / 2005-04-23, all verified against the real video
- [x] 3.4 The thumbnail URL loads in a browser — 2026-07-26, both HTTP 200: HD `dQw4w9WgXcQ` maxresdefault.webp (28.6 KB) and low-res `jNQXAC9IVRw` (15.8 KB). Supadata returned a working `hqdefault` for the low-res video, **not** the `maxresdefault` 404 the plan predicted — see §Edge-case correction
- [x] 3.5 A forced metadata failure still saves the summary with null metadata — 2026-07-26, invalid key + cached quote on `kCMwc7qv_f4`: 200, five metadata fields null, `SupadataError: Unauthorized` logged non-retryably
- [x] 3.6 A transport-level rejection is equally non-fatal and leaves the reservation settled — 2026-07-26, injected `TypeError("fetch failed")`: 200, null metadata, reservation `settled`
- [x] 3.7 A second generation of the same video does not null out existing metadata — 2026-07-26, `jNQXAC9IVRw` re-run as `educational` with metadata forced null; all seven fields from run 1 survived the `coalesce`
- [x] 3.8 `usedCredits` rises by exactly 2 for one native-transcript generation — 2026-07-26, 29 → 31 across one generation

### Phase 4: Production rollout

#### Automated

- [x] 4.1 `npx supabase db push` reports the migration applied — 0a67e40
- [x] 4.2 `npx wrangler deploy` completes without error — 0a67e40

#### Manual

- [x] 4.3 A production generation carries the full field set — 2026-07-26, `TVA738-ERqg`: title / HISTORIA REALNA / 4523s / 2026-07-22 / `maxresdefault.jpg` (HTTP 200, 305 KB). **Caveat**: the run took the `allowLong` path, so `transcript_lang` and `transcript_available_langs` are null by design (§Phase 2, quote cache carries no language fields). Five of seven columns proven in production; the two language columns are proven locally only (2.3, 2.4). Accepted as verified
- [x] 4.4 No 500s in the Worker logs for the deploy window — 2026-07-26, live `wrangler tail` over both POSTs: `outcome: ok`, zero exceptions, no error logs
- [x] 4.5 The production reservation is `settled` — 2026-07-26, `ea718a97`, amount 2, `settled`, resolved at 14:23:13Z
- [x] 4.6 `GET /v1/me` confirms the expected credit delta — 2026-07-26, 37 → 39 (+2: one transcript on the 409, one metadata on the resubmit). 61 of 100 remain ≈ 30 further native-transcript generations at the post-halving cost of 2
