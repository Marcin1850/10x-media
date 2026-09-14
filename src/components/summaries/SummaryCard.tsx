import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Calendar, ChevronDown, CircleAlert, Clock, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { VideoThumbnail } from "@/components/summaries/VideoThumbnail";
import { SummaryMarkdown } from "@/components/summaries/SummaryMarkdown";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useHasMounted } from "@/components/hooks/useHasMounted";
import {
  daysSince,
  formatCreatedDate,
  formatDuration,
  formatPublishedDate,
  youtubeChannelUrl,
  youtubeWatchUrl,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/copy";
import type { ChannelCharacter, SummaryListItem } from "@/types";

interface Props {
  item: SummaryListItem;
  /** Fired once the user has confirmed. The parent removes the card immediately — see `onDelete`'s
   *  contract in `SummaryList`. */
  onDelete: (id: string) => void;
  /**
   * The message from a deletion that failed and put this row back. Owned by the parent: the card
   * cannot clear it, because the card is unmounted for the whole time the request is in flight.
   */
  deleteError?: string;
  onClearDeleteError: (id: string) => void;
  /**
   * The user chose, switched or cleared the watch/skip verdict (S-14). The parent applies it
   * optimistically and owns the request, its rollback and its error — the value shown is always
   * `item.worthWatching`.
   */
  onSetVerdict: (id: string, value: boolean | null) => void;
  /** A verdict request for this card is in flight: the group is disabled, so a second click is ignored. */
  verdictSaving?: boolean;
  /** The message from a verdict save that failed and restored the previous mark. */
  verdictError?: string;
}

/** Radix's single-select group speaks strings, with `""` for "nothing pressed"; the mark is tri-state. */
const VERDICT_VALUE = { worth: "worth", notWorth: "not-worth" } as const;

function verdictToValue(worthWatching: boolean | null): string {
  if (worthWatching === null) return "";
  return worthWatching ? VERDICT_VALUE.worth : VERDICT_VALUE.notWorth;
}

function valueToVerdict(value: string): boolean | null {
  if (value === VERDICT_VALUE.worth) return true;
  if (value === VERDICT_VALUE.notWorth) return false;
  return null;
}

/**
 * Exported so the pending card badges a generation the same way the saved card badges the summary it
 * turns into — one definition, so the two can't drift into labelling the same character differently
 * either side of a refresh.
 */
export const CHARACTER_LABEL: Record<ChannelCharacter, string> = copy.summaries.character;

/**
 * The three-channel character marker: both variants sit on `--secondary`, differentiated by shape,
 * weight and colour rather than hue, so the design system's own greyscale proof stays meaningful.
 * Neither variant uses `--attention` — that colour is reserved for the credit-spend gate. Exported so
 * the pending card (phase 6) renders the identical marker rather than a lookalike.
 */
export function CharacterBadge({ character }: { character: ChannelCharacter }) {
  const informational = character === "informational";

  return (
    <span
      className={cn(
        "bg-secondary inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs",
        informational ? "text-muted-foreground font-medium" : "text-foreground font-bold",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0",
          informational ? "border-muted-foreground rounded-full border-2" : "bg-foreground",
        )}
      />
      {CHARACTER_LABEL[character]}
    </span>
  );
}

/**
 * A one-line plain-text taste of the summary for the collapsed state. Markdown markers are stripped
 * rather than rendered: the collapsed row is a label, and running it through the real renderer would
 * put headings and list bullets inside a clamped two-line box. The full body always goes through
 * `SummaryMarkdown` once expanded, so this is presentation only — React escapes the text either way.
 */
function previewText(content: string): string {
  return content
    .replace(/[#>*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One saved summary: the video's thumbnail and metadata, the character it was generated for, the
 * body (collapsed by default, expanding in place), and an inline two-step delete control.
 *
 * Presentational about the *outcome* of a deletion: it owns which of the control's two steps is
 * showing and nothing else. Removal, the request, and the error all belong to the list's owner.
 *
 * The creation date is an addition beyond the card fields named in the brief, kept deliberately: the
 * list is flat and accepts the same video appearing once per character, so "generated on" is what
 * distinguishes two otherwise near-identical cards. `created_at` is read regardless — it is the
 * newest-first sort key.
 */
export function SummaryCard({
  item,
  onDelete,
  deleteError,
  onClearDeleteError,
  onSetVerdict,
  verdictSaving = false,
  verdictError,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  // Which of the delete control's two steps is showing, and the card's *only* delete state. There is
  // deliberately no `deleting` flag: the parent drops the card the moment deletion starts, so an
  // in-flight state on this component could never render.
  const [confirming, setConfirming] = useState(false);
  const contentId = useId();
  // Keyboard continuity across the two steps. Activating the trigger unmounts it, so without this
  // the focus ring lands on `<body>` and the confirmation is unreachable without re-Tabbing from the
  // top of the page; cancelling has the mirror problem. `wasConfirming` is what keeps the effect from
  // stealing focus on mount — every card in the list would fight for it.
  const confirmRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  // `daysSince` reads the real clock (see its doc comment) — computed once on the server and again,
  // independently, during hydration. Held back until after mount so the very first client render
  // matches the server's exactly; a few-ms gap straddling UTC midnight would otherwise make the two
  // disagree, a real hydration mismatch. Recomputed on every render once mounted, so the suffix still
  // advances live as the page stays open, same as before.
  const mounted = useHasMounted();

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else if (wasConfirming.current) triggerRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  const duration = formatDuration(item.durationSeconds);
  const published = formatPublishedDate(item.publishedAt);
  const publishedDaysAgo = mounted ? daysSince(item.publishedAt) : null;
  // Pre-S-08 rows carry nulls in every descriptive column. Omit the whole row in that case rather
  // than render an empty one.
  const hasMeta = item.channelName !== null || duration !== null || published !== null;

  const toggleLabel = `${expanded ? copy.summaries.card.collapse : copy.summaries.card.expand} ${copy.summaries.card.summaryOf(item.title ?? item.url)}`;
  const videoUrl = youtubeWatchUrl(item.youtubeId);
  // `relative z-10` on the two links below lifts them above the toggle button's stretched `::after`
  // (see the comment on the outer row), which otherwise catches every click in the row first.
  const linkClassName = "relative z-10 hover:text-foreground hover:underline";

  function cancelDelete() {
    setConfirming(false);
    // The parent owns the error, so returning this control to idle is not enough to clear it.
    onClearDeleteError(item.id);
  }

  /** Escape dismisses the confirmation, the way it would dismiss a dialog. */
  function handleConfirmKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape") {
      event.stopPropagation();
      cancelDelete();
    }
  }

  return (
    <article className="border-border bg-card hover:bg-accent rounded-xl border transition-colors">
      {/* `relative` anchors the expand button's stretched `::after`, which is what makes the whole
          header row clickable without nesting the heading and paragraphs inside a `<button>`. */}
      <div className="relative flex items-start gap-4 p-4">
        <a
          href={videoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="relative z-10 block w-32 shrink-0 sm:w-40"
          aria-label={copy.summaries.card.openVideo(item.title ?? item.url)}
        >
          {/* Keyed by the thumbnail source: `stage` is a one-shot forward-only guard seeded on mount,
              so a card whose source changes under a list refresh has to remount to retry it. */}
          <VideoThumbnail
            key={`${item.youtubeId}:${item.thumbnailUrlReported ?? ""}`}
            youtubeId={item.youtubeId}
            reportedUrl={item.thumbnailUrlReported}
            title={item.title}
          />
        </a>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            {/* `url` is NOT NULL, so there is always something to name the card with. */}
            <h3 className="text-card-foreground line-clamp-2 text-sm font-semibold break-words">
              <a href={videoUrl} target="_blank" rel="noopener noreferrer" className={linkClassName}>
                {item.title ?? item.url}
              </a>
            </h3>
            <CharacterBadge character={item.character} />
          </div>

          {hasMeta ? (
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {item.channelName !== null ? (
                <span className="min-w-0 truncate">
                  {item.channelId !== null ? (
                    <a
                      href={youtubeChannelUrl(item.channelId)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={linkClassName}
                      aria-label={copy.summaries.card.openChannel(item.channelName)}
                    >
                      {item.channelName}
                    </a>
                  ) : (
                    item.channelName
                  )}
                </span>
              ) : null}
              {/* Duration and upload date get an icon rather than relying on the `·` separator alone
                  to say what kind of value each is — both were previously bare, same-styled text
                  indistinguishable from the channel name and from each other at a glance. */}
              {duration !== null ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Clock className="size-3" aria-hidden="true" />
                  {duration}
                </span>
              ) : null}
              {published !== null ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <Calendar className="size-3" aria-hidden="true" />
                  {published}
                  {publishedDaysAgo !== null ? ` ${copy.summaries.card.publishedRelative(publishedDaysAgo)}` : null}
                </span>
              ) : null}
            </div>
          ) : null}

          <p className="text-muted-foreground text-xs">
            {copy.summaries.card.generatedOn(formatCreatedDate(item.createdAt))}
          </p>

          {/* The verdict (S-14). `relative z-10` lifts it above the expand button's stretched `::after`,
              like the links and the delete control, so choosing a verdict never toggles the card.
              Single-select with deselection: clicking the pressed option yields "", which is a clear. */}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={1}
            value={verdictToValue(item.worthWatching)}
            onValueChange={(value) => {
              onSetVerdict(item.id, valueToVerdict(value));
            }}
            disabled={verdictSaving}
            aria-label={copy.summaries.card.verdictGroup(item.title ?? item.url)}
            className="relative z-10 flex-wrap pt-1"
          >
            <ToggleGroupItem value={VERDICT_VALUE.worth} className="rounded-full text-xs">
              <ThumbsUp aria-hidden="true" className="size-3.5" />
              {copy.summaries.card.worthWatching}
            </ToggleGroupItem>
            <ToggleGroupItem value={VERDICT_VALUE.notWorth} className="rounded-full text-xs">
              <ThumbsDown aria-hidden="true" className="size-3.5" />
              {copy.summaries.card.notWorthWatching}
            </ToggleGroupItem>
          </ToggleGroup>

          {expanded ? null : <p className="text-muted-foreground line-clamp-2 text-sm">{previewText(item.content)}</p>}
        </div>

        {/* Sibling of the expand button, never nested inside it: a nested button is invalid markup and
            every delete click would also toggle the card. `relative z-10` for the same reason the two
            links above carry it — that button's stretched `::after` covers the whole row and
            otherwise swallows the click first.

            No `mt-1` here, unlike the expand button: the trigger's own `p-1` already supplies that
            4px, so both icons' centres land 12px down and sit on one line. Adding `mt-1` back — the
            obvious symmetry — is what pushed the trash a padding's width below the chevron. */}
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          {confirming ? (
            <>
              <span className="text-muted-foreground text-xs">{copy.summaries.card.deleteQuestion}</span>
              <button
                ref={confirmRef}
                type="button"
                onClick={() => {
                  setConfirming(false);
                  onDelete(item.id);
                }}
                onKeyDown={handleConfirmKeyDown}
                className="text-destructive focus-visible:ring-ring rounded-md px-2 py-0.5 text-xs font-medium outline-none hover:underline focus-visible:ring-2"
              >
                {copy.summaries.card.deleteConfirm}
              </button>
              <button
                type="button"
                onClick={cancelDelete}
                onKeyDown={handleConfirmKeyDown}
                className="text-muted-foreground focus-visible:ring-ring rounded-md px-2 py-0.5 text-xs outline-none hover:underline focus-visible:ring-2"
              >
                {copy.summaries.card.deleteCancel}
              </button>
            </>
          ) : (
            <button
              ref={triggerRef}
              type="button"
              aria-label={copy.summaries.card.deleteSummary(item.title ?? item.url)}
              onClick={() => {
                setConfirming(true);
              }}
              className="text-muted-foreground hover:text-destructive focus-visible:ring-ring rounded-md p-1 transition-colors outline-none focus-visible:ring-2"
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={toggleLabel}
          onClick={() => {
            setExpanded((open) => !open);
          }}
          className="text-muted-foreground focus-visible:after:ring-ring mt-1 shrink-0 rounded-md outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:ring-2"
        >
          <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} aria-hidden="true" />
        </button>
      </div>

      {/* Only ever rendered after a failed deletion has already put this row back — the card does not
          exist while the request is in flight. Same `role="alert"` destructive treatment as
          `DeleteAccountDialog`. */}
      {deleteError ? (
        <p
          role="alert"
          aria-atomic="true"
          className="border-destructive bg-destructive/10 text-destructive mx-4 mb-4 flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-sm"
        >
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          {deleteError}
        </p>
      ) : null}

      {/* A verdict save that failed and rolled back. Same treatment as the delete error above. */}
      {verdictError ? (
        <p
          role="alert"
          aria-atomic="true"
          className="border-destructive bg-destructive/10 text-destructive mx-4 mb-4 flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-sm"
        >
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          {verdictError}
        </p>
      ) : null}

      {expanded ? (
        <div id={contentId} className="border-border mx-auto max-w-[62ch] space-y-2 border-t px-4 py-4">
          <SummaryMarkdown>{item.content}</SummaryMarkdown>
        </div>
      ) : null}
    </article>
  );
}
