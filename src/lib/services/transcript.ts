import { Supadata, SupadataError } from "@supadata/js";
import type { TranscriptResolvedVia } from "@/types";

export type TranscriptResult =
  | { ok: true; content: string; lang: string; resolvedVia: TranscriptResolvedVia }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchTranscript(
  { url, lang = "pl" }: { url: string; lang?: string },
  apiKey: string,
): Promise<TranscriptResult> {
  const supadata = new Supadata({ apiKey });

  try {
    const result = await supadata.transcript({ url, lang, text: true, mode: "auto" });

    if ("jobId" in result) {
      return await pollTranscriptJob(supadata, result.jobId);
    }

    if (typeof result.content !== "string") {
      return { ok: false, reason: "unavailable" };
    }

    return { ok: true, content: result.content, lang: result.lang, resolvedVia: "inline" };
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
        return { ok: true, content: job.result.content, lang: job.result.lang, resolvedVia: "job" };
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
