import { CircleAlert, Loader2, X } from "lucide-react";
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
  status: "generating" | "needs-confirmation" | "failed";
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
        pending.status === "failed" ? "border-red-400/40 bg-red-900/15" : "border-purple-400/40 bg-purple-500/10",
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

      {pending.status === "generating" ? (
        <p className="mt-2 flex items-center gap-2 text-xs text-blue-100/70">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Generating this summary…
        </p>
      ) : null}

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

      {pending.status === "failed" ? (
        <div className="mt-2 flex items-start justify-between gap-2">
          {/* The server's own message, passed through by the hook — a transcript-less video and a
              tripped budget breaker say very different things, and a generic "failed" hides which. */}
          <p className="flex min-w-0 items-start gap-2 text-xs text-red-200">
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
