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
import { acquireGenerationLock, releaseGenerationLock } from "@/lib/services/generation-lock";

export const prerender = false;

const generateSchema = z.object({
  url: z.string().refine((url) => extractYoutubeId(url) !== null, {
    message: "url must be a valid YouTube video URL",
  }),
  character: z.enum(["informational", "educational"]),
  allowLong: z.boolean().optional().default(false),
});

export const POST: APIRoute = async (context) => {
  if (!SUPADATA_API_KEY || !OPENROUTER_API_KEY) {
    return Response.json({ error: "Transcript/LLM services are not configured" }, { status: 503 });
  }

  // The debit below happens before the paid LLM call, so the refund path is what upholds "failed
  // work never charges the user". Without the service-role key that path cannot run at all, so a
  // failure would silently leave the user charged. Fail here — before any debit — rather than
  // discovering it at compensation time.
  const admin = createAdminClient();
  if (!admin) {
    return Response.json({ error: "Summary generation is not configured" }, { status: 503 });
  }

  if (!context.locals.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: unknown = await context.request.json().catch(() => null);
  const parsed = generateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: z.prettifyError(parsed.error) }, { status: 400 });
  }
  const { url, character, allowLong } = parsed.data;
  const youtubeId = extractYoutubeId(url);
  if (!youtubeId) {
    return Response.json({ error: "url must be a valid YouTube video URL" }, { status: 400 });
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return Response.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  const userId = context.locals.user.id;

  // One generation in flight per user. The read gate below is not a serialization point, so without
  // this every concurrent request would pay for its own transcript fetch before the atomic debit
  // rejected all but the affordable ones. Acquired before the read gate — the paid work starts
  // right after it — and released in the `finally` regardless of how generation exits.
  let locked: boolean;
  try {
    locked = await acquireGenerationLock(admin, userId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("acquireGenerationLock failed:", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
  if (!locked) {
    return Response.json(
      { error: "A summary is already being generated. Wait for it to finish before starting another." },
      { status: 429 },
    );
  }

  try {
    return await runGeneration({
      supabase,
      admin,
      userId,
      url,
      youtubeId,
      character,
      allowLong,
      supadataKey: SUPADATA_API_KEY,
      openrouterKey: OPENROUTER_API_KEY,
    });
  } finally {
    await releaseGenerationLock(admin, userId);
  }
};

interface GenerationInput {
  supabase: NonNullable<ReturnType<typeof createClient>>;
  admin: NonNullable<ReturnType<typeof createAdminClient>>;
  userId: string;
  url: string;
  youtubeId: string;
  character: "informational" | "educational";
  allowLong: boolean;
  /** Passed in rather than re-read from `astro:env`: the POST preflight already proved both non-null. */
  supadataKey: string;
  openrouterKey: string;
}

/**
 * The generation pipeline proper, extracted so the caller can hold the per-user lock across every
 * exit path with a single `try`/`finally` instead of releasing it before each of the many returns.
 */
async function runGeneration({
  supabase,
  admin,
  userId,
  url,
  youtubeId,
  character,
  allowLong,
  supadataKey,
  openrouterKey,
}: GenerationInput): Promise<Response> {
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
    transcript = await fetchTranscript({ url, lang: "pl" }, supadataKey);
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

  // Long-video confirmation gate: a long video (cost > 1) that hasn't been pre-authorized returns a
  // distinct 409 *before* the debit and the LLM call — no spend, no refund needed. The client asks
  // the user to confirm the higher cost and resubmits with `allowLong: true`. A short video always
  // costs 1 and ignores this flag.
  if (cost > 1 && !allowLong) {
    return Response.json(
      {
        error: "This video is long and costs more credits. Confirm to continue.",
        requiresConfirmation: true,
        cost,
        transcriptLength,
      },
      { status: 409 },
    );
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
    summary = await summarize({ transcript: transcript.content, character }, openrouterKey);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("summarize failed:", error);
    await refundCredits(admin, userId, cost);
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
    await refundCredits(admin, userId, cost);
    return Response.json({ error: "Something went wrong saving your summary. Please try again." }, { status: 500 });
  }
}
