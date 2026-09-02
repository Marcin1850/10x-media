import { describe, expect, it } from "vitest";
import { generateSchema } from "@/lib/schemas/generate-summary";

/**
 * The trust boundary of `POST /api/summaries/generate` (risk #5).
 *
 * Oracle: roadmap S-09 phase 3 finding **F1** (`requestId` must be required), PRD **FR-004** and its
 * Non-Goals (the channel-character set is closed), PRD **FR-003** (the URL must be a YouTube video
 * URL), and the user decision of 2026-08-22 on `allowLong` pre-authorization. None of it is read off
 * the schema.
 *
 * Assertions are on `success` (and on parsed values where a default is the rule), never on Zod's
 * error strings — the copy is not a contract any consumer reads, and pinning it would go red on a
 * library upgrade that changed nothing about what the server accepts.
 *
 * Why this matters at all: the form validates only the URL (`GenerateSummaryForm.tsx:67-76`).
 * `requestId`, `character` and `allowLong` have **no** client-side validation — they are merely
 * well-formed by construction — so for those three the schema is the only guard.
 *
 * **Mutation check** (`npx stryker run --mutate "src/lib/schemas/generate-summary.ts"`, 2026-08-23):
 * 9 killed, 2 survived, both consciously ignored — they empty the `refine`'s `message` (`:16-18`).
 * That is the same error copy the header above says is deliberately not asserted: a caller reads
 * `success`, and a request accepted or refused does not change when the explanation does. Killing
 * them means pinning a string, which is the vibe test this suite exists to avoid.
 */

const VALID_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const VALID_REQUEST_ID = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

describe("generateSchema — requestId (roadmap S-09 phase 3, finding F1)", () => {
  // The headline assertion of this phase. `refuseAndCharge` skips the D14 refusal fee when it has no
  // idempotency key, so an OPTIONAL `requestId` lets any authenticated caller opt out of the charge
  // simply by omitting the field. That regression already shipped once (F1) — this is what pins it.
  it("rejects a body with no requestId", () => {
    const result = generateSchema.safeParse({
      url: VALID_URL,
      character: "informational",
      allowLong: false,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a requestId that is not a UUID", () => {
    const result = generateSchema.safeParse({
      url: VALID_URL,
      character: "informational",
      allowLong: false,
      requestId: "not-a-uuid",
    });

    expect(result.success).toBe(false);
  });

  // Deliberately NOT asserted: that a non-v4 UUID is rejected. Zod 4's `z.uuid()` accepts any RFC
  // 9562/4122 version (v1-v8, verified 2026-08-22), and the field's contract is a stable idempotency
  // identity — which any RFC UUID satisfies. A test demanding v4 would assert a rule no document states.
  it("accepts a well-formed UUID", () => {
    const result = generateSchema.safeParse({
      url: VALID_URL,
      character: "informational",
      allowLong: false,
      requestId: VALID_REQUEST_ID,
    });

    expect(result.success).toBe(true);
  });
});

describe("generateSchema — character (PRD FR-004)", () => {
  // FR-004 names exactly two channel characters and the Non-Goals close the set ("channel character
  // definitions other than informational and educational"). A third value would survive the boundary
  // and reach prompt selection in `summarize()` AFTER the credit has been debited.
  it.each([
    ["informational", true, "the first documented character"],
    ["educational", true, "the second documented character"],
    ["entertainment", false, "a plausible third character the PRD does not define"],
    ["INFORMATIONAL", false, "the right word in the wrong case — the enum is exact"],
    ["", false, "an empty character"],
  ])("parses character %s as accepted=%s: %s", (character, accepted) => {
    const result = generateSchema.safeParse({
      url: VALID_URL,
      character,
      allowLong: false,
      requestId: VALID_REQUEST_ID,
    });

    expect(result.success).toBe(accepted);
  });
});

describe("generateSchema — allowLong", () => {
  // The default direction is the safe one: a body that says nothing about long videos gets the 409
  // consent gate, not a silent 2-credit charge. Asserted on the PARSED VALUE, because "omitted" and
  // "present and false" must be indistinguishable downstream.
  it("defaults a missing allowLong to false, so the long-video consent gate still applies", () => {
    const result = generateSchema.safeParse({
      url: VALID_URL,
      character: "informational",
      requestId: VALID_REQUEST_ID,
    });

    expect(result.success).toBe(true);
    expect(result.data?.allowLong).toBe(false);
  });

  // Pre-authorization BY DESIGN (user decision, 2026-08-22) — not a bypass, so the obvious-looking
  // test here would be a refusal assertion and it would be wrong. The 409 exists to inform a client
  // that does not yet know the price; a client that already consents may say so up front. There is no
  // free ride either way: the atomic debit at `generate.ts:791` (`beginGeneration`) is the
  // authoritative cost gate.
  it("accepts allowLong: true on a first request — pre-authorization, not a bypass", () => {
    const result = generateSchema.safeParse({
      url: VALID_URL,
      character: "informational",
      allowLong: true,
      requestId: VALID_REQUEST_ID,
    });

    expect(result.success).toBe(true);
    expect(result.data?.allowLong).toBe(true);
  });

  it.each([["true"], [1], [null]])("rejects a non-boolean allowLong (%o)", (allowLong) => {
    const result = generateSchema.safeParse({
      url: VALID_URL,
      character: "informational",
      allowLong,
      requestId: VALID_REQUEST_ID,
    });

    expect(result.success).toBe(false);
  });
});

describe("generateSchema — url (PRD FR-003)", () => {
  // FR-003 is "add a video by pasting a YouTube URL", and PRD Open Question 3 assigns the concrete
  // rule to implementation — so the rule IS `extractYoutubeId`'s contract, exercised here only at the
  // boundary. The rule itself is pinned property by property in `summaries.test.ts`; this asserts the
  // wiring, i.e. that the refine is on the field at all.
  it("rejects a URL that is not a YouTube video URL", () => {
    const result = generateSchema.safeParse({
      url: "https://example.test/watch?v=dQw4w9WgXcQ",
      character: "informational",
      allowLong: false,
      requestId: VALID_REQUEST_ID,
    });

    expect(result.success).toBe(false);
  });
});
