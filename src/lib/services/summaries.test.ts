import { describe, expect, it } from "vitest";
import { extractYoutubeId, LONG_TRANSCRIPT_CHARS, summaryCost } from "@/lib/services/summaries";

/**
 * Oracle: README §"Summary credits" ("a successful summary spends 1 credit, or 2 credits for a long
 * video generated after the confirmation prompt") and roadmap S-01 (">40k transcript chars ⇒ 2
 * credits"). Every number below comes from those documents, not from `summaries.ts` — which is why
 * the threshold is spelled as the literal 40 000 the docs state rather than read off the exported
 * constant. The constant is pinned separately, so a silent retune of it goes red here.
 */
describe("summaryCost", () => {
  it("prices at the threshold the documented credit rule names", () => {
    expect(LONG_TRANSCRIPT_CHARS).toBe(40_000);
  });

  it.each([
    // [transcript length, credits, what the row proves]
    [1, 1, "an ordinary transcript costs the base credit"],
    [39_999, 1, "just under the documented threshold is still the base credit"],
    // The rule is "LONG ⇒ 2", and 40 000 is not ABOVE 40 000. This boundary is the whole rule: if the
    // comparison ever loosens to >=, a user is charged double at exactly the documented limit.
    [40_000, 1, "exactly the documented threshold is not yet long"],
    [40_001, 2, "the first length above the threshold costs the long-video price"],
    [200_000, 2, "the hard maximum is priced long"],
    // Derived from the rule as written ("long ⇒ 2, else 1"): there is no zero tier, so an empty
    // transcript prices at 1. This DOCUMENTS the hazard at `generate.ts:732-737` — it does not
    // protect against it. The protection is the whitespace guard at `generate.ts:743`, which refuses
    // an empty transcript before anything is priced or debited.
    [0, 1, "an empty transcript still prices at the base credit — the whitespace guard is the protection"],
  ])("charges %i-char transcript %i credit(s): %s", (transcriptLength, credits) => {
    expect(summaryCost(transcriptLength)).toBe(credits);
  });
});

/**
 * Oracle: PRD **FR-003** (a video is added by pasting a YouTube URL) plus PRD Open Question 3, which
 * assigns the concrete validation rule to implementation — so the documented rule is this function's
 * own contract: the host must be exactly `youtu.be`, `youtube.com`, `www.youtube.com`,
 * `m.youtube.com` or `music.youtube.com`; `/watch` reads `?v=`, `/shorts|embed|live/…` read the first
 * path segment, `youtu.be` reads the first non-empty segment; the extracted id must be 11 characters
 * of `[a-zA-Z0-9_-]`; anything `new URL()` cannot parse is not a URL.
 *
 * This is ONE implementation shared by both sides: `GenerateSummaryForm.tsx:11` imports the same
 * function the server's refine calls, so client and server cannot drift on the URL rule today. Worth
 * stating, because the tempting "harden the server side" change would create exactly the drift that
 * does not currently exist.
 *
 * The rejections below are each derived from a property of the rule, not from the code's shape — a
 * look-alike host tests that the check is SET MEMBERSHIP rather than a suffix match, and the
 * credentials form tests that the host is read from `URL.hostname` rather than from the raw string.
 */
const VIDEO_ID = "dQw4w9WgXcQ";

describe("extractYoutubeId — accepted URL shapes", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "the canonical watch URL"],
    ["https://www.youtube.com/watch?app=desktop&v=dQw4w9WgXcQ&t=42s", "a watch URL with the id among other params"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ", "the bare apex host"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "the mobile host"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "the music host"],
    [
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "http is accepted equally with https — the rule is the host, not the scheme",
    ],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "a short"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "an embed"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "a live stream"],
    ["https://youtu.be/dQw4w9WgXcQ", "the share-link host"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "a share link with a timestamp"],
  ])("extracts the video id from %s: %s", (url) => {
    expect(extractYoutubeId(url)).toBe(VIDEO_ID);
  });
});

describe("extractYoutubeId — rejected URLs", () => {
  it.each([
    [
      "https://youtube.com.example.test/watch?v=dQw4w9WgXcQ",
      "a look-alike host: the check is set membership, so a domain merely STARTING with youtube.com is not YouTube",
    ],
    [
      "https://www.youtube.com@example.test/watch?v=dQw4w9WgXcQ",
      "credentials-in-URL: everything before the @ is a userinfo section, and the real host is example.test",
    ],
    ["https://vimeo.com/watch?v=dQw4w9WgXcQ", "a different video platform"],
    ["https://www.youtube.com/playlist?list=PL1234567890", "a YouTube URL that is not a video"],
    ["https://www.youtube.com/watch", "a watch URL with no id at all"],
    ["dQw4w9WgXcQ", "a bare 11-character id with no URL around it — the rule needs a URL"],
    ["https://www.youtube.com/watch?v=short", "an id below 11 characters"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQextra", "an id above 11 characters"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXc!", "an id of the right length carrying an out-of-charset character"],
    ["not a url at all", "a string `new URL()` cannot parse"],
    ["", "an empty string"],
  ])("returns null for %s: %s", (url) => {
    expect(extractYoutubeId(url)).toBeNull();
  });
});
