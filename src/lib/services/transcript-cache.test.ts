import { afterEach, beforeEach, describe, it, vi } from "vitest";
import {
  getCachedTranscript,
  saveCachedTranscript,
  type SaveCachedTranscriptParams,
} from "@/lib/services/transcript-cache";
import { expectPromotedEvent, recordReportedEvents } from "@/lib/services/__fixtures__/reporting-recorder";
import { stubFailing, stubRejecting } from "@/lib/services/__fixtures__/supabase-stub";

/**
 * Promotion rows for the shared transcript cache (S-13 Phase 5) — and nothing else. The cache's own
 * read/write behaviour is exercised by the integration layer, which seeds through these same RPCs; what
 * that layer cannot see is whether a SWALLOWED failure still reaches the operator.
 */

const YOUTUBE_ID = "SYNTHETIC01";

const SAVE_PARAMS: SaveCachedTranscriptParams = {
  youtubeId: YOUTUBE_ID,
  content: "a short synthetic transcript",
  outcome: "ok",
  lang: "en",
  availableLangs: ["en"],
  requestedLang: "en",
  resolvedVia: "inline",
  fetchDurationMs: 120,
};

/**
 * Oracle: the plan's Promotion Roster ("a broken cache re-pays both vendors on every request while the
 * app keeps working") and `reporting.ts`'s PERSONAL DATA contract, under which the degradation family
 * carries the failure and no account identifier. Not read off `transcript-cache.ts`.
 *
 * Both functions are total — a failure resolves as a miss or as `duplicateFetch: false` — so a deleted
 * `captureEvent` changes nothing any caller can observe. These rows are the only thing that notices.
 */
describe("operator events — a transcript cache that cannot be read or written", () => {
  const events = recordReportedEvents();

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rows: [key: string, why: string, run: () => Promise<unknown>][] = [
    [
      "[transcript-cache:get-failed]",
      "the read rolled back, so every request for the video pays Supadata again",
      () => getCachedTranscript(stubFailing("synthetic cache read failure").client, YOUTUBE_ID),
    ],
    [
      "[transcript-cache:get-threw]",
      "the read never answered — a different repair from a rolled-back statement",
      () => getCachedTranscript(stubRejecting(new TypeError("fetch failed")).client, YOUTUBE_ID),
    ],
    [
      "[transcript-cache:save-failed]",
      "a paid-for transcript was not kept, so the next user pays for it again",
      () => saveCachedTranscript(stubFailing("synthetic cache write failure").client, SAVE_PARAMS),
    ],
    [
      "[transcript-cache:save-threw]",
      "the write's outcome was never learned",
      () => saveCachedTranscript(stubRejecting(new TypeError("fetch failed")).client, SAVE_PARAMS),
    ],
  ];

  it.each(rows)("%s: %s", async (key, _why, run) => {
    await run();

    expectPromotedEvent(events, { key, severity: "error", fields: ["error"] });
  });
});
