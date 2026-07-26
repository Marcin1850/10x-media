import { Supadata, SupadataError } from "@supadata/js";

/**
 * The descriptive fields S-08 persists, normalised to be safe for their typed columns. Field names
 * stay vendor-shaped (`thumbnailUrl`); mapping onto `thumbnail_url_reported` happens in the persist
 * layer, where the column name records that the value is what Supadata said and is never repaired.
 */
export interface VideoMetadata {
  title: string | null;
  thumbnailUrl: string | null;
  channelName: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
}

/** Past the rate-limit window on the Free plan's 1 req/s, with margin. */
const RETRY_DELAY_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Only two failures are worth a second attempt: a rate-limit breach (the 1 req/s Free-plan cap) and
 * a transport-level rejection, which is a rejection carrying no recognised SupadataError shape — a
 * DNS failure, a socket reset, a Workers subrequest cap. Every documented error code
 * (`not-found`, `invalid-request`, `transcript-unavailable`, `internal-error`, `upgrade-required`,
 * `unauthorized`) is permanent, and retrying one only appends latency to a generation that has
 * already been paid for and completed.
 *
 * Never throws, whatever shape it is handed — it runs inside the catch that makes the whole call
 * total, so a classifier that threw would defeat the guarantee it exists to support.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof SupadataError) {
    return error.error === "limit-exceeded";
  }
  // Not a SupadataError: the SDK never recognised the response, so this is transport-level.
  return true;
}

/** Re-emits a vendor date string as ISO, or null. Never hands a raw vendor value to a timestamptz. */
function normalisePublishedAt(createdAt: unknown): string | null {
  if (typeof createdAt !== "string") return null;
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Rounds a vendor duration only when it is a finite number, else null. `integer` column. */
function normaliseDuration(duration: unknown): number | null {
  return typeof duration === "number" && Number.isFinite(duration) ? Math.round(duration) : null;
}

/**
 * Fetches video metadata from Supadata. TOTAL by contract: it returns normalised values or null and
 * never throws, never rejects.
 *
 * Totality is load-bearing rather than tidy. The call sits after the credit debit and the paid LLM
 * call but BEFORE the persistence `try`/`catch`, so anything escaping here would bypass the immediate
 * refund and strand a reservation for later reconciliation — trading a durable ledger row for a
 * thumbnail. The `try` therefore wraps the ENTIRE retry operation, second attempt and classifier
 * included, so an unstructured transport rejection is caught exactly like a `SupadataError`.
 *
 * A malformed vendor value is a failure mode of its own: `duration_seconds` is `integer` and
 * `published_at` is `timestamptz`, so a non-finite duration or an unparseable `createdAt` would abort
 * the persist transaction and discard a summary that has already been paid for. Both are normalised
 * to null here rather than passed through.
 *
 * Costs a flat 1 Supadata credit per call — see `docs/supadata-metadata.md` §Pricing.
 */
export async function fetchVideoMetadata({ url }: { url: string }, apiKey: string): Promise<VideoMetadata | null> {
  const supadata = new Supadata({ apiKey });

  try {
    let metadata;
    try {
      metadata = await supadata.metadata({ url });
    } catch (error) {
      if (!isRetryable(error)) throw error;
      await sleep(RETRY_DELAY_MS);
      metadata = await supadata.metadata({ url });
    }

    // `media` is a union — only `VideoMedia` carries `duration` and `thumbnailUrl`. A non-video
    // response (image/carousel/post, i.e. not a YouTube video) still yields title, channel and date.
    const media = metadata.media.type === "video" ? metadata.media : null;

    return {
      title: metadata.title,
      thumbnailUrl: media?.thumbnailUrl ?? null,
      channelName: metadata.author.displayName,
      durationSeconds: normaliseDuration(media?.duration),
      publishedAt: normalisePublishedAt(metadata.createdAt),
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`fetchVideoMetadata failed for ${url}:`, error);
    return null;
  }
}
