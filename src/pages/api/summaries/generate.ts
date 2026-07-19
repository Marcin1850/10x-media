import { z } from "zod";
import type { APIRoute } from "astro";
import { SUPADATA_API_KEY, OPENROUTER_API_KEY } from "astro:env/server";
import { createClient } from "@/lib/supabase";
import { createAdminClient } from "@/lib/supabase-admin";
import { fetchTranscript } from "@/lib/services/transcript";
import { summarize } from "@/lib/services/llm";
import {
  extractYoutubeId,
  upsertVideoAndAppendSummary,
  summaryCost,
  HARD_MAX_TRANSCRIPT_CHARS,
} from "@/lib/services/summaries";
import { getBalance, spendCredit, refundCredits } from "@/lib/services/credits";

export const prerender = false;

const generateSchema = z.object({
  url: z.string().refine((url) => extractYoutubeId(url) !== null, {
    message: "url must be a valid YouTube video URL",
  }),
  character: z.enum(["informational", "educational"]),
});

export const POST: APIRoute = async (context) => {
  if (!SUPADATA_API_KEY || !OPENROUTER_API_KEY) {
    return Response.json({ error: "Transcript/LLM services are not configured" }, { status: 503 });
  }

  if (!context.locals.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: unknown = await context.request.json().catch(() => null);
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { url, character } = parsed.data;
  const youtubeId = extractYoutubeId(url);
  if (!youtubeId) {
    return Response.json({ error: "url must be a valid YouTube video URL" }, { status: 400 });
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return Response.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const userId = context.locals.user.id;

  // Up-front credit gate: read the caller's balance and block at zero *before* any paid Supadata/
  // OpenRouter call. This is a minimum-1 read gate only — the authoritative, race-safe cost gate is
  // the atomic debit below. createClient returns supabase-js's default untyped client; this codebase
  // has no generated Database types yet, so passing it where the service expects its explicit shapes
  // is a real, unavoidable `any` gap (not a fixable unsafe-argument).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const balance = await getBalance(supabase, userId);
  if (balance === null || balance <= 0) {
    return Response.json({ error: "You have no summary credits left" }, { status: 402 });
  }

  // Transcript fetch: a genuine upstream failure (network/Supadata error) throws → clean 502; a
  // resolvable-but-unavailable transcript returns ok:false → 422. Neither has debited a credit yet.
  let transcript: Awaited<ReturnType<typeof fetchTranscript>>;
  try {
    transcript = await fetchTranscript({ url, lang: "pl" }, SUPADATA_API_KEY);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("fetchTranscript failed:", error);
    return Response.json({ error: "The transcript service failed. Please try again." }, { status: 502 });
  }
  if (!transcript.ok) {
    return Response.json({ error: "Transcript unavailable for this video" }, { status: 422 });
  }

  const transcriptLength = transcript.content.length;
  const cost = summaryCost(transcriptLength);

  // Hard-cap gate: reject pathologically long transcripts before any debit or LLM call. This — not
  // summaryCost, which only prices — is what bounds worst-case token cost/latency.
  if (transcriptLength > HARD_MAX_TRANSCRIPT_CHARS) {
    return Response.json({ error: "This video's transcript is too long to summarize." }, { status: 413 });
  }

  // Atomic debit BEFORE the paid LLM call. The RPC's row-level `UPDATE … WHERE balance >= cost` is
  // the concurrency serialization point, so parallel requests sharing one stale balance read cannot
  // all overspend (losers get the -1 sentinel → 402). This debit, not a pre-read compare, is the
  // authoritative cost gate.
  let creditsRemaining: number;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const spend = await spendCredit(supabase, cost);
    if (!spend.ok) {
      return Response.json(
        { error: `You need ${cost} credits for this video; you have ${spend.balance}` },
        { status: 402 },
      );
    }
    creditsRemaining = spend.balance;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("spend_credits failed:", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  // Paid work. On ANY failure past this point the user has been debited, so refund before returning
  // so they are never charged for failed work. refundCredits is best-effort and never throws.
  let summary: Awaited<ReturnType<typeof summarize>>;
  try {
    summary = await summarize({ transcript: transcript.content, character }, OPENROUTER_API_KEY);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("summarize failed:", error);
    await refundCredits(createAdminClient(), userId, cost);
    return Response.json({ error: "The summarization service failed. Please try again." }, { status: 502 });
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const { videoId, summaryId } = await upsertVideoAndAppendSummary(supabase, {
      userId,
      url,
      youtubeId,
      character,
      content: summary.text,
      model: summary.model,
      resolvedVia: transcript.resolvedVia,
    });

    return Response.json({
      summary: summary.text,
      model: summary.model,
      videoId,
      summaryId,
      creditsRemaining,
      cost,
      transcriptLength,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("persist summary failed:", error);
    await refundCredits(createAdminClient(), userId, cost);
    return Response.json({ error: "Something went wrong saving your summary. Please try again." }, { status: 500 });
  }
};
