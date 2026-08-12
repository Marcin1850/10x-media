import { useRef, useState } from "react";
import { copy } from "@/lib/copy";
import type { ChannelCharacter } from "@/types";

/**
 * A long-video price quote the server answered with (409). Carries the exact inputs it was priced
 * for: "Generate anyway" replays these, never the live form, so a late 409 arriving after the user
 * edited the form can't consent to a different video.
 */
export interface ConfirmState {
  cost: number;
  transcriptLength: number;
  url: string;
  character: ChannelCharacter;
}

/**
 * A committed, paid result. `url` is the URL this summary was generated for — a successful paid
 * result is applied even if the form was edited while the request was in flight, so the result is
 * labelled with its own input to stay unambiguous when it no longer matches the current form.
 */
export interface SuccessState {
  summary: string;
  cost: number;
  url: string;
}

/**
 * What the current attempt is summarizing, as reactive state.
 *
 * Deliberately NOT the `pendingRequest` ref: that ref's job is the idempotency key's lifetime, it
 * cannot re-render anything, and it is cleared on any HTTP response *before* the error branch runs —
 * so a card driven off it would have nothing to name at exactly the moment it must name something.
 */
export interface GenerateAttempt {
  /**
   * Immutable identity of this attempt — the `requestSeq` of the request that installed it.
   *
   * Exists so a consumer can retire *the attempt it consumed* rather than whatever attempt happens
   * to be current when its own async work finally resolves. A post-success list re-read is exactly
   * that case: a newer generation can start while the re-read is in flight, and clearing blindly
   * would erase the card belonging to work the user just paid for.
   */
  id: number;
  url: string;
  character: ChannelCharacter;
}

/**
 * The most recent success, as a *repeatable event*.
 *
 * The monotonic `seq` is what makes it repeatable: two generations of the same video in a row are
 * distinguishable, where a boolean or an object-identity check is not. `summaryId` comes straight
 * from the response body and lets a consumer confirm that a re-read of the list actually contains
 * the new row — so it is required: a success event that cannot name its row is not one a consumer
 * can act on. A successful response without an id is a broken endpoint contract, and the hook
 * declines to raise the event rather than modelling it as a supported shape.
 */
export interface LastSuccess {
  seq: number;
  /**
   * The `GenerateAttempt.id` this success belongs to. Pair it with `clearAttempt` so the card that
   * is retired is the one this success actually replaces.
   */
  attemptId: number;
  summaryId: string;
  url: string;
  character: ChannelCharacter;
}

export interface UseGenerateSummary {
  loading: boolean;
  error: string | null;
  confirm: ConfirmState | null;
  result: SuccessState | null;
  credits: number | null;
  attempt: GenerateAttempt | null;
  lastSuccess: LastSuccess | null;
  /** Run one generation for exactly these inputs. */
  generate: (withAllowLong: boolean, submittedUrl: string, submittedCharacter: ChannelCharacter) => void;
  /** A quote-relevant input changed — see the implementation for the `keepConfirm` asymmetry. */
  inputsChanged: (options?: { keepConfirm?: boolean }) => void;
  /** Drop the previous outcome so a new submit starts clean. Not called on the confirm replay. */
  clearOutcome: () => void;
  /**
   * The UI has consumed this attempt's terminal state and no longer needs to name it. Pass the
   * `GenerateAttempt.id` that was consumed to clear only that attempt; a newer one is left standing.
   * Called with no argument it clears whatever is current — for the user dismissing the card they
   * can see, which is by definition the live one.
   */
  clearAttempt: (attemptId?: number) => void;
}

/**
 * Maps a generate-endpoint HTTP status to a user-facing English message. The 402/409 paths carry
 * server-computed numbers, so they are built inline by the caller rather than here.
 */
function messageForStatus(status: number, serverError?: string): string {
  switch (status) {
    case 429:
      // Three distinct causes answer 429 (generation lease, idempotent in-progress replay, transcript
      // rate cap), each with its own server message. Prefer the server's so a cooldown doesn't
      // misreport as lock contention; the fallback covers a non-JSON 429.
      return serverError ?? copy.errors.alreadyGenerating;
    case 413:
      return copy.errors.tooLong;
    case 422:
      // Three distinct causes answer 422 (no caption track, a vendor success carrying no words, and
      // a transient fetch failure), each with its own server message. Prefer the server's so a video
      // that will NEVER be summarizable doesn't misreport as a retryable hiccup; the fallback covers
      // a non-JSON 422.
      return serverError ?? copy.errors.noTranscript;
    case 502:
      return copy.errors.serviceFailed;
    case 503:
      // Two very different causes answer 503, and collapsing them into the configuration one is what
      // this used to do: a missing service-role or provider key (genuinely a configuration problem the
      // user cannot affect) and a tripped budget breaker (a temporary capacity problem that resolves
      // on its own). Prefer the server's string so "try again in a while" is not reported as "this is
      // broken"; the fallback covers a non-JSON 503.
      return serverError ?? copy.errors.notConfigured;
    case 500:
      // Several distinct server-side 500s exist (pre-save infrastructure failures vs. a persistence
      // failure), each with its own message. Prefer the server's so a lock/balance/reserve failure
      // doesn't misreport as a save failure; the generic fallback covers a non-JSON framework 500.
      return serverError ?? copy.errors.generic;
    case 401:
      return copy.errors.sessionExpired;
    case 400:
      return serverError ?? copy.errors.checkUrl;
    default:
      return serverError ?? copy.errors.generic;
  }
}

/**
 * The whole generation lifecycle, lifted out of `GenerateSummaryForm` so it survives the form
 * unmounting. `ui/dialog` does not force-mount its content, so the form is destroyed every time the
 * dialog closes — and a paid, in-flight request must not die with it. The owner of this hook is a
 * component that outlives the dialog.
 *
 * Three invariants are preserved verbatim from the form's original implementation. Each of them is
 * a paid-path guarantee, and each fails silently (a double charge, a replayed wrong summary, a
 * result the user paid for but never sees) rather than loudly:
 *
 * 1. `pendingRequest` — the idempotency key — is held ONLY across a network error, and released by
 *    any HTTP response. Widening that lifetime replays a previous video's summary; narrowing it
 *    charges twice for one ambiguous retry.
 * 2. `requestSeq` is bumped on submit AND on every quote-relevant input change.
 * 3. A successful response is applied BEFORE the staleness check, never after.
 */
export function useGenerateSummary({
  initialCredits,
  onSuccess,
}: {
  initialCredits: number | null;
  /**
   * Fired once per committed generation, from inside the request's own async flow.
   *
   * A callback rather than an effect on `lastSuccess`: a success is an *event*, and reacting to it
   * by syncing state in an effect is both the wrong model and a cascading render (`react-hooks/
   * set-state-in-effect` rejects it). Callers that need the value rather than the moment read
   * `lastSuccess`.
   */
  onSuccess?: (success: LastSuccess) => void;
}): UseGenerateSummary {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SuccessState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [credits, setCredits] = useState<number | null>(initialCredits);
  const [attempt, setAttempt] = useState<GenerateAttempt | null>(null);
  const [lastSuccess, setLastSuccess] = useState<LastSuccess | null>(null);
  // Monotonic id of the latest in-flight request. Bumped on every submit AND on every quote-relevant
  // input change, so a response whose seq is stale is discarded instead of applied to inputs the user
  // has since edited.
  const requestSeq = useRef(0);
  // Monotonic id of the latest success. Separate from `requestSeq` because it counts a different
  // thing: successes, not attempts — so consumers can react to "a new summary landed" once per
  // landing, including two landings for the same video in a row.
  const successSeq = useRef(0);
  // The `requestSeq` of the request that set the current `attempt`. A request that abandons its own
  // outcome must retract its attempt, but only its own: a stale response can arrive after a NEWER
  // submit has already installed its attempt, and clearing unconditionally would erase that one.
  const attemptSeq = useRef(0);
  // The server-side idempotency key for the attempt currently being retried, with the inputs it was
  // minted for. Held ONLY across a network error — the one failure where the request may have been
  // delivered and its reply lost, so a resubmit would otherwise charge and summarize a second time.
  // Any HTTP response, success or error, is a known outcome and clears it, making the next submit a
  // genuinely new operation. Bound to url+character so a retry after the user edits the form mints a
  // fresh key instead of replaying the previous video's summary.
  const pendingRequest = useRef<{ key: string; url: string; character: ChannelCharacter } | null>(null);

  async function generate(withAllowLong: boolean, submittedUrl: string, submittedCharacter: ChannelCharacter) {
    const seq = (requestSeq.current += 1);
    setLoading(true);
    setError(null);
    setAttempt({ id: seq, url: submittedUrl, character: submittedCharacter });
    attemptSeq.current = seq;

    // Reuse the key only when retrying the same inputs after an ambiguous failure; otherwise this is a
    // new operation and gets a new key. `crypto.randomUUID` needs a secure context, which localhost
    // and the deployed HTTPS origin both are.
    const pending = pendingRequest.current;
    const requestId =
      pending?.url === submittedUrl && pending.character === submittedCharacter ? pending.key : crypto.randomUUID();
    pendingRequest.current = { key: requestId, url: submittedUrl, character: submittedCharacter };

    let response: Response;
    try {
      response = await fetch("/api/summaries/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: submittedUrl,
          character: submittedCharacter,
          allowLong: withAllowLong,
          requestId,
        }),
      });
    } catch {
      // The ONLY path that keeps the key: the request may have been delivered and charged, so the
      // resubmit this error invites must be recognisable as the same operation.
      // Only surface the error if this is still the current request; a superseded one just clears
      // loading and retracts its own attempt — with no error to show, an attempt left behind names a
      // request that has no status at all.
      if (seq === requestSeq.current) setError(copy.errors.network);
      else if (attemptSeq.current === seq) setAttempt(null);
      setLoading(false);
      return;
    }

    // A response — of any status — means the server reached a decision, so there is nothing ambiguous
    // left to deduplicate. Release the key before branching so every path below starts clean.
    pendingRequest.current = null;

    const data: unknown = await response.json().catch(() => ({}));

    const payload = (data ?? {}) as {
      summary?: string;
      cost?: number;
      creditsRemaining?: number;
      transcriptLength?: number;
      requiresConfirmation?: boolean;
      summaryId?: string;
      error?: string;
    };

    // A successful response means the summary was already saved and the user was charged. Apply it even
    // if the form was edited while the request was in flight (seq is now stale): dropping paid work
    // would hide both the result and the new balance, inviting a duplicate — and duplicate — charge.
    // Label the result with its own submitted URL so it stays unambiguous when it no longer matches the
    // currently edited form.
    if (response.ok) {
      setResult({ summary: payload.summary ?? "", cost: payload.cost ?? 1, url: submittedUrl });
      setConfirm(null);
      if (typeof payload.creditsRemaining === "number") setCredits(payload.creditsRemaining);
      setLoading(false);
      // The paid result and the new balance are applied above regardless. The success *event* needs
      // an id to be actionable, so a success answered without one — a contract the endpoint never
      // breaks today — raises no event rather than one no consumer can confirm the list against.
      if (typeof payload.summaryId !== "string") return;
      const success: LastSuccess = {
        seq: (successSeq.current += 1),
        attemptId: seq,
        summaryId: payload.summaryId,
        url: submittedUrl,
        character: submittedCharacter,
      };
      setLastSuccess(success);
      onSuccess?.(success);
      return;
    }

    // Every remaining outcome is advisory (a consent prompt or an error), not a persisted result. If
    // the inputs it was computed for are no longer current, it can't be applied to what the user now
    // sees — drop it, including any late 409.
    if (seq !== requestSeq.current) {
      // Drop the attempt with it: nothing will describe this request any more, so an attempt left
      // standing has no error, no confirmation and no result to be rendered from. Guarded so a stale
      // response arriving after a newer submit retracts only its own attempt, not the live one.
      if (attemptSeq.current === seq) setAttempt(null);
      setLoading(false);
      return;
    }

    if (response.status === 409 && payload.requiresConfirmation) {
      setConfirm({
        cost: payload.cost ?? 2,
        transcriptLength: payload.transcriptLength ?? 0,
        url: submittedUrl,
        character: submittedCharacter,
      });
      setResult(null);
      setLoading(false);
      return;
    }

    if (response.status === 402) {
      setError(payload.error ?? copy.errors.noCredits);
      // A 402 can arrive with a fresh authoritative balance in the message; if the server also sent a
      // number, prefer it. The endpoint currently embeds the balance in `error`, so nothing to sync here.
      setConfirm(null);
      setLoading(false);
      return;
    }

    setError(messageForStatus(response.status, payload.error));
    setConfirm(null);
    setLoading(false);
  }

  return {
    loading,
    error,
    confirm,
    result,
    credits,
    attempt,
    lastSuccess,
    generate: (withAllowLong, submittedUrl, submittedCharacter) => {
      void generate(withAllowLong, submittedUrl, submittedCharacter);
    },
    inputsChanged: (options) => {
      // Always invalidate the in-flight request: its response was computed for inputs the user has
      // since changed, so it must not be applied to what they now see.
      requestSeq.current += 1;
      // ...and normally drop the long-video quote too, so a changed video can't be generated at 2
      // credits on an earlier video's confirmation. The one exception is the allow-long toggle: it
      // does not change WHICH video is quoted, and it is the very consent the quote is asking for, so
      // clearing the quote there would delete the prompt the user is answering.
      if (!options?.keepConfirm) setConfirm(null);
    },
    clearOutcome: () => {
      setResult(null);
      setConfirm(null);
    },
    clearAttempt: (attemptId) => {
      // Functional update on purpose: the caller that has an id to check reaches this from inside
      // async work whose closure was captured before a newer attempt could have been installed, so
      // the comparison has to run against the live attempt, not the one that render saw.
      setAttempt((current) =>
        current === null || (attemptId !== undefined && current.id !== attemptId) ? current : null,
      );
    },
  };
}
