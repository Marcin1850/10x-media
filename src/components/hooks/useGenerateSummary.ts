import { useRef, useState } from "react";
import { copy } from "@/lib/copy";
import { announceBalance } from "@/lib/credits-events";
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
  /**
   * Whether the failure named by `error` took a credit — `null` when the endpoint sent no `charged`
   * field or a non-boolean one, which degrades to silence rather than to `false` (S-09 phase 9 D1). A
   * wrong statement about the user's money is worse than saying nothing. Cleared alongside `error` by
   * the same `attemptId`-bound `clearAttempt`, so a stale charge line can never outlive its attempt.
   */
  charged: boolean | null;
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
   * can see, which is by definition the live one. Also clears `error` when the attempt it belongs to
   * is the one being cleared, so a dismissed failure doesn't keep rendering elsewhere.
   */
  clearAttempt: (attemptId?: number) => void;
}

/**
 * Picks the user-facing message for an error response, preferring the server's machine-readable
 * `code` over its English `error` string.
 *
 * This inverts what the client used to do, and the reason it used to do it is worth stating: several
 * statuses answer with more than one cause (422 alone has three), the per-status table below has one
 * entry each, so preferring the table would have collapsed distinctions a user must act on
 * differently. The endpoint now sends a `code` per cause, which keeps the distinction AND lets the
 * copy be Polish — the two things that were previously in conflict.
 *
 * Falls through to `messageForStatus` for an absent or unrecognised code, so an endpoint that adds a
 * cause before its translation exists degrades to a correct-but-generic Polish sentence instead of
 * an English one. Exported for unit test: it is pure, and it is where the localisation contract
 * actually lives.
 *
 * The server's English `error` string is deliberately NOT a parameter: it stays on the body for logs
 * and non-browser consumers (README §Summary credits), and no path through this function can put it
 * in front of a user. Taking it and merely de-prioritising it is what let it leak before — the one
 * status where the card is user-visible English is the one where no code resolved, which is exactly
 * the case the Polish fallback exists for.
 */
export function messageForError(status: number, code?: unknown): string {
  if (typeof code === "string") {
    // `string | undefined`, not `string`: `noUncheckedIndexedAccess` is off, so the honest type has
    // to be written here or the miss below reads as dead code to both the compiler and the linter —
    // while at runtime an unknown code is the whole reason this branch exists.
    const byCode: Record<string, string | undefined> = copy.errors.codes;
    const localised = byCode[code];
    if (localised !== undefined) return localised;
  }
  return messageForStatus(status);
}

/**
 * Maps a generate-endpoint HTTP status to a user-facing message when no `code` resolved it. The
 * 402/409 paths carry server-computed numbers, so they are built inline by the caller rather than
 * here.
 *
 * Polish only, on every branch. On a multi-cause status this message is generic by construction —
 * one entry cannot say which of three things happened — and that is the accepted trade: the causes
 * that a user must act on differently all carry a `code` and were answered above, so what reaches
 * here is a cause shipped ahead of its translation, an older endpoint build, or a body that is not
 * this endpoint's. A generic Polish sentence is the right answer to all three; an English one is a
 * mixed-language card, which the copy contract (`copy.errors.codes`) rules out.
 */
function messageForStatus(status: number): string {
  switch (status) {
    // Three distinct causes answer 429 (generation lease, idempotent in-progress replay, transcript
    // rate cap). All three ask the user to wait, so the shared sentence misdirects nobody.
    case 429:
      return copy.errors.alreadyGenerating;
    case 413:
      return copy.errors.tooLong;
    // Three distinct causes answer 422 (no caption track, a vendor success carrying no words, and a
    // transient fetch failure) and they differ in whether retrying helps — which is why all three
    // send a code and are resolved above. This line is only reached when none did.
    case 422:
      return copy.errors.noTranscript;
    case 502:
      return copy.errors.serviceFailed;
    // Two very different causes answer 503: a missing service-role or provider key, and a tripped
    // budget breaker. Both send a code; without one, "not configured" is the safer generic — it does
    // not promise the user that waiting will fix it.
    case 503:
      return copy.errors.notConfigured;
    case 500:
      return copy.errors.generic;
    case 401:
      return copy.errors.sessionExpired;
    case 400:
      return copy.errors.checkUrl;
    default:
      return copy.errors.generic;
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
 * 1. `pendingRequest` — the idempotency key — is held ONLY across a network error or a server-flagged
 *    ambiguous refusal charge (`ambiguousCharge: true`), and released by every other HTTP response.
 *    Widening that lifetime replays a previous video's summary; narrowing it charges twice for one
 *    ambiguous retry.
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
  const [charged, setCharged] = useState<boolean | null>(null);
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
    setCharged(null);
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

    const data: unknown = await response.json().catch(() => ({}));

    const payload = (data ?? {}) as {
      summary?: string;
      cost?: number;
      creditsRemaining?: number;
      transcriptLength?: number;
      requiresConfirmation?: boolean;
      summaryId?: string;
      error?: string;
      code?: unknown;
      charged?: unknown;
      ambiguousCharge?: unknown;
    };

    // A response usually means the server reached a decision, so there is nothing left to deduplicate
    // and the key releases. The one exception is this specific 422: the server itself could not prove
    // whether the refusal fee landed, so the key must survive to let a resubmit of these SAME inputs
    // replay that decision instead of risking a second charge for one ambiguous attempt.
    if (!(response.status === 422 && payload.ambiguousCharge === true)) {
      pendingRequest.current = null;
    }

    // A successful response means the summary was already saved and the user was charged. Apply it even
    // if the form was edited while the request was in flight (seq is now stale): dropping paid work
    // would hide both the result and the new balance, inviting a duplicate — and duplicate — charge.
    // Label the result with its own submitted URL so it stays unambiguous when it no longer matches the
    // currently edited form.
    if (response.ok) {
      setResult({ summary: payload.summary ?? "", cost: payload.cost ?? 1, url: submittedUrl });
      setConfirm(null);
      if (typeof payload.creditsRemaining === "number") {
        setCredits(payload.creditsRemaining);
        announceBalance(payload.creditsRemaining);
      }
      setLoading(false);
      // The paid result and the new balance are applied above regardless. The success *event* needs
      // an id to be actionable, so a success answered without one — a contract the endpoint never
      // breaks today — raises no event rather than one no consumer can confirm the list against.
      // Without a terminal error either, the pending card's status derivation has no success and no
      // failure to read, so it falls back to "generating" forever — raise one so the card resolves.
      if (typeof payload.summaryId !== "string") {
        setError(copy.errors.savedResponseInvalid);
        return;
      }
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

    // A balance on the body is a FACT about the user's money, not advice about the submission it
    // answered — so it is applied HERE, above the staleness guard, for the same reason the paid
    // success above is. Everything below is dropped once the inputs moved on (an obsolete error card
    // describes a request the user has abandoned), but the number the server just reported is still
    // the user's current balance: dropping it leaves the header and the form's own credit gate
    // over-stating what can be spent, which is how a zero-credit user gets to submit into a 402. The
    // branches below therefore never re-apply it.
    if (typeof payload.creditsRemaining === "number") {
      setCredits(payload.creditsRemaining);
      announceBalance(payload.creditsRemaining);
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
      // The balance this status carries is applied above the staleness guard, with every other one:
      // the endpoint sends it as a FIELD now, not only inside the English `error` sentence, so this
      // path syncs like the rest instead of leaving the form's gate a request behind.
      // The one refusal whose copy is arithmetic, so it is rebuilt from the numbers rather than looked
      // up by code — and rebuilt with the SAME string the confirmation card uses, so a user who is
      // told a video costs 2 and refused for having 1 reads one sentence, not two phrasings of it.
      setError(
        payload.code === "insufficientCredits" &&
          typeof payload.cost === "number" &&
          typeof payload.creditsRemaining === "number"
          ? copy.generate.gate.tooExpensive(payload.cost, payload.creditsRemaining)
          : messageForError(402, payload.code),
      );
      setConfirm(null);
      setLoading(false);
      return;
    }

    // Only the 422 bodies this endpoint sends actually carry `charged`; every other status leaves it
    // `undefined`, which narrows to `null` here — silence about money rather than a guessed `false`.
    setCharged(typeof payload.charged === "boolean" ? payload.charged : null);
    // A charged refusal took a credit, so the balance this hook feeds the form is now one behind. The
    // 422 carries the post-charge number whenever the server knows it and it is applied above, with
    // every other balance-bearing status; `credits` is left alone when the body carries none
    // (`notCharged`, an ambiguous outcome, or any other status) rather than guessing a decrement.
    setError(messageForError(response.status, payload.code));
    setConfirm(null);
    setLoading(false);
  }

  return {
    loading,
    error,
    charged,
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
      if (!options?.keepConfirm) {
        // Withdrawing the quote also retracts the attempt it was the sole outcome of — the same rule
        // the superseded-request paths above already follow: an attempt with no loading, no
        // confirmation, no error and no committed success names a request that has no status at all,
        // and the list's pending derivation reads that back as "generating", a card claiming work
        // nothing is doing. Guarded on `!loading` so the confirmation replay, which runs with
        // `confirm` still set, keeps the card for the request it really has in flight. A failed or
        // saved attempt is a resting outcome the user dismisses, and neither leaves `confirm` set, so
        // neither is touched here.
        if (confirm !== null && !loading) setAttempt(null);
        setConfirm(null);
      }
    },
    clearOutcome: () => {
      setResult(null);
      setConfirm(null);
    },
    clearAttempt: (attemptId) => {
      // Guarded against `attemptSeq`, not the `attempt` state closure: the caller that has an id to
      // check reaches this from inside async work whose closure was captured before a newer attempt
      // could have been installed, so the comparison has to run against the live attempt, not the one
      // that render saw. A stale id is a no-op — the error it would otherwise clear belongs to the
      // newer, still-standing attempt.
      if (attemptId !== undefined && attemptSeq.current !== attemptId) return;
      setAttempt((current) =>
        current === null || (attemptId !== undefined && current.id !== attemptId) ? current : null,
      );
      setError(null);
      setCharged(null);
    },
  };
}
