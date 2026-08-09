import { CircleAlert, CircleCheck, Loader2, X } from "lucide-react";
import { CHARACTER_BADGE, CHARACTER_LABEL } from "@/components/summaries/SummaryCard";
import { cn } from "@/lib/utils";
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
   * Reopen the generation dialog. The long-video 409 can arrive with the dialog closed, and the
   * consent copy and the priced quote already live in the form — this card points at them rather
   * than duplicating a pricing UI that could then quote a different number.
   */
  onConfirm: () => void;
  /** The user has read the failure and no longer needs the card naming the attempt. */
  onDismiss: () => void;
}

/**
 * The generation in flight, sitting in the same slot the saved card will occupy once it commits.
 *
 * Deliberately NOT a lookalike of `SummaryCard`: a dashed border and no thumbnail, because nothing
 * here is saved yet. The summary body is never rendered here even after the response arrives — it
 * belongs to the real card the re-read produces, and showing it twice would let the two disagree.
 *
 * This card is client-session-only. A reload mid-generation drops it, which is accepted: the
 * server-side generation lease and the idempotency ledger already prevent a double charge, so the
 * cost is a missing spinner, not a lost credit.
 */
export function PendingSummaryCard({ pending, onConfirm, onDismiss }: Props) {
  return (
    <article
      className={cn(
        "rounded-xl border border-dashed px-4 py-3",
        pending.status === "failed"
          ? "border-red-400/40 bg-red-900/15"
          : // Matches the refresh-failure note above the list: the same amber, because it is the same
            // fact — saved, just not visible in the list yet.
            pending.status === "saved-refresh-failed"
            ? "border-amber-400/40 bg-amber-500/10"
            : "border-purple-400/40 bg-purple-500/10",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-white" title={pending.url}>
          {pending.url}
        </p>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
            CHARACTER_BADGE[pending.character],
          )}
        >
          {CHARACTER_LABEL[pending.character]}
        </span>
      </div>

      {/* One persistent live region for every non-failure lifecycle message.

          Persistent is the load-bearing word: this card changes state while the user is somewhere
          else entirely — the dialog is dismissable, and the 409, the commit and the re-read all land
          on their own schedule. A region mounted at the same moment as its text is unreliably
          announced, so the region is always here and only its contents swap.
          The actionable failure below is deliberately outside it: it carries its own alert
          semantics, and nesting the two would announce the same message twice. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={pending.status === "generating" || pending.status === "saved"}
      >
        {pending.status === "generating" ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-blue-100/70">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Generating this summary…
          </p>
        ) : null}

        {/* Still a spinner, but now it is honest about what is spinning: the charge is settled and
            the list re-read is what the user is waiting on. */}
        {pending.status === "saved" ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-blue-100/70">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Summary saved — adding it to your list…
          </p>
        ) : null}

        {/* No spinner: nothing is in flight any more. The summary exists and is paid for; only this
            view of it is stale, and a reload is the whole remedy. */}
        {pending.status === "saved-refresh-failed" ? (
          <p className="mt-2 flex items-start gap-2 text-xs text-amber-100">
            <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>Summary saved. Reload the page to see it in your list.</span>
          </p>
        ) : null}

        {/* Inside the polite region, button and all: the prompt is what makes it actionable, and a
            user who hears "needs your confirmation" without hearing what to press has been told
            half a sentence. */}
        {pending.status === "needs-confirmation" ? (
          <div className="mt-2 space-y-2">
            <p className="flex items-start gap-2 text-xs text-amber-100">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              This is a long video and needs your confirmation before it can be generated.
            </p>
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-500/25"
            >
              Review and confirm
            </button>
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
          <p role="alert" className="flex min-w-0 items-start gap-2 text-xs text-red-200">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="break-words">{pending.error ?? "Something went wrong. Please try again."}</span>
          </p>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss this failed generation"
            className="shrink-0 rounded-md p-1 text-red-200/70 transition-colors hover:bg-white/10 hover:text-red-100"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </article>
  );
}
