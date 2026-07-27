# Supadata — transcript endpoint (`GET /v1/transcript`)

**REST base:** `https://api.supadata.ai/v1` · **Auth:** `x-api-key` header · Context7: `/llmstxt/supadata_ai_llms_txt` · **Fetched 2026-07-25**

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

| Video | Source | Pool | No `lang` → | `lang: "en"` → |
| --- | --- | --- | --- | --- |
| `jNQXAC9IVRw` (*Me at the zoo*) | English | `["en","de"]` | **`de`** — German wording ("Rüssel") reached the delivered summary | **`en`** — genuine English original |
| `iG9CE55wbtY` (TED talk) | English | 61 tracks | **`af`** (Afrikaans) | not probed |

Note row 1: `en` is listed **first** in `availableLangs` and was *still* not what the default returned. The vendor's "first available language" has no bias toward the source track and does not follow pool order.

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
