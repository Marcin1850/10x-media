# Supadata — transcript endpoint (`GET /v1/transcript`)

**REST base:** `https://api.supadata.ai/v1` · **Auth:** `x-api-key` header · Context7: `/llmstxt/supadata_ai_llms_txt` · **Fetched 2026-07-25** · **re-checked 2026-07-29** (parameters, pricing and error enum unchanged; §Latency added)

**Role here:** the app already calls this (`src/lib/services/transcript.ts:30`). Captured because two open questions live in its parameters — S-09's cost guardrail (`mode`) and S-08's `language` column (`lang`). Extends `../../transcript-llm-probe/docs/supadata.md`, which covers SDK/REST usage and remains accurate.

## Parameters (OpenAPI, `docs.supadata.ai/api-reference/endpoint/transcript/transcript`)

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `url` | string (uri) | — | **Required.** Any supported platform (YouTube, TikTok, Twitter/X, Instagram, Facebook) or a file URL |
| `lang` | string | — | Preferred ISO 639-1 code. If unavailable, **the API defaults to the first available language** |
| `text` | boolean | `false` | `true` → plain text; `false` → timestamped chunks |
| `chunkSize` | number (50–10000) | — | Max chars per chunk; **only when `text=false`** |
| `mode` | enum | `auto` | `native` \| `auto` \| `generate` — see below |

Responses: `200` transcript, `202` job id (async), `400` invalid request, `404` not found, `500` internal error. The app treats the async form by polling `/transcript/:jobId`.

Current call: `supadata.transcript({ url, text: true, mode: "auto", lang: "en" })`. S-08 first dropped `lang: "pl"` entirely, then settled on `lang: "en"` once the open question below was answered empirically — see §Language selection.

> The `/v1/youtube/transcript` variant is marked **`deprecated: true`** in the OpenAPI spec (2026-07-27 re-fetch). The app already uses `/v1/transcript`; nothing to change, worth not regressing.

## `mode` — the S-09 lever

> `native` (only fetch existing transcript), `generate` (always generate transcript using AI), or `auto` (try native, fallback to generate if unavailable). **If url is a file URL, mode is always `generate`.**

`auto` is the documented default *and* the app's explicit choice. Its fallback to `generate` is silent — nothing in the response distinguishes "cheap" from "expensive" before the bill lands, which is exactly the exposure S-09 exists to close. `native` is the one setting that makes worst-case spend knowable in advance (always 1 credit); caption-less videos then return `transcript-unavailable`, which the endpoint already maps to a user-facing 422.

## Language selection — the S-08 caveat

Three documented behaviours, all relevant:

1. **`lang` selects, it does not translate.** "If a preferred language is unavailable, the system returns the first available language along with a list of alternatives." Translation is a **separate endpoint** (`docs.supadata.ai/youtube/get-transcript-translation`, params: URL *or* video ID + target ISO 639-1 code, optional `text` / `chunkSize`) which the app never calls. So `lang: "pl"` buys nothing on a video with no Polish track — the Polish output comes entirely from the prompt (`src/lib/services/llm.ts:23,52`).
2. **In `generate` mode `lang` is ignored entirely** and the transcript is produced in the video's original language. The app's `lang: "pl"` is therefore silently dropped on exactly the expensive path.
3. **"First available" has no documented ordering** — so omitting `lang` is not a guarantee of getting the original track either.

### ✅ Answered empirically, 2026-07-27 (review finding F9)

The question below was run for 3 credits during impl-review triage. The docs were right that `lang` selects rather than translates — and **point 3 turned out to be the decisive one**: omitting `lang` was the exposure, not the protection.

| Video | Source | Pool reported | No `lang` → | `lang: "en"` → |
| --- | --- | --- | --- | --- |
| `jNQXAC9IVRw` (*Me at the zoo*) | English | `{de}` without `lang`; `{en,de}` with `lang=en` | **`de`** — German wording ("Rüssel") reached the delivered summary | **`en`** — genuine English original |
| `iG9CE55wbtY` (TED talk) | English | 61 tracks, beginning `af, sq, ar, …` | **`af`** (Afrikaans) | **`en`** |

Two things to read off this, both confirmed by an end-to-end re-run on 2026-07-27:

1. **The default returns the first track in the pool, and pool order has nothing to do with originality.** TED's pool begins with `af` and `af` is what came back. So "first available language" is literal — it is simply not a signal about which track is the source.
2. **The reported pool is request-dependent.** `jNQXAC9IVRw` reported `{de}` on the no-`lang` call and `{en,de}` when `en` was requested. `availableLangs` is therefore not a stable property of a video and should not be treated as a complete caption inventory.

An earlier draft of this section claimed the default "ignores pool order", citing `["en","de"]` → `de`. That conflated the pool reported by the `lang=en` call with the result of the no-`lang` call. The conclusion is unchanged and better supported: omitting `lang` gives you an arbitrary track, and on 2 of 3 videos that track was not the original.

Two further results, both negative:

- **No original-track marker exists.** The response is bare ISO codes; nothing distinguishes original, auto-generated, or auto-translated tracks.
- **`GET /v1/metadata` carries no language field at all.** Both videos were probed and the *entire* payload scanned for any key matching `/lang/i` — zero hits; `additionalData` holds only `channelId`. This empirically confirms what `supadata-metadata.md:47,66` already assumed: a real spoken-language field is obtainable only from the YouTube Data API's `snippet.defaultAudioLanguage`.

So the source language cannot be learned from Supadata *before* choosing a track, and a single preferred code is the only lever available.

**Decision: `lang: "en"`** (`src/lib/services/transcript.ts`, full rationale in the comment there). English-original video → the original; Polish-original video → pool is typically `{pl}` alone, so the request falls through and the fallback returns the Polish original. `lang: "pl"` was rejected: it would actively select a Polish translation on exactly the large-pool English content that `change.md` forbids, and would leave `jNQXAC9IVRw` broken since that pool has no `pl` to fall through from. Residual risk — a Polish-original video that also carries an English track — is what `transcript_lang` / `transcript_available_langs` now measure.

`mode: "generate"` is immune to the whole problem (point 2 above: it ignores `lang` and works from the original audio) but was rejected on cost and latency: 2 credits/min instead of 1 flat, and every request routed through the job poller.

## Response shape (`text=true`)

```ts
{
  content: string,
  lang: string,              // ISO 639-1 — the language actually returned
  availableLangs: string[],  // alternatives
}
```

`TranscriptResult` in `src/lib/services/transcript.ts:4-6` keeps `content` and `lang` but has **no field for `availableLangs`**, and the call site (`src/pages/api/summaries/generate.ts:260`) discards `lang` too — so the app has never recorded which language it actually summarised from. Adding both is part of S-08.

## Latency — added 2026-07-29 (S-07 impl-review finding F2)

Documented at `docs.supadata.ai/get-transcript`, §Latency:

> Native transcripts resolve at normal latency; **AI-generated transcripts can take up to 60 seconds**. **Videos exceeding 20 minutes** trigger an asynchronous job, returning `202` with a job id. Developers should account for these latencies to prevent timeouts, as **timed-out requests still consume credits**.

Three consequences, all of which the earlier capture missed:

1. **60 seconds is the vendor's own ceiling for the synchronous path, so it is not a usable client deadline.** A deadline set *at* the documented maximum aborts responses the API was still entitled to deliver. `src/lib/services/transcript.ts` therefore uses **90s** for the initial request — half again over the ceiling, and just under the ~100s Cloudflare origin timeout behind the `524` observed on 2026-07-29 (`../../persist-time-and-cost/docs/supadata-billable-requests.md`), so the app gives up at roughly the point the vendor's edge does. Job-status polls carry no transcription behind them and get **10s**, matching `metadata.ts`.
2. **A client-side timeout is not free.** The abort cancels our wait, not the vendor's work or its billing — so an over-tight deadline converts a slow success into a paid nothing. This is the reason the limit is set generously rather than defensively.
3. **The `202` job path is gated on video length (>20 min), not on caption availability.** This is the missing half of "the job path stayed unobserved": every local probe ran on 2–3 minute videos, which cannot reach it regardless of `mode`. It also bounds `mode: "generate"`'s exposure — under 20 minutes it answers inline (as the 2:55 probe did), so the poller is reachable only on long videos, exactly where 2 credits/minute hurts most.

Before this, the module bounded itself only by attempt count (`JOB_POLL_MAX_ATTEMPTS`), which counts attempts that *resolve* and so does nothing about one that never does. Cloudflare caps only CPU time, and waiting on a subrequest is not CPU time.

## Pricing

- Native transcript: **1 credit**
- Generated (Whisper): **2 credits per minute** of video
- Job-status checks: **free** (so the app's 12 poll attempts cost nothing)
- A `206` "transcript unavailable" response: **1 credit** — a failed native attempt is still billable, which is the hidden cost of S-09's lever D
- Batch endpoint (unused): 1 credit to open the job + 1 per video — a 10-video batch is 11

## Error codes (shared enum)

`invalid-request`, `internal-error`, `forbidden`, `unauthorized`, `upgrade-required`, `transcript-unavailable`, `not-found`, `limit-exceeded`.

`transcript-unavailable` is the one the app handles specially (`transcript.ts:42`). Documented causes include "video has no captions", whose documented fix is precisely `generate`/`auto` mode. `limit-exceeded` is what a rate-limit breach returns — see `supadata-account-limits.md`.

**Source:** Supadata docs (`docs.supadata.ai/get-transcript`, `/api-reference/endpoint/transcript/transcript`, `/youtube/supported-language-codes`, `/youtube/get-transcript-translation`, `/errors/transcript-unavailable`, `/youtube/batch`) via Context7, 2026-07-25.
