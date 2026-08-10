import { z } from "zod";
import type { APIRoute } from "astro";
import { SUPADATA_API_KEY, OPENROUTER_API_KEY } from "astro:env/server";
import { createClient } from "@/lib/supabase";
import { createAdminClient } from "@/lib/supabase-admin";
import { fetchTranscript, TRANSCRIPT_REQUESTED_LANG } from "@/lib/services/transcript";
import { fetchVideoMetadata } from "@/lib/services/metadata";
import { createSupadataMeter, flushSupadataCalls, type SupadataMeter } from "@/lib/services/supadata-ledger";
import { getCachedTranscript, saveCachedTranscript } from "@/lib/services/transcript-cache";
import { getCachedMetadata, saveCachedMetadata } from "@/lib/services/metadata-cache";
import {
  reserveBudget,
  settleBudget,
  TRANSCRIPT_BUDGET_CREDITS,
  METADATA_BUDGET_CREDITS,
} from "@/lib/services/supadata-budget";
import { summarize } from "@/lib/services/llm";
import {
  extractYoutubeId,
  persistSummaryAndSettle,
  summaryCost,
  HARD_MAX_TRANSCRIPT_CHARS,
} from "@/lib/services/summaries";
import {
  getBalance,
  beginGeneration,
  refundReservation,
  chargeFailedTranscript,
  lookupRefusalReplay,
  type RefusalReason,
} from "@/lib/services/credits";
import { acquireGenerationLease, releaseGenerationLease } from "@/lib/services/generation-lock";
import {
  recordTranscriptAttempt,
  getTranscriptQuote,
  saveTranscriptQuote,
  discardTranscriptQuote,
} from "@/lib/services/transcript-guard";
import type { MetadataVia, TranscriptResolvedVia } from "@/types";

export const prerender = false;

/**
 * The two strings behind this endpoint's 422 (S-09 D3).
 *
 * Under `TRANSCRIPT_MODE = 'native'` (D1) "this video has no caption track" stops being a rare
 * accident and becomes the predictable, DURABLE answer for a whole class of videos — so it earns copy
 * that names the cause and points the user at an action that works (pick another video) rather than a
 * retry that almost certainly will not. Durable is not permanent: `unavailable` is negative-cached for
 * only 2 h (D4), because captions can be added to a video later, so the same URL can legitimately
 * succeed on a later submit. Everything else answering 422 keeps the generic string, because it means
 * something genuinely different:
 *
 *   NO_CAPTIONS — the vendor says this video has no transcript, from a fresh fetch or from an
 *                 `'unavailable'` cache row. Durable, and the user can act on it (pick another video).
 *   GENERIC     — an `'empty'` cache row (a vendor SUCCESS on a wordless video), a whitespace-only
 *                 transcript, and the transient `failed`/`timeout` fetch outcomes. Different causes,
 *                 none of them "there are no captions", and some of which DO succeed on a retry.
 *
 * The status is 422 in every case; only the body differs. `useGenerateSummary`'s `messageForStatus`
 * (`src/components/hooks/useGenerateSummary.ts`) prefers the server's string for 422 precisely so
 * this distinction survives the trip to the user — it used to hardcode one message and drop both of
 * these.
 */
const TRANSCRIPT_NO_CAPTIONS_ERROR =
  "This video has no captions, so there is nothing to summarize. We can only summarize videos that have a caption track — try another video.";
const TRANSCRIPT_UNAVAILABLE_ERROR = "Transcript unavailable for this video";

/**
 * The 422 body each CHARGEABLE refusal answers with (S-09 D14).
 *
 * A map rather than a string passed alongside the classification, because the two must not be able to
 * drift: `refuseAndCharge` picks the copy from the reason it stores, and a repeated `requestId`
 * reconstructs the copy from the reason it reads back out of the ledger. Two independent choices would
 * surface as a retry answering with different words than the original — the one failure this phase's
 * replay contract exists to prevent, and one that no balance assertion would catch.
 *
 * Note the shape mirrors D3, not D14: `'unavailable'` gets the caption-specific copy; `'empty'` and
 * `'whitespace'` share the generic string because "a transcript arrived and holds no words" is a
 * different claim from "this video has no caption track". Charging and copy are separate axes.
 */
const REFUSAL_COPY: Record<RefusalReason, string> = {
  unavailable: TRANSCRIPT_NO_CAPTIONS_ERROR,
  empty: TRANSCRIPT_UNAVAILABLE_ERROR,
  whitespace: TRANSCRIPT_UNAVAILABLE_ERROR,
};

/**
 * What an unusable submission costs the user (D14). One credit, flat — not `summaryCost`, which prices
 * DELIVERED work and stays S-05's (a long video that turns out to have no captions is refused just as
 * cheaply as a short one, because nothing was summarized either way).
 */
const REFUSAL_CHARGE = 1;

/**
 * The 503 a tripped budget breaker answers with (S-09 lever C).
 *
 * Operator-shaped on purpose: the user did nothing wrong and there is nothing they can fix, so the
 * copy says the service cannot process NEW videos right now and that this is temporary — not a
 * generic failure they will read as their own. 503 is both honest (the service genuinely cannot do the
 * work) and already this endpoint's "generation is unavailable" status, so the client needs no new
 * branch — but it did need to stop discarding the server's string, which is the one client change in
 * this phase.
 */
const BUDGET_EXHAUSTED_ERROR =
  "We've reached our transcript service limit for now, so new videos can't be processed. Please try again in a while.";

const generateSchema = z.object({
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
  const { url, character, allowLong, requestId } = parsed.data;
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

  // One meter per request, flushed once below. Spend on a request that never persists a summary is
  // precisely what columns on `summaries` structurally cannot record, so the meter's lifetime is the
  // REQUEST's, not the summary's.
  const meter = createSupadataMeter();

  try {
    return await runGeneration({
      supabase,
      admin,
      userId,
      url,
      youtubeId,
      character,
      allowLong,
      requestId,
      supadataKey: SUPADATA_API_KEY,
      openrouterKey: OPENROUTER_API_KEY,
      meter,
    });
  } finally {
    // The `finally` IS the contract: the 422, 413, 409, 502 and every 500 must all flush, because
    // those are the requests whose spend a summary-shaped design would lose. flushSupadataCalls never
    // throws — a lost ledger row is a lost measurement, not a failed generation, and a rejection here
    // would replace an already-decided response.
    await flushSupadataCalls(admin, { userId, youtubeId }, meter);
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
  /**
   * Client-owned identity for ONE generation, repeated on retry. The POST schema now requires it, so
   * `null` is unreachable from the endpoint; the type stays nullable because the null-tolerant paths
   * below are the safety net that keeps a keyless call from being charged non-idempotently.
   */
  requestId: string | null;
  /** Passed in rather than re-read from `astro:env`: the POST preflight already proved both non-null. */
  supadataKey: string;
  openrouterKey: string;
  /** Collects one record per real Supadata HTTP call. Owned and flushed by `POST`, on every exit. */
  meter: SupadataMeter;
}

/**
 * The 422 a chargeable refusal answers with. Built from the classification alone, so the original
 * refusal and its replay can never answer with different copy.
 */
function refusalResponse(reason: RefusalReason): Response {
  return Response.json({ error: REFUSAL_COPY[reason] }, { status: 422 });
}

/**
 * Refuses an unusable submission AND bills the user one credit for it (S-09 D14).
 *
 * Four of this endpoint's five 422 exits come through here; the transient `failed`/`timeout` one
 * deliberately does not. The rule is drawn around what the user submitted, not around what we happened
 * to pay: a video with no usable transcript is an unusable submission whether the answer came from a
 * paid 206 or from the negative cache, while a transient fetch failure is our outage or the vendor's
 * and its real cost is *unknown* (an `error` reports no `x-billable-requests` header).
 *
 * **The cache-hit charge is the one place in this slice where we take a credit having paid nothing**,
 * and it is deliberate. The alternative — free inside D4's 2 h window, charged outside it — makes the
 * same action cost differently depending on state the user cannot see, and rewards rapid resubmission
 * of exactly the videos that window exists to re-check.
 *
 * The charge is fired and its outcome ignored for response purposes: `chargeFailedTranscript` never
 * throws, and a failure to bill costs the operator one credit while the user still gets the answer
 * they were owed. The response is unchanged from before this phase — same status, same string, no
 * balance field (D14, the user's explicit call that this ships silently).
 *
 * A `null` requestId SKIPS the charge rather than inventing a key. See the service: a generated key
 * would make the fee non-idempotent across exactly the retries `requestId` exists to absorb, and a
 * refused submit is a plausible thing for a client to retry. The POST schema requires the field, so
 * that branch is a safety net, not a supported client shape — omitting the key buys a 400, not a free
 * refusal.
 */
async function refuseAndCharge(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  userId: string,
  requestId: string | null,
  reason: RefusalReason,
): Promise<Response> {
  if (requestId !== null) {
    await chargeFailedTranscript(admin, {
      userId,
      requestId,
      amount: REFUSAL_CHARGE,
      refusalReason: reason,
    });
  }
  return refusalResponse(reason);
}

/**
 * Turns the three "this request key is not new" outcomes into their response, or `null` when the
 * caller should carry on generating (F22). Shared by the probe and the debit, which ask the same
 * question at different points, so a repeat request gets the same answer whichever one catches it.
 *
 * `replay` is a 200: the first attempt succeeded and was paid for, so the retry must end where that
 * attempt ended — same summary, same ids, no second charge and no second OpenRouter call. It carries
 * no `transcriptLength`; that is a property of the fetch, not of the saved summary, and the client
 * only uses it on the long-video confirmation path.
 *
 * Async since D14, for the `unavailable` branch alone — see there.
 */
async function respondToRepeatedRequest(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  userId: string,
  requestId: string | null,
  result: Awaited<ReturnType<typeof beginGeneration>>,
): Promise<Response | null> {
  switch (result.outcome) {
    case "replay":
      return Response.json({
        summary: result.content,
        model: result.model,
        videoId: result.videoId,
        summaryId: result.summaryId,
        creditsRemaining: result.balance,
        cost: result.cost,
      });
    case "inProgress":
      // Backstops the per-user generation lease: the lease can be released by a stale sweep while the
      // original attempt is still running, and it does not span Worker isolates the way the ledger does.
      return Response.json(
        { error: "This summary is already being generated. Wait for it to finish." },
        { status: 429 },
      );
    case "unavailable": {
      // The key's debit was closed without a summary. TWO things now produce that shape, and telling
      // them apart is the non-obvious half of D14.
      //
      // A refusal charge writes a settled, summary-less row — and the probe that reaches this branch
      // runs BEFORE any transcript work, so it catches the retry of a refused submit ahead of the 422
      // that refused it. Answering 409 there would silently lose the caption-specific copy D3 exists to
      // deliver, on exactly the videos it was written for. `refusal_reason` is what distinguishes the
      // two, and the replay reconstructs the original body from it.
      //
      // A null reason is load-bearing, not a fallback: an operator-side settle_reservation() leaves the
      // same shape with no reason, and that row keeps the 409 below, which is the case its wording
      // describes. `lookupRefusalReplay` also returns null on any error — failing toward the existing
      // reply is right for a lookup whose only job is to improve one.
      const reason = requestId === null ? null : await lookupRefusalReplay(admin, { userId, requestId });
      if (reason !== null) return refusalResponse(reason);

      // Neither replayable nor safe to re-run against a closed charge; the client must start over.
      return Response.json({ error: "This request was already processed. Start a new generation." }, { status: 409 });
    }
    default:
      return null;
  }
}

/**
 * Writes one freshly fetched outcome into the shared cache and reports a duplicate fetch if the write
 * found one.
 *
 * `saveCachedTranscript` detects the collision as a side effect of the upsert it already performs: it
 * returns `true` when the row it overwrote was written AFTER our fetch started, which is only possible
 * if another request paid for the same video while ours was in flight. Concurrent cold misses are
 * accepted, not prevented — the generation lease is keyed per user by construction and cannot
 * coordinate two users on one video — but they are MEASURED rather than assumed rare, and counting
 * these lines is the decision input for whether a video-scoped single-flight lease is ever worth its
 * distributed-state machinery.
 *
 * `console.warn`, not `console.error`: nothing failed and no user is affected. A duplicate fetch means
 * the operator paid twice for one transcript — a cost signal, not an incident. It is deliberately kept
 * out of the catch paths so it can never be confused with a failure.
 *
 * The prefix is a stable search key. `observability.enabled` is already on, so Workers retains the
 * line and it can be counted per `youtubeId` today; if an error reporter is added later, this is the
 * single call site to upgrade to a warning-level event. DO NOT REWORD IT.
 */
async function cacheTranscriptOutcome(
  admin: NonNullable<ReturnType<typeof createAdminClient>>,
  userId: string,
  youtubeId: string,
  fetchMs: number,
  outcome: {
    content: string;
    outcome: "ok" | "empty" | "unavailable" | "too_long";
    contentChars?: number | null;
    lang: string | null;
    availableLangs: string[] | null;
    resolvedVia: "inline" | "job" | null;
  },
): Promise<void> {
  const { duplicateFetch } = await saveCachedTranscript(admin, {
    youtubeId,
    ...outcome,
    requestedLang: TRANSCRIPT_REQUESTED_LANG,
    fetchDurationMs: fetchMs,
  });

  if (duplicateFetch) {
    // eslint-disable-next-line no-console
    console.warn(`[duplicate-transcript-fetch] youtubeId=${youtubeId} fetchMs=${fetchMs} userId=${userId}`);
  }
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
  requestId,
  supadataKey,
  openrouterKey,
  meter,
}: GenerationInput): Promise<Response> {
  // `generation_ms` starts here and is frozen immediately before the persist call — see the comment
  // at that call site for why the boundary is forced rather than chosen.
  const generationStartedAt = Date.now();

  // Idempotency probe (F22). A retry after an ambiguous failure — request delivered, reply lost —
  // repeats the same request key, and this is where that repeat ends. Run BEFORE the paid transcript
  // fetch: the endpoint cannot price the work until it has the transcript, so waiting until the debit
  // below to notice a replay would pay Supadata for a transcript it is about to discard. Nothing is
  // charged here; the debit call further down re-asks the same question atomically and is what
  // actually decides.
  if (requestId !== null) {
    let probe: Awaited<ReturnType<typeof beginGeneration>>;
    try {
      probe = await beginGeneration(admin, { userId, requestId, amount: null });
    } catch (error) {
      // Fail closed. Proceeding on an unknown idempotency state is precisely the double-charge this
      // guard exists to prevent, and nothing has been debited or fetched yet.
      // eslint-disable-next-line no-console
      console.error("begin_generation probe failed:", error);
      return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }

    const settled = await respondToRepeatedRequest(admin, userId, requestId, probe);
    if (settled) return settled;
  }

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
  // Diagnostic only (S-08): which caption track Supadata actually returned, and the pool it came
  // from. Never rendered — a "language" label would be false exactly when auto-translated tracks
  // are in play, which is the very question these columns exist to answer from real traffic.
  let transcriptLang: string | null;
  let transcriptAvailableLangs: string[] | null;

  // Brackets whatever produced the transcript — the fetch, the quote read, or the shared-cache read.
  // A `'stored'` row therefore legitimately reads near zero, and `resolved_via` is what explains why.
  const transcriptStartedAt = Date.now();

  // Frozen inside each branch, the moment the transcript is IN HAND, and never recomputed afterwards.
  // Taking it once below the branches instead would fold the cache-write RPC into the measurement —
  // the column would then read as "time to source the transcript AND store it", which is neither what
  // the plan specifies nor comparable across the three sources, since only the fetch path writes.
  let transcriptMs: number;

  // A confirmation retry (allowLong) reuses the transcript cached when the 409 was issued — no second
  // paid fetch and no rate-limit token consumed. Best-effort: a miss just falls through to a re-fetch.
  const cachedQuote = allowLong ? await getTranscriptQuote(admin, userId, youtubeId, character) : null;

  // The shared cache (S-07), read AFTER the per-user quote check and BEFORE the rate limit: a hit
  // makes no paid call, so it must consume no rate-limit token. Unlike the quote cache this is keyed
  // by video alone, so it is reused across characters AND across users.
  const cachedTranscript = cachedQuote ? null : await getCachedTranscript(admin, youtubeId);

  // The metadata cache (S-09 D6/D7), looked up HERE — beside the transcript lookup and far from the
  // fetch it serves. The FETCH does not move (D7): the comment block at that call site documents its
  // placement as load-bearing for three reasons, and none of them apply to a free database read.
  //
  // After the 402 gate rather than at the endpoint entrance, on its own merits as well as by the
  // plan: a user with no credits should not trigger even a free read. It still lands well before the
  // debit, which is all Phase 6's second breaker check point needs.
  //
  // Hoisting the LOOKUP is the whole saving. On a warm video the transcript already costs 0, so this
  // one call was 100% of a repeat generation's Supadata spend.
  const metadataLookupStartedAt = Date.now();
  const cachedMetadata = await getCachedMetadata(admin, youtubeId);
  // Measured where the work happens, not where the variable is declared. This bracket times a
  // database read; on a MISS the fetch below overwrites it with the HTTP call's duration. That is
  // precisely the difference `metadata_via` exists to disambiguate — a `'stored'` row reporting ~0 ms
  // is correct, not a broken measurement.
  let metadataMs = Date.now() - metadataLookupStartedAt;

  if (cachedQuote) {
    content = cachedQuote.content;
    resolvedVia = cachedQuote.resolvedVia;
    // The quote cache carries both language fields (F10), so a confirmation resubmit persists the
    // same values the original fetch saw. These stay null only for a row written by a pre-F10 Worker.
    // This path used to hardcode null, which biased the columns against long videos specifically —
    // the 409/confirm/cache route is reachable only above 40,000 characters.
    transcriptLang = cachedQuote.lang;
    transcriptAvailableLangs = cachedQuote.availableLangs;
    transcriptMs = Date.now() - transcriptStartedAt;
  } else if (cachedTranscript) {
    // A negative hit answers for free what the fetch would have charged for. `'empty'` and
    // `'unavailable'` both answer 422, and they are cached on different windows, which the RPC has
    // already applied by the time a row comes back at all.
    //
    // They no longer share COPY, though (D3). `'unavailable'` is the vendor saying this video has no
    // caption track — permanent under `native`, and worth telling the user in those words. `'empty'`
    // is a vendor SUCCESS on a video that has captions containing no words (an instrumental piece),
    // which is a different fact and must not be reported as a missing caption track.
    //
    // A `'too_long'` row is the 413 answer itself, cached. It holds no body by design (F6), so it is
    // answered here rather than falling through to the hard-cap gate below, which reads `content`.
    if (cachedTranscript.outcome === "too_long") {
      return Response.json({ error: "This video's transcript is too long to summarize." }, { status: 413 });
    }
    //
    // Both negative outcomes CHARGE (D14), and this is the pair where the operator paid nothing —
    // see `refuseAndCharge` for why a flat rule beats one that depends on the cache window.
    if (cachedTranscript.outcome === "unavailable") {
      return await refuseAndCharge(admin, userId, requestId, "unavailable");
    }
    if (cachedTranscript.outcome !== "ok") {
      return await refuseAndCharge(admin, userId, requestId, "empty");
    }
    content = cachedTranscript.content;
    // NOT the original fetch's mechanism: this request made no Supadata call, and recording `'inline'`
    // or `'job'` here would claim a fetch that never happened. `'stored'` is what distinguishes a paid
    // fetch from a reuse, which is the whole point of widening the column.
    resolvedVia = "stored";
    transcriptLang = cachedTranscript.lang;
    transcriptAvailableLangs = cachedTranscript.availableLangs;
    transcriptMs = Date.now() - transcriptStartedAt;
  } else {
    // A real paid fetch, and the first of this endpoint's two budget check points (S-09 lever C).
    //
    // Placed inside the MISS branch and nowhere near the endpoint entrance: the breaker gates SPEND,
    // not the request (D5). A cache hit costs 0, and blocking it would break the product for no saving.
    //
    // And placed BEFORE recordTranscriptAttempt, not after it. That RPC records a paid-fetch attempt
    // against a ten-attempt window, so ordering the budget check behind it would let a run of budget
    // refusals — which make no Supadata call at all — burn a user's transcript allowance for work that
    // never happened. Reserve first; record the attempt only once the reservation is in hand and the
    // real fetch is about to run.
    //
    // `untracked` is a THIRD case and is deliberately not collapsed into either neighbour: it means we
    // could not track this call, so the fetch goes ahead and NOTHING is settled — there is no id, and a
    // settle against a missing row is the one corruption the sweep cannot detect.
    const transcriptBudget = await reserveBudget(admin, supadataKey, TRANSCRIPT_BUDGET_CREDITS);
    if (transcriptBudget.outcome === "refused") {
      return Response.json({ error: BUDGET_EXHAUSTED_ERROR }, { status: 503 });
    }

    /**
     * Closes the reservation on the exits BETWEEN acquiring it and reaching the fetch's `finally`.
     *
     * Reserving before the rate limiter is deliberate (see above), and it opens a gap the `finally`
     * below cannot cover: the rate-limit guard can return 500 or 429 while a live reservation is
     * held, and NO Supadata call has happened on either path. Leaving those rows to the 600 s sweep
     * holds a credit against the WHOLE FLEET for ten minutes per rejected request, so a burst of
     * rate-limited traffic manufactures budget exhaustion out of calls that never cost anything —
     * the breaker refusing paid work on the strength of spend that does not exist.
     *
     * Settled at 0, not deleted: 0 is a KNOWN figure here, not the "unknown" that `null` means and
     * that the outstanding total charges at the reserved maximum. Nothing was requested, so nothing
     * could be billed. Every exit after this point is covered by the `finally`.
     */
    const releaseUnspentTranscriptBudget = async (): Promise<void> => {
      if (transcriptBudget.outcome === "reserved") {
        await settleBudget(admin, transcriptBudget.reservationId, 0);
      }
    };

    // Rate-limit it next; a genuine RPC failure fails the request CLOSED (500)
    // rather than proceed to the very unbounded fetch this guard exists to prevent.
    let allowed: boolean;
    try {
      allowed = await recordTranscriptAttempt(admin, userId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("recordTranscriptAttempt failed:", error);
      await releaseUnspentTranscriptBudget();
      return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
    }
    if (!allowed) {
      await releaseUnspentTranscriptBudget();
      return Response.json(
        { error: "Too many transcript requests. Please wait a moment and try again." },
        { status: 429 },
      );
    }

    // A genuine upstream failure (network/Supadata error) throws → clean 502; a resolvable-but-
    // unavailable transcript returns ok:false → 422. Neither has debited a credit yet.
    //
    // The checkpoint is taken immediately BEFORE the guarded call and read back in the `finally`:
    // neither provider function returns what the vendor billed, but every per-attempt figure is
    // already in the meter, and `billedSince` reads that window without draining rows POST.finally
    // still has to flush.
    let transcript: Awaited<ReturnType<typeof fetchTranscript>>;
    const transcriptBudgetMark = meter.checkpoint();
    try {
      transcript = await fetchTranscript({ url }, supadataKey, meter);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("fetchTranscript failed:", error);
      return Response.json({ error: "The transcript service failed. Please try again." }, { status: 502 });
    } finally {
      // A `finally` OBLIGATION, not a happy-path step, for the same reason the meter flush lives in
      // POST.finally: a reservation that is never settled is a credit the whole fleet keeps believing
      // is spent until the sweep window elapses — and the error paths are exactly the ones a budget
      // guard exists to survive. Reachable only from the `reserved` branch; an `untracked` call has no
      // id to settle.
      if (transcriptBudget.outcome === "reserved") {
        await settleBudget(
          admin,
          transcriptBudget.reservationId,
          meter.billedSince(transcriptBudgetMark, "transcript"),
        );
      }
    }

    // Cache immediately, BEFORE the long-video 409 below can return: a user who abandons the
    // confirmation has still paid Supadata, and caching first is what makes that money buy something.
    // Every BILLABLE outcome is cached, not just the useful one — but `failed` and `timeout` never
    // are, because they are transient by construction and say nothing durable about the video.
    // The ONE measurement of the paid fetch: persisted on the summary row and handed to the cache as
    // `fetchDurationMs`, so the two can never disagree about how long the same fetch took.
    transcriptMs = Date.now() - transcriptStartedAt;
    if (!transcript.ok) {
      if (transcript.reason === "unavailable") {
        await cacheTranscriptOutcome(admin, userId, youtubeId, transcriptMs, {
          content: "",
          outcome: "unavailable",
          lang: null,
          availableLangs: null,
          resolvedVia: null,
        });
        // The one durable reason, and the only one that earns the specific copy (D3): the vendor says
        // this video has no caption track, and under `native` nothing will ever produce one.
        // `failed`/`timeout` fall through to the generic string below — they are transient by
        // construction, say nothing about the video, and a retry genuinely may work.
        //
        // The canonical charging case (D14): this is the 206 we just paid a Supadata credit for.
        return await refuseAndCharge(admin, userId, requestId, "unavailable");
      }
      // The ONE exempt 422. `failed`/`timeout` is our outage or the vendor's, and an `error` with a
      // null billable header means the operator's cost is *unknown* — charging here would resolve our
      // own ambiguity against a user who did nothing wrong. It branches on the same `reason` the copy
      // branches on, so the two decisions stay visibly aligned in one place.
      return Response.json({ error: TRANSCRIPT_UNAVAILABLE_ERROR }, { status: 422 });
    }

    // Past the hard cap the BODY is not cached — only the verdict (F6). Storing it would put rows in
    // `transcript_cache` that exceed the 200k bound the table promises, to be re-read in full on every
    // later hit and thrown away for the same 413. Caching the verdict still spares the second attempt
    // the paid fetch, which is the whole point of the cache; `content_chars` keeps the measurement.
    // Written here, ahead of the generic gate below, because that gate runs after the body would
    // already have been stored.
    if (transcript.content.length > HARD_MAX_TRANSCRIPT_CHARS) {
      await cacheTranscriptOutcome(admin, userId, youtubeId, transcriptMs, {
        content: "",
        outcome: "too_long",
        contentChars: transcript.content.length,
        lang: transcript.lang,
        availableLangs: transcript.availableLangs,
        resolvedVia: transcript.resolvedVia,
      });
      return Response.json({ error: "This video's transcript is too long to summarize." }, { status: 413 });
    }

    await cacheTranscriptOutcome(admin, userId, youtubeId, transcriptMs, {
      content: transcript.content,
      // A vendor SUCCESS carrying no words. Recorded separately from `unavailable` so the ledger's
      // analytics keeps the distinction between "we were told there is nothing" and "we were given
      // nothing" — and so it earns the full 30-day window, since a wordless video stays wordless.
      outcome: transcript.content.trim().length === 0 ? "empty" : "ok",
      lang: transcript.lang,
      availableLangs: transcript.availableLangs,
      resolvedVia: transcript.resolvedVia,
    });

    content = transcript.content;
    resolvedVia = transcript.resolvedVia;
    transcriptLang = transcript.lang;
    transcriptAvailableLangs = transcript.availableLangs;
  }

  // A whitespace-only (or empty) transcript is effectively "no transcript": summarizing it would
  // charge a credit for a generic model reply built from nothing. Reject it as unavailable, before
  // any cost is priced or a credit reserved.
  //
  // HOISTED out of the fetch branch (S-07), and load-bearing rather than tidy. `summaryCost(0)`
  // returns 1, so an empty transcript reaching the main path clears the 413 and the 409, DEBITS a
  // credit, and sends nothing to the LLM. The quote cache was safe from that only by accident —
  // `saveTranscriptQuote` runs downstream of this guard, so it can never hold an empty — while the
  // shared cache is written straight after the fetch and therefore can. Covering all three sources
  // here is also what makes the `'empty'` cache hit above safe to write as a plain early 422.
  //
  // Keeps the GENERIC copy (D3): a transcript arrived and it happens to hold no words, which is not
  // the same claim as "this video has no caption track" and must not be reported as one. It still
  // CHARGES (D14): an unusable submission is an unusable submission whichever of the three sources
  // above produced it.
  if (content.trim().length === 0) {
    return await refuseAndCharge(admin, userId, requestId, "whitespace");
  }

  const transcriptLength = content.length;
  const cost = summaryCost(transcriptLength);

  // Hard-cap gate: reject pathologically long transcripts before any debit or LLM call. This — not
  // summaryCost, which only prices — is what bounds worst-case token cost/latency.
  //
  // The fetch branch now applies this cap earlier, so it can cache the verdict instead of the body
  // (F6). This one is NOT redundant: it still covers the quote-cache path and any `'ok'` cache row
  // written before that change, whose body can exceed the cap.
  if (transcriptLength > HARD_MAX_TRANSCRIPT_CHARS) {
    return Response.json({ error: "This video's transcript is too long to summarize." }, { status: 413 });
  }

  // Long-video confirmation gate: a long video (cost > 1) that hasn't been pre-authorized returns a
  // distinct 409 *before* the debit and the LLM call — no spend, no refund needed. The client asks
  // the user to confirm the higher cost and resubmits with `allowLong: true`. A short video always
  // costs 1 and ignores this flag. Cache the transcript first (F17) so that confirmation retry reuses
  // it instead of paying Supadata a second time.
  if (cost > 1 && !allowLong) {
    // `allowLong` is false here, so the cache branch above did not run and these came from the fetch.
    await saveTranscriptQuote(admin, {
      userId,
      youtubeId,
      character,
      content,
      resolvedVia,
      lang: transcriptLang,
      availableLangs: transcriptAvailableLangs,
    });
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
  // sharing one stale balance read cannot all overspend (losers get `insufficient` → 402). This
  // debit, not a pre-read compare, is the authoritative cost gate.
  //
  // The reservation is what makes the compensation below durable: every exit path past this point
  // must either settle it (success) or refund it (failure). A row left `reserved` is a recorded,
  // recoverable debt rather than a silently charged user.
  //
  // It also CLAIMS the request key in the same transaction (F22), which is what makes the identity
  // check race-safe: the probe above is an early-exit optimisation on a stale read, so two concurrent
  // duplicates can both pass it. Only one can leave here with a debit — the other blocks on the row
  // lock and comes back as `replay`/`in_progress`. A null key skips deduplication entirely, matching
  // the pre-F22 behaviour for a cached client.
  let creditsRemaining: number;
  let reservationId: string;
  try {
    const reserved = await beginGeneration(admin, { userId, requestId, amount: cost });

    const settled = await respondToRepeatedRequest(admin, userId, requestId, reserved);
    if (settled) return settled;

    if (reserved.outcome === "insufficient") {
      return Response.json(
        { error: `You need ${cost} credits for this video; you have ${reserved.balance}` },
        { status: 402 },
      );
    }
    // `fresh` is a probe-only outcome and cannot come back from a debiting call; treating it as an
    // error keeps the exhaustive narrowing honest instead of silently generating without a debit.
    if (reserved.outcome !== "reserved") {
      throw new Error(`begin_generation returned '${reserved.outcome}' for a debiting call`);
    }
    creditsRemaining = reserved.balance;
    reservationId = reserved.reservationId;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("begin_generation failed:", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  // Paid work. On ANY failure past this point the user has been debited, so refund the reservation
  // before returning so they are never charged for failed work. refundReservation is best-effort,
  // never throws, and is idempotent — a retry cannot credit twice.
  let summary: Awaited<ReturnType<typeof summarize>>;
  const llmStartedAt = Date.now();
  try {
    summary = await summarize({ transcript: content, character }, openrouterKey);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("summarize failed:", error);
    await refundReservation(admin, userId, reservationId);
    return Response.json({ error: "The summarization service failed. Please try again." }, { status: 502 });
  }
  const llmMs = Date.now() - llmStartedAt;

  // Descriptive metadata for the saved row (S-08). Decorative: a failure persists nulls rather than
  // discarding a summary that has already been paid for.
  //
  // The placement is load-bearing for three separate reasons. It keeps the two Supadata requests
  // seconds apart on a plan that allows 1 req/s; it means the 402/413/409 exit paths above never
  // spend a credit on a generation that does not happen; and it keeps an `allowLong` resubmit from
  // paying for metadata twice. Do not move it earlier without revisiting all three — relocating it
  // is S-09 lever B's job, not a free tidy-up.
  //
  // fetchVideoMetadata is total by contract, so this `try` is redundant BY DESIGN: the call sits
  // after the debit but before the persistence `try`/`catch` below, so a regression that made it
  // throw would bypass the refund and strand a reservation for reconciliation — a durable ledger
  // row traded for a thumbnail. The redundancy costs three lines.
  //
  // `metadata_ms` brackets the whole operation, retry and its ~1.2 s rate-limit sleep included: that
  // delay is real latency the user waited through, not overhead to be netted out.
  //
  // S-09 D6/D7 EXTENDS the three reasons above rather than replacing them. A cache HIT removes the
  // request outright, so the 1 req/s reason lapses on its own for that path — but the other two still
  // govern the MISS path below, which is a real vendor call in exactly the position it always was.
  // The lookup moved; the fetch did not.
  let metadata: Awaited<ReturnType<typeof fetchVideoMetadata>> = cachedMetadata;
  // Always set explicitly. A null would be indistinguishable from a pre-migration row and would
  // silently re-break the cost-per-generation queries this column exists to keep honest.
  let metadataVia: MetadataVia = "stored";

  if (metadata === null) {
    const metadataStartedAt = Date.now();

    // The SECOND budget check point, and the reason one in front of the transcript fetch is not
    // enough: on a warm transcript with cold metadata this call IS the first paid call, which is
    // exactly the traffic Phase 4's cache is designed to create. A breaker that only guarded the
    // transcript would be bypassed by its own success.
    //
    // Reserves 2, not 1 — `fetchVideoMetadata` may retry once and that retry is separately billed.
    const metadataBudget = await reserveBudget(admin, supadataKey, METADATA_BUDGET_CREDITS);

    if (metadataBudget.outcome === "refused") {
      // A trip HERE does not refuse the generation. The user has already been debited and the LLM has
      // already been paid for, so protecting a decorative thumbnail by discarding a finished summary
      // would be strictly worse than shipping it without one. Skip the call and persist nulls exactly
      // as a metadata failure already does — `'skipped_budget'` is what makes the degraded row explain
      // itself instead of looking like a vendor failure.
      metadataVia = "skipped_budget";
    } else {
      const metadataBudgetMark = meter.checkpoint();
      try {
        metadata = await fetchVideoMetadata({ url }, supadataKey, meter);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("fetchVideoMetadata threw despite being total:", error);
      } finally {
        // Same `finally` obligation as the transcript point, and reachable only from `reserved`: an
        // `untracked` outcome proceeded WITHOUT a reservation, so there is no id and nothing to close.
        // `billedSince` filters on the operation because the two check points are nested inside one
        // request — a metadata row must never settle the transcript's reservation or vice versa.
        if (metadataBudget.outcome === "reserved") {
          await settleBudget(admin, metadataBudget.reservationId, meter.billedSince(metadataBudgetMark, "metadata"));
        }
      }

      // Set AFTER the call, not before it: a request went out either way, and whether it came back with
      // a row is precisely the difference the two markers record. Stamping `'fetched'` up front made
      // the value mean "attempted" while every comment on it claimed "billed" — and a failure is
      // billed 0, so reading it as spend overcounts. `supadata_calls` remains the billing truth.
      metadataVia = metadata === null ? "fetch_failed" : "fetched";

      // Only a SUCCESS is cached (D9). A failed metadata call is billed 0, so caching the failure would
      // save nothing while persisting nulls for a video whose next attempt would likely succeed — and
      // `save_metadata_cache` does not coalesce, so writing nulls here would actively poison the row
      // for every other user.
      if (metadata !== null) {
        await saveCachedMetadata(admin, youtubeId, metadata);
      }
    }

    // Overwrites the cache read's duration measured above — the bracket that actually ran wins. It
    // spans the reservation as well as the call, so a `'skipped_budget'` row reports the refused
    // reserve (a DB round trip, plus `/v1/me` and its 1.2 s spacing when this caller happened to claim
    // the refresh) rather than any vendor work. One more reason `metadata_via` is the mandatory filter
    // on any query comparing `metadata_ms`.
    metadataMs = Date.now() - metadataStartedAt;
  }

  // Persist AND settle in ONE transaction (F23). These used to be two calls — an RLS-client insert
  // followed by a best-effort settle — which left the ledger indistinguishable from failed work for
  // the whole duration of the LLM call above, so the one-hour reconciliation sweep could refund a
  // request that was still running while its insert later succeeded anyway. The linked summary was
  // mutable evidence besides: owners may delete their own summaries. Deciding the charge inside the
  // transaction that writes the summary removes both windows — a throw here means the rollback
  // persisted nothing, so refunding is unambiguously correct.
  //
  // `generation_ms` is frozen HERE, not at the response. The boundary is forced rather than chosen:
  // `persist_summary` is the only writer of `summaries`, so a value carried through it must exist
  // before the call is made. It therefore excludes the persist round trip itself, the quote-cache
  // cleanup below and response construction. Reaching a response-bound figure would need a second
  // write after persist, with its own failure path, breaking the property that telemetry commits
  // atomically with the summary it describes — not worth it for those few milliseconds.
  const generationMs = Date.now() - generationStartedAt;

  let persisted: Awaited<ReturnType<typeof persistSummaryAndSettle>>;
  try {
    persisted = await persistSummaryAndSettle(admin, {
      userId,
      url,
      youtubeId,
      character,
      content: summary.text,
      model: summary.model,
      resolvedVia,
      reservationId,
      // D12, stated because "hit -> skip the write" is the natural regression: the metadata argument
      // is populated on a HIT exactly as on a fetch. S-02 renders its list from the per-user `videos`
      // row, which persist_summary's coalescing upsert writes from these values — so the cache FEEDS
      // that upsert rather than replacing it, and a second user's row is populated on a hit too.
      metadata,
      metadataVia,
      transcriptLang,
      transcriptAvailableLangs,
      transcriptChars: transcriptLength,
      generationMs,
      transcriptMs,
      llmMs,
      metadataMs,
      costUsd: summary.costUsd,
      promptTokens: summary.promptTokens,
      completionTokens: summary.completionTokens,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("persist summary failed:", error);
    await refundReservation(admin, userId, reservationId);
    return Response.json({ error: "Something went wrong saving your summary. Please try again." }, { status: 500 });
  }

  // The reservation was already resolved — a reconciliation sweep closed it while this request ran, so
  // the debit is reversed and nothing was written. Fail closed rather than return a summary with no
  // row behind it. No refund: the row is already resolved, and refundReservation would be a no-op.
  // summarize()'s explicit deadline is what keeps this unreachable in practice.
  if (!persisted.ok) {
    // eslint-disable-next-line no-console
    console.error(`persist summary skipped: reservation ${reservationId} for ${userId} was ${persisted.reason}`);
    return Response.json({ error: "Something went wrong saving your summary. Please try again." }, { status: 500 });
  }

  // Link this request's ledger rows to the summary they helped produce. Only the success path can do
  // this — rows from a request that returned 422/413/409/502 stay unlinked BY DESIGN, since there is
  // no summary to point at and their spend is exactly what this ledger exists to surface.
  meter.attachSummary(persisted.summaryId);

  // The quote has served its purpose (F24): the confirmation round-trip it was cached for ended in a
  // committed summary, so the transcript body is dropped now rather than lingering for the rest of its
  // TTL — or forever, if this key is never looked up again. Only on the success path; a failed attempt
  // keeps its quote so the retry reuses the fetch it already paid for. Guarded on `allowLong` because
  // that is the only path that can have written one (a short video never reaches the 409 that saves it).
  if (allowLong) {
    await discardTranscriptQuote(admin, userId, youtubeId, character);
  }

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
