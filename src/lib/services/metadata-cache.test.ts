import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { getCachedMetadata, saveCachedMetadata } from "@/lib/services/metadata-cache";
import { expectPromotedEvent, recordReportedEvents } from "@/lib/services/__fixtures__/reporting-recorder";
import { stubFailing, stubRejecting } from "@/lib/services/__fixtures__/supabase-stub";
import type { VideoMetadata } from "@/types";

/**
 * Promotion rows for the shared metadata cache (S-13 Phase 5) — and nothing else. The cache's read/write
 * behaviour is exercised by the integration layer, which seeds through these same RPCs; what that layer
 * cannot see is whether a SWALLOWED failure still reaches the operator.
 */

const YOUTUBE_ID = "SYNTHETIC01";

const METADATA: VideoMetadata = {
  title: "A synthetic video",
  thumbnailUrl: null,
  channelName: "A synthetic channel",
  channelId: null,
  durationSeconds: 600,
  publishedAt: null,
};

/**
 * Oracle: the plan's Promotion Roster ("a broken cache re-pays both vendors on every request while the
 * app keeps working") and `reporting.ts`'s PERSONAL DATA contract, under which the degradation family
 * carries the failure and no account identifier. Not read off `metadata-cache.ts`.
 *
 * Both functions are total, so a deleted `captureEvent` changes nothing a caller can observe.
 */
describe("operator events — a metadata cache that cannot be read or written", () => {
  const events = recordReportedEvents();

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rows: [key: string, why: string, run: () => Promise<unknown>][] = [
    [
      "[metadata-cache:get-failed]",
      "the read rolled back, so every generation of the video pays for metadata again",
      () => getCachedMetadata(stubFailing("synthetic cache read failure").client, YOUTUBE_ID),
    ],
    [
      "[metadata-cache:get-threw]",
      "the read never answered — a different repair from a rolled-back statement",
      () => getCachedMetadata(stubRejecting(new TypeError("fetch failed")).client, YOUTUBE_ID),
    ],
    [
      "[metadata-cache:save-failed]",
      "a paid-for fetch was not kept, so the next generation pays for it again",
      () => saveCachedMetadata(stubFailing("synthetic cache write failure").client, YOUTUBE_ID, METADATA),
    ],
    [
      "[metadata-cache:save-threw]",
      "the write's outcome was never learned",
      () => saveCachedMetadata(stubRejecting(new TypeError("fetch failed")).client, YOUTUBE_ID, METADATA),
    ],
  ];

  it.each(rows)("%s: %s", async (key, _why, run) => {
    await run();

    expectPromotedEvent(events, { key, severity: "error", fields: ["error"] });
  });
});
