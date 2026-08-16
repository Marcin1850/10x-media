import { useId, useState } from "react";
import { Calendar, ChevronDown, Clock } from "lucide-react";
import { VideoThumbnail } from "@/components/summaries/VideoThumbnail";
import { SummaryMarkdown } from "@/components/summaries/SummaryMarkdown";
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
 * One saved summary: the video's thumbnail and metadata, the character it was generated for, and the
 * body, collapsed by default and expanding in place.
 *
 * The creation date is an addition beyond the card fields named in the brief, kept deliberately: the
 * list is flat and accepts the same video appearing once per character, so "generated on" is what
 * distinguishes two otherwise near-identical cards. `created_at` is read regardless — it is the
 * newest-first sort key.
 */
export function SummaryCard({ item }: Props) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  // `daysSince` reads the real clock (see its doc comment) — computed once on the server and again,
  // independently, during hydration. Held back until after mount so the very first client render
  // matches the server's exactly; a few-ms gap straddling UTC midnight would otherwise make the two
  // disagree, a real hydration mismatch. Recomputed on every render once mounted, so the suffix still
  // advances live as the page stays open, same as before.
  const mounted = useHasMounted();

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

          {expanded ? null : <p className="text-muted-foreground line-clamp-2 text-sm">{previewText(item.content)}</p>}
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

      {expanded ? (
        <div id={contentId} className="border-border mx-auto max-w-[62ch] space-y-2 border-t px-4 py-4">
          <SummaryMarkdown>{item.content}</SummaryMarkdown>
        </div>
      ) : null}
    </article>
  );
}
