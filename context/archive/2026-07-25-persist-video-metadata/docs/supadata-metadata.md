# Supadata — metadata endpoint (`GET /v1/metadata`)

**REST base:** `https://api.supadata.ai/v1` · **Auth:** `x-api-key: <SUPADATA_API_KEY>` header · Context7: `/llmstxt/supadata_ai_llms_txt` · **Fetched 2026-07-25**

**Role in S-08:** the single call that supplies every field this slice persists. Covers title, channel name, duration and upload date in one request on the key the app already holds — which is why the metadata-source question ("oEmbed vs. YouTube Data API vs. Supadata") resolved to Supadata without a new provider, key or quota.

## Response schema (YouTube video)

Source: `docs.supadata.ai/get-metadata`

```json
{
  "platform": "youtube",
  "type": "video",
  "id": "dQw4w9WgXcQ",
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up",
  "description": "The official video for \"Never Gonna Give You Up\"...",
  "author": {
    "displayName": "Rick Astley",
    "avatarUrl": "https://yt3.ggpht.com/..."
  },
  "stats": { "views": 1234567890, "likes": 12345678, "comments": 200000, "shares": null },
  "media": {
    "type": "video",
    "duration": 213,
    "thumbnailUrl": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg"
  },
  "tags": ["Rick Astley", "Never Gonna Give You Up", "Official Video"],
  "createdAt": "2009-10-25T00:00:00Z",
  "additionalData": { "channelId": "UCuAXFkgsw1L7xaCfnd5JJOw" }
}
```

## Field → column mapping for this slice

| Planned column | Source field | Notes |
| --- | --- | --- |
| `videos.title` (exists, never written) | `title` | Column created by F-01, dead until this slice |
| `videos.thumbnail_url_reported` (renamed from `thumbnail_url`, never written) | `media.thumbnailUrl` | Hotlink the CDN URL for the MVP — no storage copy. Renamed in this slice while the column is still empty; the vendor returns `maxresdefault.jpg`, which 404s below 480p, so consumers fall back to `hqdefault.jpg` |
| `channel_name text` (new) | `author.displayName` | `additionalData.channelId` is also available if a stable key is ever wanted |
| `duration_seconds integer` (new) | `media.duration` | Already **seconds** — no ISO-8601 duration parsing (unlike the YouTube Data API's `PT3M33S`) |
| `published_at timestamptz` (new) | `createdAt` | ISO 8601 UTC |
| `transcript_lang text` (new) | — | **Not in this response.** From the transcript call's `Transcript.lang`; see `supadata-transcript.md` |
| `transcript_available_langs text[]` (new) | — | **Not in this response.** From `Transcript.availableLangs`; diagnostic only |

> Named `transcript_*` deliberately. `plan.md` rules out a bare `language` column so it cannot be read as the video's *spoken* language — that field is only obtainable from the YouTube Data API's `snippet.defaultAudioLanguage`, which is out of scope.

Unused but available: `description`, `stats.*`, `tags`, `platform`, `type`. Out of scope for S-08.

## Pricing

> Every metadata request incurs a flat cost of **1 credit**, regardless of the specific platform or media type being queried. — `docs.supadata.ai/get-metadata` §Pricing

Consequence for S-08: adding this call **doubles** the Supadata cost of a generation whose transcript was native (1 → 2 credits), and is ~2% noise on one that fell back to Whisper. See `supadata-account-limits.md` for what that does to the monthly ceiling.

## Do not use the deprecated per-platform variant

`GET /v1/youtube/video` returns YouTube video metadata and is marked **`deprecated: true`** in the OpenAPI spec (`docs.supadata.ai/api-reference/endpoint/youtube/video-get`). Its SDK form is `supadata.youtube.video({ id })`, where `id` accepts a URL or a bare video ID. Prefer the unified `/metadata` endpoint.

Documented error responses for the deprecated endpoint: `400` invalid request, `404` not found, `500` internal error.

## Rejected alternatives (for the record)

- **YouTube oEmbed** — no API key needed, returns `title`, `author_name`, `thumbnail_url`. Rejected: carries **neither duration nor upload date**, so it cannot satisfy this slice's widened scope.
- **YouTube Data API v3** — would cover everything (`contentDetails.duration` as ISO-8601, `snippet.publishedAt`, `snippet.channelTitle`, and `snippet.defaultAudioLanguage` for a *real* audio language). Rejected: needs a new API key, a new quota to manage, and a second vendor for one decorative field.

**Source:** Supadata docs (`docs.supadata.ai/get-metadata`, `/api-reference/endpoint/youtube/video-get`) via Context7, 2026-07-25.
