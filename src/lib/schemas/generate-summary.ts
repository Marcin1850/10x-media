import { z } from "zod";
import { extractYoutubeId } from "@/lib/services/summaries";

/**
 * The trust boundary of `POST /api/summaries/generate`.
 *
 * It lives here rather than inside the endpoint so it can be exercised directly: the endpoint module
 * imports `astro:env/server`, which is unresolvable outside an Astro build, and a boundary nobody can
 * test is a boundary that regresses quietly (see finding F1 below — it already did once).
 *
 * Note what is NOT validated on the client: the form checks only the URL
 * (`GenerateSummaryForm.tsx:67-76`). `character`, `allowLong` and `requestId` are well-formed by
 * construction, never validated, so for those three this schema is the only guard.
 */
export const generateSchema = z.object({
  url: z.string().refine((url) => extractYoutubeId(url) !== null, {
    message: "url must be a valid YouTube video URL",
  }),
  character: z.enum(["informational", "educational"]),
  allowLong: z.boolean().optional().default(false),
  // Identifies ONE user-initiated generation, repeated verbatim when the client retries after an
  // ambiguous failure (request delivered, reply lost). REQUIRED at the boundary: `refuseAndCharge`
  // skips the D14 fee when it has no key, so an optional field would let any caller opt out of the
  // charge by omitting it. A cached pre-F22 client gets a 400 until it reloads — the correct trade,
  // since the only first-party call site has always sent a UUID.
  requestId: z.uuid(),
});

export type GenerateSummaryRequest = z.infer<typeof generateSchema>;
