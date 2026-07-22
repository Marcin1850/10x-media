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
import { getBalance, reserveCredits, settleReservation, refundReservation } from "@/lib/services/credits";
import { acquireGenerationLease, releaseGenerationLease } from "@/lib/services/generation-lock";
import { recordTranscriptAttempt, getTranscriptQuote, saveTranscriptQuote } from "@/lib/services/transcript-guard";
import type { TranscriptResolvedVia } from "@/types";

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
  //
  // The lease id is what scopes that release to *this* acquisition: if this request stalls past the
  // stale window and is swept, the successor holds a different lease and our release is a no-op,
  // instead of unlocking a generation that is still running.
  let lease: string | null;
  try {
    lease = await acquireGenerationLease(admin, userId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("acquireGenerationLease failed:", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
  if (lease === null) {
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
    await releaseGenerationLease(admin, userId, lease);
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
  let balance: number | null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    balance = await getBalance(supabase, userId);
  } catch (error) {
    // getBalance throws on a DB error. Without this catch the rejection escapes the handler and the
    // framework returns a non-JSON 500, breaking the endpoint's structured-error contract. Return a
    // stable JSON 500 with a generic (non-persistence) message instead — nothing has been saved yet.
    // eslint-disable-next-line no-console
    console.error("getBalance failed:", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
  if (balance === null || balance <= 0) {
    return Response.json({ error: "You have no summary credits left" }, { status: 402 });
  }

  // Transcript acquisition. The paid Supadata fetch is guarded two ways (F17), because the balance
  // gate above is a minimum-1 read and the long-video 409 below returns before any debit: without
  // this a one-credit user could fetch transcript after transcript, sequentially, for free.
  let content: string;
  let resolvedVia: TranscriptResolvedVia | null;

  // A confirmation retry (allowLong) reuses the transcript cached when the 409 was issued — no second
  // paid fetch and no rate-limit token consumed. Best-effort: a miss just falls through to a re-fetch.
  const cachedQuote = allowLong ? await getTranscriptQuote(admin, userId, youtubeId, character) : null;
  if (cachedQuote) {
    content = cachedQuote.content;
    resolvedVia = cachedQuote.resolvedVia;
  } else {
    // A real paid fetch. Rate-limit it first; a genuine RPC failure fails the request CLOSED (500)
    // rather than proceed to the very unbounded fetch this guard exists to prevent.
    let allowed: boolean;
    try {
      allowed = await recordTranscriptAttempt(admin, userId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("recordTranscriptAttempt failed:", error);
      return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }
    if (!allowed) {
      return Response.json(
        { error: "Too many transcript requests. Please wait a moment and try again." },
        { status: 429 },
      );
    }

    // A genuine upstream failure (network/Supadata error) throws → clean 502; a resolvable-but-
    // unavailable transcript returns ok:false → 422. Neither has debited a credit yet.
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
    // A whitespace-only (or empty) transcript is effectively "no transcript": summarizing it would
    // charge a credit for a generic model reply built from nothing. Reject it as unavailable, before
    // any cost is priced or a credit reserved.
    if (transcript.content.trim().length === 0) {
      return Response.json({ error: "Transcript unavailable for this video" }, { status: 422 });
    }
    content = transcript.content;
    resolvedVia = transcript.resolvedVia;
  }

  const transcriptLength = content.length;
  const cost = summaryCost(transcriptLength);

  // Hard-cap gate: reject pathologically long transcripts before any debit or LLM call. This — not
  // summaryCost, which only prices — is what bounds worst-case token cost/latency.
  if (transcriptLength > HARD_MAX_TRANSCRIPT_CHARS) {
    return Response.json({ error: "This video's transcript is too long to summarize." }, { status: 413 });
  }

  // Long-video confirmation gate: a long video (cost > 1) that hasn't been pre-authorized returns a
  // distinct 409 *before* the debit and the LLM call — no spend, no refund needed. The client asks
  // the user to confirm the higher cost and resubmits with `allowLong: true`. A short video always
  // costs 1 and ignores this flag. Cache the transcript first (F17) so that confirmation retry reuses
  // it instead of paying Supadata a second time.
  if (cost > 1 && !allowLong) {
    await saveTranscriptQuote(admin, { userId, youtubeId, character, content, resolvedVia });
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

  // Atomic debit BEFORE the paid LLM call, opened as a reservation. The RPC's row-level
  // `UPDATE … WHERE balance >= cost` is the concurrency serialization point, so parallel requests
  // sharing one stale balance read cannot all overspend (losers get the -1 sentinel → 402). This
  // debit, not a pre-read compare, is the authoritative cost gate.
  //
  // The reservation is what makes the compensation below durable: every exit path past this point
  // must either settle it (success) or refund it (failure). A row left `reserved` is a recorded,
  // recoverable debt rather than a silently charged user.
  let creditsRemaining: number;
  let reservationId: string;
  try {
    // Same untyped-client gap as the getBalance call above: createClient returns supabase-js's
    // default untyped client and this codebase has no generated Database types yet.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const reserved = await reserveCredits(supabase, cost);
    if (!reserved.ok) {
      return Response.json(
        { error: `You need ${cost} credits for this video; you have ${reserved.balance}` },
        { status: 402 },
      );
    }
    creditsRemaining = reserved.balance;
    reservationId = reserved.reservationId;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("reserve_credits failed:", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  // Paid work. On ANY failure past this point the user has been debited, so refund the reservation
  // before returning so they are never charged for failed work. refundReservation is best-effort,
  // never throws, and is idempotent — a retry cannot credit twice.
  let summary: Awaited<ReturnType<typeof summarize>>;
  try {
    summary = await summarize({ transcript: content, character }, openrouterKey);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("summarize failed:", error);
    await refundReservation(admin, userId, reservationId);
    return Response.json({ error: "The summarization service failed. Please try again." }, { status: 502 });
  }

  // Persist alone stays inside the refunding try/catch. Settling deliberately sits OUTSIDE it: a
  // throw from bookkeeping must never reach a catch that refunds a generation the user actually
  // received, which would hand back credits for delivered work.
  let persisted: Awaited<ReturnType<typeof upsertVideoAndAppendSummary>>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    persisted = await upsertVideoAndAppendSummary(supabase, {
      userId,
      url,
      youtubeId,
      character,
      content: summary.text,
      model: summary.model,
      resolvedVia,
      // Durable link so reconciliation can tell this delivered summary apart from failed work if the
      // best-effort settle below is lost — a `reserved` row with a linked summary is settled, not
      // refunded (F16).
      reservationId,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("persist summary failed:", error);
    await refundReservation(admin, userId, reservationId);
    return Response.json({ error: "Something went wrong saving your summary. Please try again." }, { status: 500 });
  }

  // The summary is persisted and the user received the work, so the debit stands. Settling is
  // best-effort bookkeeping that closes the ledger row so reconciliation doesn't later mistake this
  // successful generation for an unresolved debt. A failure here must not fail the response.
  await settleReservation(admin, userId, reservationId);

  return Response.json({
    summary: summary.text,
    model: summary.model,
    videoId: persisted.videoId,
    summaryId: persisted.summaryId,
    creditsRemaining,
    cost,
    transcriptLength,
  });
}
