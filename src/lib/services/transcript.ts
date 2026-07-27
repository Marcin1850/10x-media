import { Supadata, SupadataError } from "@supadata/js";
import type { TranscriptResolvedVia } from "@/types";

export type TranscriptResult =
  | { ok: true; content: string; lang: string; availableLangs: string[]; resolvedVia: TranscriptResolvedVia }
  | { ok: false; reason: "unavailable" };

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 */
export async function fetchTranscript({ url }: { url: string }, apiKey: string): Promise<TranscriptResult> {
  const supadata = new Supadata({ apiKey });

  try {
    const result = await supadata.transcript({ url, text: true, mode: "auto", lang: "en" });

    if ("jobId" in result) {
      return await pollTranscriptJob(supadata, result.jobId);
    }

    if (typeof result.content !== "string") {
      return { ok: false, reason: "unavailable" };
    }

    return {
      ok: true,
      content: result.content,
      lang: result.lang,
      availableLangs: result.availableLangs,
      resolvedVia: "inline",
    };
  } catch (error) {
    if (error instanceof SupadataError && error.error === "transcript-unavailable") {
      return { ok: false, reason: "unavailable" };
    }
    throw error;
  }
}

async function pollTranscriptJob(supadata: Supadata, jobId: string): Promise<TranscriptResult> {
  let interval = JOB_POLL_INITIAL_INTERVAL_MS;

  for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(interval);
    const job = await supadata.transcript.getJobStatus(jobId);

    if (job.status === "completed") {
      if (job.result && typeof job.result.content === "string") {
        return {
          ok: true,
          content: job.result.content,
          lang: job.result.lang,
          availableLangs: job.result.availableLangs,
          resolvedVia: "job",
        };
      }
      return { ok: false, reason: "unavailable" };
    }

    if (job.status === "failed") {
      return { ok: false, reason: "unavailable" };
    }

    interval = Math.min(interval * JOB_POLL_BACKOFF_FACTOR, JOB_POLL_MAX_INTERVAL_MS);
  }

  return { ok: false, reason: "unavailable" };
}
