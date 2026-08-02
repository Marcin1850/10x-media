import { SupadataError, type Transcript, type TranscriptOrJobId, type JobResult } from "@supadata/js";
import type { FetchedResolvedVia } from "@/types";
import { readBillableCredits, type SupadataMeter } from "./supadata-ledger";

export type TranscriptResult =
  | { ok: true; content: string; lang: string; availableLangs: string[]; resolvedVia: FetchedResolvedVia }
  /**
   * The failure arm is split three ways (S-07) so the endpoint can cache the permanent answer without
   * ever caching a transient one:
   *
   *   `unavailable` — the vendor says there is no transcript (its `transcript-unavailable` error, a
   *                   non-string `content`, or a job that completed with nothing). Durable: safe to
   *                   negative-cache.
   *   `failed`      — the Whisper job reported failure. Transient; says nothing about the video.
   *   `timeout`     — the poll budget ran out. Transient, and likeliest on exactly the long videos
   *                   where Whisper runs longest.
   *
   * The USER-FACING surface is unchanged — all three still map to the same 422. The distinction exists
   * solely to gate the negative cache and to give the ledger a truthful `outcome`.
   */
  | { ok: false; reason: "unavailable" | "failed" | "timeout" };

// Supadata gives no upper bound on Whisper job duration for long videos, and summarization isn't
// a real-time interaction, so the poll backs off exponentially: fast checks up front for jobs that
// finish quickly, wide-spaced checks later to cover long videos without spending many subrequests.
// Workers HTTP requests have no wall-clock duration limit — the real cap on this loop is the
// free-plan subrequest budget (50/invocation) — so bounding by attempt count (not time) is what
// actually protects that budget, leaving headroom for the request's other calls plus future ones.
const JOB_POLL_INITIAL_INTERVAL_MS = 1000; // matches Supadata's own recommended polling cadence
const JOB_POLL_BACKOFF_FACTOR = 2;
const JOB_POLL_MAX_INTERVAL_MS = 30000;
const JOB_POLL_MAX_ATTEMPTS = 12; // ~4 minutes of total coverage at 12 subrequests

// A caption-pool-size warning used to live here (`LARGE_LANG_POOL_THRESHOLD = 15`). Removed in F11:
// pool size was only ever a proxy for "we may not have the original track", chosen when this function
// sent no `lang` at all and nothing better was available. It measured the wrong thing — it fired on
// TED's 61 *human* translations while staying silent on the `{en, de}` video that actually served
// German. `transcript_lang` / `transcript_available_langs` record the same facts queryably, across
// every row rather than whichever ones a log retention window happens to cover.

/** The origin `@supadata/js` targets. Called directly — see `supadataGet`. */
const SUPADATA_BASE_URL = "https://api.supadata.ai/v1";

/**
 * Wall-clock deadlines for one Supadata request. Same mechanism and rationale as
 * `metadata.ts`'s `METADATA_TIMEOUT_MS` and `llm.ts`'s `SUMMARY_TIMEOUT_MS`: Cloudflare caps only CPU
 * time, and waiting on a subrequest is not CPU time, so an unbounded `fetch` has nothing bounding it.
 * Attempt-count bounding (`JOB_POLL_MAX_ATTEMPTS`) does not help — it counts attempts that RESOLVE,
 * and one that never resolves outlives the 600s generation lease and can overlap a successor.
 *
 * The initial limit is 90s, not 60s. The vendor documents the synchronous path as taking "up to 60
 * seconds" for AI-generated transcripts (videos past 20 minutes go async and return a `202` instead),
 * so 60s is the documented CEILING, not a safe deadline — and the same paragraph warns that a
 * timed-out request still consumes credits, which makes aborting early strictly worse than waiting.
 * 90s clears that ceiling by half while staying just under the ~100s Cloudflare origin timeout that
 * produced the observed `524` (`docs/supadata-billable-requests.md`), so we give up at roughly the
 * point the vendor's own edge does.
 *
 * A poll is a cheap job-status read with no transcription behind it, so it gets the same 10s as the
 * metadata lookup. Worst case for the whole operation stays ~5.5 minutes, well inside the lease.
 */
const TRANSCRIPT_TIMEOUT_MS = 90_000;
const JOB_POLL_TIMEOUT_MS = 10_000;

/**
 * The `lang` this module asks for. Exported so the caller can record it as the cache row's
 * `requested_lang` without restating the literal — a diagnostic record of what was asked for, which
 * would otherwise silently drift from what is actually sent.
 */
export const TRANSCRIPT_REQUESTED_LANG = "en";

/**
 * The `mode` this module asks for — `native` ONLY, never `auto` or `generate` (S-09 lever A, D1).
 *
 * PRICE. `native` serves an existing caption track and bills a flat 1 credit. `auto` — what this
 * module used to send — is documented as "try native, fall back to generate", and that fallback is
 * silent: a Whisper-generated transcript bills 2 credits PER MINUTE, so one ~50-minute video drains a
 * whole 100-credit month. `HARD_MAX_TRANSCRIPT_CHARS` cannot help, because it is evaluated on a
 * transcript that has already been paid for. Under `native` the worst case for one transcript is
 * knowable before the call: 1 credit.
 *
 * WHAT IT COSTS US. A video with no caption track becomes unsummarizable — for as long as it has no
 * caption track — rather than expensively summarizable. That is a deliberate capability loss, and it
 * is why the endpoint gives that case its own 422 copy instead of a generic failure (D3): the user is
 * told the specific thing that is wrong and can act on it by picking another video. The outcome is
 * durable, not eternal — `TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS` expires an `unavailable` row
 * after 2 h (D4) precisely because captions can appear on a video later, so a resubmit past that
 * window re-asks the vendor rather than replaying the old answer.
 *
 * WHAT IT CLOSES. `resolved_via = 'job'` can now never appear again: a `202` job acceptance is the
 * Whisper path, and `native` never enters it. S-07's open hand-over question — "is the job path
 * reachable at all?" — is therefore unanswerable from here on. Accepted knowingly (D1).
 *
 * Hard-coded on purpose (D2). An env var would let the expensive path be re-enabled from a secret
 * store with no trace in the code and no review. `pollTranscriptJob` below stays in place for the
 * same reason inverted — it is the vendor's documented `202` behaviour, and keeping it means
 * re-enabling `auto` is a one-word change rather than a rewrite.
 */
const TRANSCRIPT_MODE = "native";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Narrows the `{ error, message, details }` body Supadata returns on a failed request. */
function isErrorBody(body: unknown): body is { error: SupadataError["error"]; message?: string; details?: string } {
  return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string";
}

/**
 * Shape guards for the two SUCCESSFUL bodies this module reads. They exist because a `2xx` body is
 * still an external input: `"jobId" in result` and `job.status` are property accesses that THROW on
 * `null` or a primitive, and a throw at that point escapes the transport with the already-read
 * `x-billable-requests` figure discarded — a real, paid call recorded as `null`, or under the wrong
 * operation. Running the guards inside `supadataGet` converts that into a `BilledSupadataError` that
 * still carries the header, so every caller's existing metering records the truth.
 *
 * Deliberately PERMISSIVE about everything the callers already handle: a `content` that is not a
 * string is a legitimate `unavailable` answer, not a schema failure, and a transcript that arrives
 * with an odd `lang` is still a transcript worth the credit already spent. These reject only bodies
 * whose shape makes the branch itself unevaluable.
 */
function isTranscriptOrJobId(body: unknown): body is TranscriptOrJobId {
  if (typeof body !== "object" || body === null) return false;
  // A job acceptance is only actionable if the id is a string — we put it straight into a URL path.
  return "jobId" in body ? typeof body.jobId === "string" : true;
}

function isJobResult(body: unknown): body is JobResult<Transcript> {
  // `status` must be a readable string: every branch of the poll loop turns on it, and a missing one
  // would silently read as "still running" and burn the remaining poll budget on a broken job.
  return typeof body === "object" && body !== null && typeof (body as { status?: unknown }).status === "string";
}

/**
 * One raw Supadata GET, with the response's `x-billable-requests` figure alongside the parsed body.
 *
 * This module left `@supadata/js` for a direct `fetch` (S-07) for exactly one reason: the SDK funnels
 * every method through one transport that reads headers only for `content-type` and returns
 * `await res.json()`, so the `Response` never escapes and the per-call credit figure is unreachable
 * through it. There is no interceptor hook, and patching the global `fetch` fails because the module
 * binds it at load time. `metadata.ts:43` already set this precedent for `/v1/metadata`.
 *
 * ERROR SEMANTICS ARE PRESERVED VERBATIM, because `fetchTranscript`'s `transcript-unavailable` branch
 * and every caller depend on them: non-2xx with a JSON body → `new SupadataError(body)`; non-2xx
 * without → `SupadataError({ error: 'internal-error', … })`; 2xx with a non-JSON content-type → the
 * same. Nothing downstream can tell the transport changed.
 *
 * A blown `timeoutMs` rejects `fetch` itself with a `TimeoutError`, which is deliberately NOT wrapped
 * in a `BilledSupadataError`: no response arrived, so nothing was reported, and `billedFromError`
 * correctly yields `null` rather than inventing a figure. `httpStatusFromError` yields `null` for the
 * same reason and it is the honest answer, not a gap — there IS no status when the vendor never
 * answered. Do not invent one. The caller's existing metering records the failed call and the
 * endpoint maps it to the same 502 as any other transport failure.
 *
 * `isValid` runs on the parsed 2xx body INSIDE this boundary, so a malformed success leaves as a
 * `BilledSupadataError` still carrying the header, exactly like a malformed failure. A `2xx` is not a
 * promise of a readable shape, and the caller must not have to defend against one.
 */
async function supadataGet<T>(
  path: string,
  apiKey: string,
  timeoutMs: number,
  isValid: (body: unknown) => body is T,
): Promise<{ body: T; billableCredits: number | null; httpStatus: number }> {
  const response = await fetch(`${SUPADATA_BASE_URL}${path}`, {
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Read before any throw: an error response is still a billable call, and the row recording it is the
  // single most valuable thing this ledger captures. `response.status` is read here for the same
  // reason and travels the same two paths (D13) — returned on success, carried on the error
  // otherwise. A `206 transcript-unavailable` leaves through the `!response.ok` arm below, so the
  // success path alone would record nothing for the exact case this column exists for.
  const billableCredits = readBillableCredits(response);
  const httpStatus = response.status;
  const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;

  if (!response.ok) {
    const body = isJson ? ((await response.json().catch(() => null)) as unknown) : null;
    if (isErrorBody(body)) throw new BilledSupadataError(body, billableCredits, httpStatus);
    throw new BilledSupadataError(
      {
        error: "internal-error",
        message: "Unexpected error response format",
        details: `Supadata responded ${httpStatus}`,
      },
      billableCredits,
      httpStatus,
    );
  }

  if (!isJson) {
    throw new BilledSupadataError(
      {
        error: "internal-error",
        message: "Invalid response format",
        details: "Expected JSON response but received different content type",
      },
      billableCredits,
      httpStatus,
    );
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    throw new BilledSupadataError(
      {
        error: "internal-error",
        message: "Failed to parse response",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      billableCredits,
      httpStatus,
    );
  }

  if (!isValid(body)) {
    throw new BilledSupadataError(
      {
        error: "internal-error",
        message: "Unexpected response shape",
        details: `Supadata returned ${httpStatus} with a body this endpoint cannot read`,
      },
      billableCredits,
      httpStatus,
    );
  }

  return { body, billableCredits, httpStatus };
}

/**
 * A `SupadataError` that also carries what the failing response reported billing, and the status it
 * reported it under.
 *
 * It extends `SupadataError` rather than wrapping it precisely so that every existing
 * `instanceof SupadataError` / `error.error === …` check keeps working unchanged — including
 * `metadata.ts`'s `isRetryable`. The extra fields are only read by the metering in this module;
 * nothing downstream needs to know they exist.
 *
 * `httpStatus` is non-optional in the constructor on purpose: every throw site inside `supadataGet`
 * has a `Response` in hand, so a missing status there could only mean someone forgot. The only
 * genuine "no status" case is a rejection that never reached this class at all, and
 * `httpStatusFromError` answers `null` for it.
 */
class BilledSupadataError extends SupadataError {
  readonly billableCredits: number | null;
  readonly httpStatus: number | null;

  constructor(
    body: { error: SupadataError["error"]; message?: string; details?: string },
    billableCredits: number | null,
    httpStatus: number | null,
  ) {
    super(body);
    this.billableCredits = billableCredits;
    this.httpStatus = httpStatus;
  }
}

/** What a thrown error reported billing, when it happens to know. Never a guess: `null` otherwise. */
function billedFromError(error: unknown): number | null {
  return error instanceof BilledSupadataError ? error.billableCredits : null;
}

/**
 * What status a thrown error carries, when it happens to know (D13). Mirrors `billedFromError`
 * exactly, including its direction: anything that is not a `BilledSupadataError` never saw a
 * response — a transport rejection, a DNS failure, an `AbortSignal.timeout` — so `null` here is the
 * truthful "the vendor never answered", not a status we failed to record.
 */
function httpStatusFromError(error: unknown): number | null {
  return error instanceof BilledSupadataError ? error.httpStatus : null;
}

/**
 * `en` is requested deliberately. Two facts, both verified against the live API (2026-07-27, see
 * `../../../context/changes/persist-video-metadata/docs/supadata-transcript-lang.md`):
 *
 * 1. `lang` SELECTS among existing caption tracks — it never asks for a translation. Supadata
 *    translates only through a separate, explicitly-called `/youtube/transcript/translate`.
 * 2. Omitting `lang` does NOT yield the original track. The vendor returns the FIRST track in the
 *    pool, and pool order has nothing to do with which track is the original: an English TED talk
 *    whose 61-track pool begins with `af` returned `af`, and "Me at the zoo" (English) returned `de`.
 *    The reported pool is also request-dependent — the same video reported `{de}` with no `lang` and
 *    `{en, de}` when `en` was requested — so `availableLangs` is not a stable property of a video.
 *
 * So the earlier reasoning here was inverted — omitting `lang` was the exposure, not the protection.
 * Nothing in the vendor's surface marks a track as the original (`/metadata` carries no language
 * field either), so a single preferred code is the only lever available, and `en` is the better bet:
 * informational/educational YouTube is overwhelmingly English-original, and on a Polish video the
 * pool is typically `{pl}` alone, so the request falls through and the fallback returns the Polish
 * original anyway. Requesting `pl` would instead actively select a Polish translation on exactly the
 * large-pool English videos — the case `change.md` forbids.
 *
 * Residual risk: a Polish-original video that also carries an English track hands us the translation.
 * `transcript_lang` / `transcript_available_langs` exist to measure how often that happens.
 * Output language is unaffected either way — Polish comes entirely from the LLM prompt.
 *
 * The optional `meter` records one `transcript` row for this call plus one `transcript_poll` row per
 * job-status call, each carrying what Supadata itself reported billing. Optional so existing call
 * sites compile unchanged.
 */
export async function fetchTranscript(
  { url }: { url: string },
  apiKey: string,
  meter?: SupadataMeter,
): Promise<TranscriptResult> {
  const query = `?url=${encodeURIComponent(url)}&text=true&mode=${TRANSCRIPT_MODE}&lang=${TRANSCRIPT_REQUESTED_LANG}`;

  // The try covers ONLY the initial `/transcript` request. Polling is deliberately outside it: a poll
  // failure is recorded by `pollTranscriptJob` as `transcript_poll/error` and rethrown, and if that
  // rethrow landed in this catch it would write a SECOND `transcript/error` row for an HTTP call that
  // never happened — double-counting the same failure's reported credits. One row per real call.
  let result: TranscriptOrJobId;
  let billableCredits: number | null;
  let httpStatus: number;
  try {
    // Narrowed at the transport boundary rather than cast: a bare cast made `"jobId" in result` a
    // property access on an unvalidated external value, and its throw discarded the header (F4).
    const response = await supadataGet(`/transcript${query}`, apiKey, TRANSCRIPT_TIMEOUT_MS, isTranscriptOrJobId);
    result = response.body;
    billableCredits = response.billableCredits;
    httpStatus = response.httpStatus;
  } catch (error) {
    if (error instanceof SupadataError && error.error === "transcript-unavailable") {
      // Billable despite producing nothing (see supadata-transcript.md §Pricing). This row, now
      // carrying a MEASURED credit figure rather than an assumed one, is the single most valuable
      // thing this ledger captures — and with D13's status, the one row where `outcome` and
      // `http_status` can be checked against each other: the reconciliation formula prices this case
      // at 1 credit on the strength of `outcome` alone, and the recorded 206 is what corroborates it.
      meter?.record({
        operation: "transcript",
        outcome: "unavailable",

        billableCredits: billedFromError(error),
        httpStatus: httpStatusFromError(error),
      });
      return { ok: false, reason: "unavailable" };
    }
    // The failure arm carries the status too. This is the half that is easy to leave unplumbed
    // because the success path looks complete, and it is what will later resolve the OTHER ambiguous
    // null in this ledger: a `billable_credits` of null on an `error` row means "unknown", and the
    // status is the first evidence of which kind of unknown it was.
    meter?.record({
      operation: "transcript",
      outcome: "error",

      billableCredits: billedFromError(error),
      httpStatus: httpStatusFromError(error),
    });
    throw error;
  }

  if ("jobId" in result) {
    // The `202` is recorded here with whatever it reported; whether the charge lands on it or on the
    // polls is exactly the open question the ledger exists to answer, so nothing is assumed either way.
    meter?.record({ operation: "transcript", outcome: "ok", resolvedVia: "job", billableCredits, httpStatus });
    return await pollTranscriptJob(result.jobId, apiKey, meter);
  }

  if (typeof result.content !== "string") {
    meter?.record({ operation: "transcript", outcome: "unavailable", billableCredits, httpStatus });
    return { ok: false, reason: "unavailable" };
  }

  meter?.record({ operation: "transcript", outcome: "ok", resolvedVia: "inline", billableCredits, httpStatus });
  return {
    ok: true,
    content: result.content,
    lang: result.lang,
    availableLangs: result.availableLangs,
    resolvedVia: "inline",
  };
}

/**
 * Polls a Whisper job to completion. Polls are documented FREE, but the header is recorded rather than
 * assumed zero — whether the `202` or the polls carry the charge is precisely what Phase 5 settles.
 * They stay a distinct `operation` either way, so the two are never conflated in the ledger.
 *
 * These arms deliberately do NOT record `httpStatus` (D13). The column exists to corroborate the
 * reconciliation formula's `unavailable → 1 credit` branch, which only ever reads `transcript` rows;
 * `transcript_poll` is a distinct `operation`, so a null here reads as "out of scope", exactly as the
 * column comment in `20260731100000_supadata_call_http_status.sql` documents. Under D1's
 * `mode: "native"` this whole function is unreachable anyway, so plumbing it would add a branch that
 * can never execute to justify itself.
 */
async function pollTranscriptJob(jobId: string, apiKey: string, meter?: SupadataMeter): Promise<TranscriptResult> {
  let interval = JOB_POLL_INITIAL_INTERVAL_MS;

  for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(interval);

    let job: JobResult<Transcript>;
    let billableCredits: number | null;
    try {
      const polled = await supadataGet(
        `/transcript/${encodeURIComponent(jobId)}`,
        apiKey,
        JOB_POLL_TIMEOUT_MS,
        isJobResult,
      );
      job = polled.body;
      billableCredits = polled.billableCredits;
    } catch (error) {
      meter?.record({
        operation: "transcript_poll",
        outcome: "error",

        resolvedVia: "job",
        billableCredits: billedFromError(error),
      });
      throw error;
    }

    if (job.status === "completed") {
      if (job.result && typeof job.result.content === "string") {
        meter?.record({ operation: "transcript_poll", outcome: "ok", resolvedVia: "job", billableCredits });
        return {
          ok: true,
          content: job.result.content,
          lang: job.result.lang,
          availableLangs: job.result.availableLangs,
          resolvedVia: "job",
        };
      }
      // Completed with nothing: the vendor's answer is that there IS no transcript. Durable.
      meter?.record({
        operation: "transcript_poll",
        outcome: "unavailable",

        resolvedVia: "job",
        billableCredits,
      });
      return { ok: false, reason: "unavailable" };
    }

    if (job.status === "failed") {
      // The job broke — that says nothing about whether the video has a transcript, so this must never
      // reach the negative cache.
      meter?.record({
        operation: "transcript_poll",
        outcome: "error",

        resolvedVia: "job",
        billableCredits,
      });
      return { ok: false, reason: "failed" };
    }

    meter?.record({ operation: "transcript_poll", outcome: "ok", resolvedVia: "job", billableCredits });
    interval = Math.min(interval * JOB_POLL_BACKOFF_FACTOR, JOB_POLL_MAX_INTERVAL_MS);
  }

  // Budget exhausted while the job was still running. Transient by construction, and likeliest on the
  // long videos where Whisper runs longest — caching this would lock out exactly the wrong content.
  return { ok: false, reason: "timeout" };
}
