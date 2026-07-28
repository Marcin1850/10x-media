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
  durationSeconds: number | null;
  publishedAt: string | null;
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
  /** Includes the metadata retry and its ~1.2 s rate-limit sleep — real latency the user waited through. */
  metadata_ms: number | null;
  /** OpenRouter's own reported cost, never a figure computed from tokens and a price table. */
  cost_usd: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  created_at: string;
}
