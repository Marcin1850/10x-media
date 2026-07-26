export type ChannelCharacter = "informational" | "educational";

/** How Supadata resolved the transcript fetch — observed fetch mechanism only, not a claim about native-caption vs Whisper-generated origin (Supadata's API doesn't expose that). */
export type TranscriptResolvedVia = "inline" | "job";

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
  created_at: string;
}
