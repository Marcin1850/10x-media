import { describe, expect, it } from "vitest";
import { LONG_TRANSCRIPT_CHARS, summaryCost } from "@/lib/services/summaries";

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
