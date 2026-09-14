export type ChannelCharacter = "informational" | "educational";

/**
 * How the transcript was obtained. `"inline"` / `"job"` are the observed Supadata fetch mechanism
 * only — not a claim about native-caption vs Whisper-generated origin (Supadata's API doesn't expose
 * that). `"stored"` (S-07) is not a fetch mechanism at all: it means the transcript came from the
 * shared `transcript_cache` and NO paid Supadata call was made, which is what explains a near-zero
 * `transcript_ms` on the summary row.
 */
export type TranscriptResolvedVia = "inline" | "job" | "stored";

/** What a real Supadata fetch can report — `"stored"` is excluded, since a cache hit made no call. */
export type FetchedResolvedVia = Exclude<TranscriptResolvedVia, "stored">;

/**
 * How a generation obtained its video metadata (S-09 D10). Documented the same way as
 * `TranscriptResolvedVia` and for the same reason: `"stored"` means the row came from
 * `metadata_cache` and NO paid Supadata call was made, which is what explains a near-zero
 * `metadata_ms`.
 *
 * `"fetched"` is a vendor call that RETURNED metadata; `"fetch_failed"` is one that was made and came
 * back with nothing. Both mean a request went out — and possibly TWO, since `fetchVideoMetadata`
 * retries a retryable failure once — but only the first produced a row worth caching (D9), and a
 * failure is billed 0. Neither value is a spend figure: `supadata_calls` logs each call individually
 * and is the only source for what was actually billed. `"skipped_budget"` (S-09 Phase 6) means the
 * budget breaker refused the call and nulls were persisted, exactly as a metadata failure already
 * does; the marker is what stops that degraded row looking like an unexplained gap.
 *
 * `metadata_ms` IS ONLY COMPARABLE ACROSS ROWS THAT CALLED THE VENDOR — see the column comment.
 */
export type MetadataVia = "fetched" | "fetch_failed" | "stored" | "skipped_budget";

export interface Video {
  id: string;
  user_id: string;
  url: string;
  youtube_id: string;
  title: string | null;
  /**
   * The thumbnail URL exactly as Supadata last reported it — never repaired. Supadata returns
   * `maxresdefault.jpg`, which does not exist for videos never uploaded above 480p, so a renderer
   * must fall back on BOTH null and a 404 to the derived
   * `https://i.ytimg.com/vi/<youtube_id>/hqdefault.jpg`, and must never write that fallback back.
   */
  thumbnail_url_reported: string | null;
  channel_name: string | null;
  /** The channel's stable YouTube identifier, if the vendor reported one — see `VideoMetadata.channelId`. */
  channel_id: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  /** Which caption track the transcript came from. Diagnostic only — NOT the video's spoken language. */
  transcript_lang: string | null;
  /** The caption-track pool that track was chosen from. Diagnostic only. */
  transcript_available_langs: string[] | null;
  created_at: string;
}

/**
 * The descriptive fields S-08 persists, normalised to be safe for their typed columns. Field names
 * stay vendor-shaped (`thumbnailUrl`); mapping onto `thumbnail_url_reported` happens in the persist
 * layer, where the column name records that the value is what Supadata said and is never repaired.
 *
 * Shared rather than local because it crosses three modules — the metadata service produces it, the
 * generate endpoint carries it, the persistence service writes it — and a second structural copy
 * would let the producer and the writer drift apart silently.
 */
export interface VideoMetadata {
  title: string | null;
  thumbnailUrl: string | null;
  channelName: string | null;
  /**
   * The channel's stable YouTube identifier (Supadata `additionalData.channelId`), e.g.
   * `"UCuAXFkgsw1L7xaCfnd5JJOw"` — used to build a direct `youtube.com/channel/<id>` link. Distinct
   * from `channelName`, the display name, which is not a valid link target. NOT a handle: YouTube
   * responses carry no `author.username`, unlike other platforms Supadata supports.
   */
  channelId: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
}

/**
 * One row of the summary list (S-02) — flat, UI-facing, camelCase. Joins a `summaries` row to its
 * `videos` row so the card has everything it renders in one object.
 *
 * Shared rather than local for the same reason `VideoMetadata` is: it crosses three modules — the
 * list service produces it, `GET /api/summaries` serialises it, the card renders it — and three
 * structural copies would drift apart silently.
 *
 * Every video-derived field is nullable EXCEPT `youtubeId` and `url`: those two are `NOT NULL`
 * columns, and pre-S-08 rows carry nulls in all the descriptive ones (they were never backfilled).
 * Telemetry (`cost_usd`, `model`, `generation_ms`) is deliberately absent — provider spend is not the
 * credit the user paid — and so is `transcript_lang`, which is the transcript's language rather than
 * the video's and would be false exactly when auto-translated tracks exist (S-08 decision).
 */
export interface SummaryListItem {
  id: string;
  character: ChannelCharacter;
  content: string;
  createdAt: string;
  youtubeId: string;
  url: string;
  title: string | null;
  /** What Supadata last reported — may be null or 404. See `Video.thumbnail_url_reported`. */
  thumbnailUrlReported: string | null;
  channelName: string | null;
  /** The channel's stable YouTube identifier, if the vendor reported one — see `VideoMetadata.channelId`. */
  channelId: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  /** The user's watch/skip mark (S-14): `null` unmarked, `true` worth watching, `false` not worth watching. */
  worthWatching: boolean | null;
}

export interface Summary {
  id: string;
  user_id: string;
  video_id: string;
  character: ChannelCharacter;
  content: string;
  model: string | null;
  resolved_via: TranscriptResolvedVia | null;
  /**
   * Generation telemetry (S-07). All nullable: rows written before the telemetry landed keep nulls,
   * and no backfill prices history from a formula this slice deliberately discredited.
   */
  /** Character count of the transcript this summary was actually built from. */
  transcript_chars: number | null;
  /** Wall clock to immediately before the persist call — NOT to the response. See the column comment. */
  generation_ms: number | null;
  /** Time spent acquiring the transcript: the fetch, the quote read, or the cache read. */
  transcript_ms: number | null;
  llm_ms: number | null;
  /**
   * Includes the metadata retry and its ~1.2 s rate-limit sleep — real latency the user waited
   * through — but ONLY on a row that actually called the vendor (`metadata_via = 'fetched'` or
   * `'fetch_failed'`). On a `'stored'` row it brackets a database read and reads near zero, so any
   * comparison across rows must filter on `metadata_via`; service-time queries want `'fetched'`
   * alone, since a failure's duration is a timeout or an error rather than a service time.
   */
  metadata_ms: number | null;
  /** How the metadata was obtained (S-09). Null on rows predating the column. */
  metadata_via: MetadataVia | null;
  /** OpenRouter's own reported cost, never a figure computed from tokens and a price table. */
  cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}
