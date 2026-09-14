import { useState } from "react";
import { CircleAlert, Sparkles } from "lucide-react";
import { SummaryCard, CHARACTER_LABEL } from "@/components/summaries/SummaryCard";
import { PendingSummaryCard, type PendingSummary } from "@/components/summaries/PendingSummaryCard";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/copy";
import type { ConfirmState } from "@/components/hooks/useGenerateSummary";
import type { ChannelCharacter, SummaryListItem } from "@/types";

interface Props {
  /**
   * Controlled, never seeded. The summaries are always owned by the caller, so the refresh has
   * exactly one owner and this component never holds a second source of truth for the same list.
   */
  summaries: SummaryListItem[];
  /**
   * The read failed. Distinct from an empty list on purpose — see the non-list states below.
   */
  listUnavailable: boolean;
  /**
   * The generation currently in flight, if any. Derived by the caller from the generation hook; this
   * component only places it. Refreshing is the caller's job too — the list stays controlled.
   */
  pending: PendingSummary | null;
  /** The active long-video quote, forwarded to the pending card's cost gate. Not folded into
   *  `pending` itself — see `PendingSummaryCard`'s `Props` for why. */
  confirm: ConfirmState | null;
  /** The live balance, forwarded to the pending card's cost gate. */
  credits: number | null;
  /** The post-generation re-read failed: the summary is saved, this list just doesn't have it yet. */
  unlisted: UnlistedSummary | null;
  onPendingConfirm: () => void;
  onPendingDismiss: () => void;
  /**
   * The user confirmed a deletion. Keyed by summary id and fired once — the caller removes the card
   * optimistically, so this list never renders an in-flight state and is passed no "deleting" set:
   * an id being deleted has no card here to receive one.
   */
  onDeleteSummary: (id: string) => void;
  /** Per-id message from a deletion that failed and restored its row. Absent for every other id. */
  deleteErrors: Record<string, string | undefined>;
  onClearDeleteError: (id: string) => void;
  /** The user set, switched or cleared a card's watch/skip verdict (S-14). Owned by the caller. */
  onSetVerdict: (id: string, value: boolean | null) => void;
  /** Ids whose verdict request is in flight — their toggle is disabled. */
  verdictSaving: Record<string, boolean | undefined>;
  /** Per-id message from a verdict save that failed and rolled back. */
  verdictErrors: Record<string, string | undefined>;
}

/**
 * A summary that is saved and paid for but is not in the list on screen, because the re-read that
 * should have produced its card never returned it.
 *
 * An identity rather than a boolean on purpose. A boolean cannot tell "the row I am waiting for
 * appeared" from "some later row appeared", so a subsequent generation's successful re-read would
 * clear the flag while the earlier summary was still missing — and by then its pending card has been
 * replaced by the newer attempt, leaving the summary in neither place. The `url` is carried so the
 * note can name what it is talking about: the card on screen may well belong to a different video by
 * the time anyone reads it.
 */
export interface UnlistedSummary {
  summaryId: string;
  url: string;
}

type Filter = "all" | ChannelCharacter;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: copy.summaries.filters.all },
  { value: "informational", label: CHARACTER_LABEL.informational },
  { value: "educational", label: CHARACTER_LABEL.educational },
];

/**
 * The saved-summary list. Owns **only** the character filter, which is applied client-side; the
 * corpus itself arrives as a prop.
 *
 * Three mutually exclusive non-list states, which must not be collapsed into each other:
 *
 * - **unavailable** — the read failed. Offer a reload; never claim the corpus is empty. Telling a
 *   user with 16 saved summaries that they have none is a wrong statement about their data, which is
 *   worse than showing an error.
 * - **empty** — the user genuinely has no summaries. "Generate your first."
 * - **empty under filter** — they have summaries, just none of this character. Offer to clear it.
 */
export function SummaryList({
  summaries,
  listUnavailable,
  pending,
  confirm,
  credits,
  unlisted,
  onPendingConfirm,
  onPendingDismiss,
  onDeleteSummary,
  deleteErrors,
  onClearDeleteError,
  onSetVerdict,
  verdictSaving,
  verdictErrors,
}: Props) {
  const [filter, setFilter] = useState<Filter>("all");

  const visible = filter === "all" ? summaries : summaries.filter((item) => item.character === filter);

  // The filter never applies to the pending card. A pending generation does have a character, but
  // hiding the thing the user just started — in the one place they can watch it — is the wrong
  // default; the filter is for browsing what is saved. It also carries no delete or verdict control: a
  // generation in flight is not a saved summary, and there is no row to delete or mark.
  const pendingCard =
    pending === null ? null : (
      <PendingSummaryCard
        pending={pending}
        confirm={confirm}
        credits={credits}
        onConfirm={onPendingConfirm}
        onDismiss={onPendingDismiss}
      />
    );

  // The re-read after a generation is best-effort, so its failure never discards the list that is
  // already rendered — it annotates it. The summary itself is saved and paid for; only this view of
  // it is stale, which is exactly what the copy has to say. This is information, not a request to
  // spend credits, so it takes the neutral warning treatment rather than --attention.
  //
  // Naming the video is not decoration. A generation started after the failed re-read replaces the
  // pending card, and an unqualified "your summary was saved" then reads as a claim about the video
  // currently on screen — which is still generating.
  const refreshNote =
    unlisted === null ? null : (
      <div className="bg-card border-border text-foreground flex items-start gap-2 rounded-xl border px-4 py-3 text-sm">
        <CircleAlert className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{copy.summaries.list.refreshNote(unlisted.url)}</span>
      </div>
    );

  if (listUnavailable) {
    return (
      <div className="space-y-3">
        {/* The note belongs here too. A failed initial read and a failed post-generation re-read are
            different facts, and dropping the second one in this branch is what left a just-paid
            summary explained by nothing but a generic "we couldn't load your summaries". */}
        {refreshNote}
        {pendingCard}
        <div className="border-destructive bg-destructive/10 text-destructive flex items-start gap-2 rounded-xl border-2 px-4 py-3 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{copy.summaries.list.unavailable}</span>
        </div>
      </div>
    );
  }

  // A pending card replaces the empty state rather than sitting beside it: "you haven't generated any
  // summaries yet" next to a summary visibly being generated is a contradiction, and the pending card
  // already says everything the empty state's call to action would.
  if (summaries.length === 0) {
    return (
      <div className="space-y-3">
        {refreshNote}
        {pendingCard ?? (
          <div className="bg-card border-border rounded-xl border px-4 py-8 text-center">
            <Sparkles className="text-muted-foreground mx-auto size-5" aria-hidden="true" />
            <p className="text-card-foreground mt-2 text-sm">{copy.summaries.list.empty}</p>
            <p className="text-muted-foreground text-xs">{copy.summaries.list.emptyHint}</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {refreshNote}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={copy.summaries.filters.groupLabel}>
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setFilter(option.value);
              }}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-border bg-secondary text-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground bg-transparent",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {pendingCard}

      {visible.length === 0 ? (
        <div className="bg-card border-border rounded-xl border px-4 py-8 text-center">
          <p className="text-card-foreground text-sm">{copy.summaries.list.emptyFiltered}</p>
          <button
            type="button"
            onClick={() => {
              setFilter("all");
            }}
            className="text-primary mt-2 text-xs transition-colors hover:underline"
          >
            {copy.summaries.list.showAll}
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((item) => (
            <li key={item.id}>
              <SummaryCard
                item={item}
                onDelete={onDeleteSummary}
                deleteError={deleteErrors[item.id]}
                onClearDeleteError={onClearDeleteError}
                onSetVerdict={onSetVerdict}
                verdictSaving={verdictSaving[item.id] === true}
                verdictError={verdictErrors[item.id]}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
