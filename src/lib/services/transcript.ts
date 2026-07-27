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

// A video's own caption set is typically 1-3 tracks (the uploader's language, maybe a manual
// translation or two). YouTube's auto-translation feature instead exposes 100+ machine-translated
// tracks off a single source. A threshold around 15 separates the two without firing on a channel
// that publishes a handful of human translations. Explicitly a FIRST GUESS: this is the observational
// half of the open vendor question — whether auto-translated tracks enter Supadata's pool at all —
// and it should be revisited once `transcript_available_langs` has real rows behind it.
const LARGE_LANG_POOL_THRESHOLD = 15;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Flags a caption pool big enough to imply YouTube auto-translation. Diagnostic only — the transcript
 * is used either way, because Supadata gives no way to ask for "the original track" specifically.
 */
function warnOnLargeLangPool(url: string, lang: string, availableLangs: string[]): void {
  if (availableLangs.length > LARGE_LANG_POOL_THRESHOLD) {
    // eslint-disable-next-line no-console
    console.warn(
      `Large caption-language pool for ${url}: returned lang '${lang}', ${availableLangs.length} available languages — possible YouTube auto-translation`,
    );
  }
}

/**
 * `en` is requested deliberately. Two facts, both verified against the live API (2026-07-27, see
 * `../../../context/changes/persist-video-metadata/docs/supadata-transcript-lang.md`):
 *
 * 1. `lang` SELECTS among existing caption tracks — it never asks for a translation. Supadata
 *    translates only through a separate, explicitly-called `/youtube/transcript/translate`.
 * 2. Omitting `lang` does NOT yield the original track. The vendor's "first available language"
 *    default is arbitrary and ignores `availableLangs` order: an English video with pool
 *    `["en","de"]` returned `de`, and an English TED talk with a 61-track pool returned `af`.
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
      return await pollTranscriptJob(supadata, result.jobId, url);
    }

    if (typeof result.content !== "string") {
      return { ok: false, reason: "unavailable" };
    }

    warnOnLargeLangPool(url, result.lang, result.availableLangs);

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

async function pollTranscriptJob(supadata: Supadata, jobId: string, url: string): Promise<TranscriptResult> {
  let interval = JOB_POLL_INITIAL_INTERVAL_MS;

  for (let attempt = 0; attempt < JOB_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(interval);
    const job = await supadata.transcript.getJobStatus(jobId);

    if (job.status === "completed") {
      if (job.result && typeof job.result.content === "string") {
        warnOnLargeLangPool(url, job.result.lang, job.result.availableLangs);
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
