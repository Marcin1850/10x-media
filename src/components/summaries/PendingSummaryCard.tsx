import { CircleAlert, CircleCheck, Loader2, X } from "lucide-react";
import { CharacterBadge } from "@/components/summaries/SummaryCard";
import { VideoThumbnail } from "@/components/summaries/VideoThumbnail";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/copy";
import { extractYoutubeId } from "@/lib/services/summaries";
import type { ConfirmState } from "@/components/hooks/useGenerateSummary";
import type { ChannelCharacter } from "@/types";

/**
 * What the current generation attempt is doing, as the list needs to see it.
 *
 * Derived by the owner of `useGenerateSummary` from the hook's `attempt` plus its status — never
 * from the `pendingRequest` ref, which exists for the idempotency key's lifetime, cannot re-render
 * anything, and is cleared on any HTTP response before the error branch runs.
 */
export interface PendingSummary {
  url: string;
  character: ChannelCharacter;
  /**
   * The two `saved*` states exist because a committed generation is not a finished one from this
   * card's point of view: the summary is paid for and persisted, but the list re-read that produces
   * its real card is still running (`saved`) or has given up (`saved-refresh-failed`). Collapsing
   * either back into `generating` makes the card state a paid operation as unfinished while the note
   * above the list says it was saved — two contradictory claims about the same money.
   */
  status: "generating" | "needs-confirmation" | "failed" | "saved" | "saved-refresh-failed";
  /** The server's message. Only ever set on `failed`. */
  error: string | null;
}

interface Props {
  pending: PendingSummary;
  /**
   * The active long-video quote, if any. Not part of `PendingSummary` — this is priced data the
   * generation hook already holds (`useGenerateSummary`'s `confirm`), not a fact about the attempt's
   * identity, and threading it here rather than duplicating it keeps the cost gate and the capture
   * bar's own submit label reading the exact same number.
   */
  confirm: ConfirmState | null;
  /** The live balance, for the gate's "balance that would remain" line. `null` renders the Unknown
   *  treatment rather than inventing a number the endpoint hasn't confirmed. */
  credits: number | null;
  /**
   * The gate's own action button does not generate directly — the capture bar's submit button does
   * that, replaying `confirm`'s frozen inputs (see `GenerateSummaryForm`). This just returns focus to
   * it, since the bar can be scrolled out of view by the time the 409 lands.
   */
  onConfirm: () => void;
  /** The user has read the failure and no longer needs the card naming the attempt. */
  onDismiss: () => void;
}

/**
 * The generation in flight, sitting in the same slot the saved card will occupy once it commits.
 *
 * Deliberately NOT a lookalike of `SummaryCard`: no thumbnail outside the cost-gate state, because
 * nothing here is saved yet. The summary body is never rendered here even after the response arrives
 * — it belongs to the real card the re-read produces, and showing it twice would let the two
 * disagree.
 *
 * This card is client-session-only. A reload mid-generation drops it, which is accepted: the
 * server-side generation lease and the idempotency ledger already prevent a double charge, so the
 * cost is a missing spinner, not a lost credit.
 */
export function PendingSummaryCard({ pending, confirm, credits, onConfirm, onDismiss }: Props) {
  const isGate = pending.status === "needs-confirmation";
  const gateYoutubeId = isGate && confirm !== null ? extractYoutubeId(confirm.url) : null;
  // Matches `GenerateSummaryForm`'s `confirmTooExpensive`: the known balance can't cover the quote, so
  // no resulting balance can ever be shown — only a known-insufficient one could go negative.
  const gateTooExpensive = confirm !== null && credits !== null && credits < confirm.cost;

  return (
    <article
      className={cn(
        "rounded-xl px-4 py-3",
        pending.status === "failed"
          ? "border-destructive bg-destructive/10 border-2"
          : isGate
            ? // The only amber in the app: this is the "needs your decision" attention slot.
              "border-attention bg-attention/12 border-2"
            : pending.status === "saved-refresh-failed"
              ? // Matches the list's refresh note: the same fact — saved, just not visible yet — takes
                // the same neutral warning treatment, not amber.
                "border-border bg-card border"
              : // generating | saved — the in-flight slot: a shimmer under a dashed border, the
                // non-colour channel that tells it apart from ghost hover (now --accent).
                "border-border bg-muted animate-pulse border border-dashed",
      )}
    >
      {isGate && confirm !== null && gateYoutubeId ? (
        <div className="mb-3 w-28">
          <VideoThumbnail youtubeId={gateYoutubeId} reportedUrl={null} title={null} />
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <p
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            isGate ? "text-attention-text" : "text-card-foreground",
          )}
          title={pending.url}
        >
          {pending.url}
        </p>
        <CharacterBadge character={pending.character} />
      </div>

      {/* One persistent live region for every non-failure lifecycle message.

          Persistent is the load-bearing word: this card changes state while the user is somewhere
          else entirely — the bar can be scrolled out of view, and the 409, the commit and the
          re-read all land on their own schedule. A region mounted at the same moment as its text is
          unreliably announced, so the region is always here and only its contents swap.
          The actionable failure below is deliberately outside it: it carries its own alert
          semantics, and nesting the two would announce the same message twice. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={pending.status === "generating" || pending.status === "saved"}
      >
        {pending.status === "generating" ? (
          <p className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {copy.generate.status.generating}
          </p>
        ) : null}

        {/* Still a spinner, but now it is honest about what is spinning: the charge is settled and
            the list re-read is what the user is waiting on. */}
        {pending.status === "saved" ? (
          <p className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {copy.generate.status.saved}
          </p>
        ) : null}

        {/* No spinner: nothing is in flight any more. The summary exists and is paid for; only this
            view of it is stale, and a reload is the whole remedy. */}
        {pending.status === "saved-refresh-failed" ? (
          <p className="text-foreground mt-2 flex items-start gap-2 text-xs">
            <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{copy.generate.status.savedRefreshFailed}</span>
          </p>
        ) : null}

        {/* The cost gate. States four things and only those: the run is held, the reason is a long
            video, the price, and the balance that would remain — both numbers interpolated, never
            baked into the string. No title, channel or duration: the 409 body carries none.
            The resulting-balance sentence only applies when confirmation could actually proceed —
            a known-insufficient balance uses the same shortfall copy the capture bar shows, since no
            resulting balance is possible to state truthfully. */}
        {isGate && confirm !== null ? (
          <div className="mt-2 space-y-2">
            <p className="text-attention-text flex items-start gap-2 text-xs">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {gateTooExpensive
                ? copy.generate.gate.tooExpensive(confirm.cost, credits)
                : copy.generate.gate.held(confirm.cost, credits === null ? null : credits - confirm.cost)}
            </p>
            <Button
              type="button"
              size="sm"
              onClick={onConfirm}
              className="bg-attention text-attention-foreground hover:bg-attention/90"
            >
              {copy.generate.gate.reviewAction}
            </Button>
          </div>
        ) : null}
      </div>

      {pending.status === "failed" ? (
        <div className="mt-2 flex items-start justify-between gap-2">
          {/* The server's own message, passed through by the hook — a transcript-less video and a
              tripped budget breaker say very different things, and a generic "failed" hides which. */}
          {/* Its own alert rather than a member of the polite region above: this is the one state
              that stops the user's work and asks them to do something about a charge that did not
              land. The dismiss button stays outside the alert so the announcement is the message. */}
          <p role="alert" className="text-destructive flex min-w-0 items-start gap-2 text-xs">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="break-words">{pending.error ?? copy.errors.generic}</span>
          </p>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={copy.generate.dismissFailed}
            className="text-destructive hover:bg-accent shrink-0 rounded-md p-1 transition-colors"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </article>
  );
}
