import { SupadataError, type Metadata } from "@supadata/js";
import type { VideoMetadata } from "@/types";
import { readBillableCredits, type SupadataMeter } from "./supadata-ledger";

/**
 * Past the rate-limit window on the Free plan's 1 req/s, with margin.
 *
 * The limit it describes is VENDOR-WIDE, not a metadata-specific retry policy, so it has a second
 * consumer since S-09 Phase 6: `supadata-budget.ts` waits this long after `GET /v1/me` before the paid
 * call that follows it, for exactly the same reason `generate.ts` keeps its two Supadata requests
 * seconds apart. Exported rather than copied — two 1200s in two files, linked only by a comment, is
 * precisely the drift that would silently break the spacing both callers depend on.
 */
export const RETRY_DELAY_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The origin `@supadata/js` targets. Called directly, for the reason on `METADATA_TIMEOUT_MS`. */
const SUPADATA_BASE_URL = "https://api.supadata.ai/v1";

/**
 * Wall-clock deadline for one metadata attempt, and the reason this module issues its own request
 * rather than calling `supadata.metadata()`: the SDK's `fetch` carries no `AbortSignal`, and
 * Cloudflare caps only CPU time — waiting on a subrequest is not CPU time — so an SDK call has
 * nothing bounding it.
 *
 * That gap costs more here than anywhere else in the pipeline. This call runs AFTER the credit debit
 * and the paid LLM call, so a stalled request holds the generation lease, the credit reservation and
 * the client's HTTP response open — indefinitely, for a value that is decorative. Only a real
 * `AbortSignal` cancels the subrequest; racing a timer would leave it running. Same guarantee, same
 * mechanism as the bounded provider call in `llm.ts`.
 *
 * 10s is generous for a metadata lookup, and a retry may spend a second one: the operation is bounded
 * at ~21s including the rate-limit delay.
 */
const METADATA_TIMEOUT_MS = 10_000;

/** Narrows the `{ error, message, details }` body Supadata returns on a failed request. */
function isErrorBody(body: unknown): body is { error: SupadataError["error"]; message?: string; details?: string } {
  return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string";
}

/**
 * `GET /v1/metadata`, with a deadline. Deliberately mirrors the SDK's request shape and its error
 * mapping — every failure response, non-JSON body and parse failure still surfaces as a typed
 * `SupadataError` — so `isRetryable` sees the same vendor error codes it would have seen through the
 * SDK. The `AbortSignal` is the only intended behavioural difference.
 *
 * Records ONE ledger row per invocation (S-07), which is the point of metering here rather than in
 * `fetchVideoMetadata`: the retry below is a SECOND billable request, and a per-generation assumption
 * of "one metadata call" would miss it entirely. The row is written on the error paths too, before
 * the throw — a failed request is still a charged one.
 *
 * Metering never weakens the caller's totality contract: `record` is a plain in-memory push that
 * cannot throw, and a transport rejection (no `Response` at all) records `null` rather than a guess.
 */
async function requestMetadata(url: string, apiKey: string, meter?: SupadataMeter): Promise<Metadata> {
  let response: Response;
  try {
    response = await fetch(`${SUPADATA_BASE_URL}/metadata?url=${encodeURIComponent(url)}`, {
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
  } catch (error) {
    // No response arrived (DNS failure, socket reset, our own deadline), so nothing was reported.
    // `null` is honest here in a way `0` would not be — see the column comment on billable_credits.
    meter?.record({ operation: "metadata", outcome: "error", billableCredits: null });
    throw error;
  }

  const billableCredits = readBillableCredits(response);
  const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;

  if (!response.ok) {
    meter?.record({ operation: "metadata", outcome: "error", billableCredits });
    const body = isJson ? ((await response.json().catch(() => null)) as unknown) : null;
    if (isErrorBody(body)) throw new SupadataError(body);
    throw new SupadataError({
      error: "internal-error",
      message: "Unexpected error response format",
      details: `Supadata responded ${response.status}`,
    });
  }

  if (!isJson) {
    meter?.record({ operation: "metadata", outcome: "error", billableCredits });
    throw new SupadataError({
      error: "internal-error",
      message: "Invalid response format",
      details: "Expected JSON response but received different content type",
    });
  }

  try {
    const metadata = (await response.json()) as Metadata;
    meter?.record({ operation: "metadata", outcome: "ok", billableCredits });
    return metadata;
  } catch (error) {
    meter?.record({ operation: "metadata", outcome: "error", billableCredits });
    throw new SupadataError({
      error: "internal-error",
      message: "Failed to parse response",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Retryable is an allow-list, not a fallback. Three failures are worth a second attempt: a
 * rate-limit breach (the 1 req/s Free-plan cap), a transport-level rejection (`fetch` rejects with a
 * `TypeError` on a DNS failure, socket reset or Workers subrequest cap), and our own deadline
 * (`AbortSignal.timeout` aborts with a `TimeoutError`).
 *
 * Everything else returns false. The remaining documented error codes (`not-found`,
 * `invalid-request`, `transcript-unavailable`, `internal-error`, `upgrade-required`, `unauthorized`)
 * are permanent, and an unrecognised rejection — a thrown string, a programmer error, an unexpected
 * runtime failure — is not evidence of a transient fault. Treating either as transient would spend a
 * second Supadata credit and append latency to a generation that has already been paid for and
 * completed.
 *
 * Never throws, whatever shape it is handed — it runs inside the catch that makes the whole call
 * total, so a classifier that threw would defeat the guarantee it exists to support. The
 * `TimeoutError` check is by name rather than `instanceof DOMException` for the same reason: it
 * holds regardless of how the runtime models the abort reason.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof SupadataError) return error.error === "limit-exceeded";
  if (error instanceof TypeError) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

/** Re-emits a vendor date string as ISO, or null. Never hands a raw vendor value to a timestamptz. */
function normalisePublishedAt(createdAt: unknown): string | null {
  if (typeof createdAt !== "string") return null;
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Largest value PostgreSQL's `integer` holds — the ceiling `duration_seconds` is declared with. */
const PG_INT_MAX = 2_147_483_647;

/**
 * Rounds a vendor duration to a value the `integer` column actually accepts, else null. Finiteness
 * alone is not enough: a negative or out-of-range number is a perfectly finite `number` that
 * PostgreSQL rejects, and the rejection would abort the persist of a summary already paid for.
 */
function normaliseDuration(duration: unknown): number | null {
  if (typeof duration !== "number" || !Number.isFinite(duration)) return null;
  const rounded = Math.round(duration);
  return rounded >= 0 && rounded <= PG_INT_MAX ? rounded : null;
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
export async function fetchVideoMetadata(
  { url }: { url: string },
  apiKey: string,
  meter?: SupadataMeter,
): Promise<VideoMetadata | null> {
  try {
    let metadata;
    try {
      metadata = await requestMetadata(url, apiKey, meter);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      await sleep(RETRY_DELAY_MS);
      // A second real request against the vendor, and `requestMetadata` records it as its own row.
      metadata = await requestMetadata(url, apiKey, meter);
    }

    // `media` is a union — only `VideoMedia` carries `duration` and `thumbnailUrl`. A non-video
    // response (image/carousel/post, i.e. not a YouTube video) still yields title, channel and date.
    const media = metadata.media.type === "video" ? metadata.media : null;

    // YouTube responses carry no `author.username` — despite the SDK's `MetadataAuthor` type
    // declaring it a required `string`, it is simply absent for this platform (verified against a
    // real response, see `context/changes/persist-video-metadata/docs/supadata-metadata.md`). The
    // one stable channel identifier YouTube actually returns is `additionalData.channelId`, which is
    // untyped (`Record<string, any>`) and so is narrowed here rather than trusted.
    const channelId = typeof metadata.additionalData.channelId === "string" ? metadata.additionalData.channelId : null;

    return {
      title: metadata.title,
      thumbnailUrl: media?.thumbnailUrl ?? null,
      channelName: metadata.author.displayName,
      channelId,
      durationSeconds: normaliseDuration(media?.duration),
      publishedAt: normalisePublishedAt(metadata.createdAt),
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`fetchVideoMetadata failed for ${url}:`, error);
    return null;
  }
}
