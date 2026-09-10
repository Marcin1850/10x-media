import { afterEach, beforeEach, describe, it, vi } from "vitest";
import { discardTranscriptQuote, getTranscriptQuote, saveTranscriptQuote } from "@/lib/services/transcript-guard";
import { expectPromotedEvent, recordReportedEvents } from "@/lib/services/__fixtures__/reporting-recorder";
import { stubFailing, stubRejecting } from "@/lib/services/__fixtures__/supabase-stub";

/**
 * Promotion rows for the transcript quote cache (S-13 Phase 5). `recordTranscriptAttempt` throws rather
 * than swallowing, so the rate limiter's event is raised by the endpoint that catches it and is asserted
 * in `generate.int.test.ts`.
 */

const USER_ID = "00000000-0000-4000-8000-000000000001";
const YOUTUBE_ID = "SYNTHETIC01";
const CHARACTER = "educational";

/**
 * Oracle: the plan's Promotion Roster (the guard family's failures are a cache in front of a paid call
 * that silently stops caching) and `reporting.ts`'s PERSONAL DATA contract. Every function here is
 * handed a `userId` and the console lines name the account, so each row also proves the forwarded
 * payload does not — the field set alone cannot see an id interpolated into the error string.
 *
 * All three functions are total, so a deleted `captureEvent` changes nothing a caller can observe.
 */
describe("operator events — a quote cache that cannot be read, written or discarded", () => {
  const events = recordReportedEvents();

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SAVE = {
    userId: USER_ID,
    youtubeId: YOUTUBE_ID,
    character: CHARACTER,
    content: "a short synthetic transcript",
    resolvedVia: null,
    lang: null,
    availableLangs: null,
  };

  const rows: [key: string, why: string, run: () => Promise<unknown>][] = [
    [
      "[transcript-guard:quote-get-failed]",
      "the read rolled back, so the long-video confirmation pays for its transcript twice",
      () => getTranscriptQuote(stubFailing("synthetic quote read failure").client, USER_ID, YOUTUBE_ID, CHARACTER),
    ],
    [
      "[transcript-guard:quote-get-threw]",
      "the read never answered",
      () => getTranscriptQuote(stubRejecting(new TypeError("fetch failed")).client, USER_ID, YOUTUBE_ID, CHARACTER),
    ],
    [
      "[transcript-guard:quote-save-failed]",
      "the quote was never kept, so the confirmation retry will re-fetch",
      () => saveTranscriptQuote(stubFailing("synthetic quote write failure").client, SAVE),
    ],
    [
      "[transcript-guard:quote-save-threw]",
      "the write's outcome was never learned",
      () => saveTranscriptQuote(stubRejecting(new TypeError("fetch failed")).client, SAVE),
    ],
    [
      "[transcript-guard:quote-discard-failed]",
      "a delivered summary's transcript copy outlives its purpose until the TTL",
      () =>
        discardTranscriptQuote(stubFailing("synthetic quote discard failure").client, USER_ID, YOUTUBE_ID, CHARACTER),
    ],
    [
      "[transcript-guard:quote-discard-threw]",
      "the discard's outcome was never learned",
      () => discardTranscriptQuote(stubRejecting(new TypeError("fetch failed")).client, USER_ID, YOUTUBE_ID, CHARACTER),
    ],
  ];

  it.each(rows)("%s: %s", async (key, _why, run) => {
    await run();

    expectPromotedEvent(events, { key, severity: "error", fields: ["error"], withheld: [USER_ID] });
  });
});
