import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { VideoThumbnail } from "@/components/summaries/VideoThumbnail";
import { SummaryMarkdown } from "@/components/summaries/SummaryMarkdown";
import { formatCreatedDate, formatDuration, formatPublishedDate } from "@/lib/format";
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

  const duration = formatDuration(item.durationSeconds);
  const published = formatPublishedDate(item.publishedAt);
  // Pre-S-08 rows carry nulls in every descriptive column. Omit the whole row in that case rather
  // than render a line of separators with nothing between them.
  const meta = [item.channelName, duration, published].filter((part): part is string => part !== null);

  const toggleLabel = `${expanded ? copy.summaries.card.collapse : copy.summaries.card.expand} ${copy.summaries.card.summaryOf(item.title ?? item.url)}`;

  return (
    <article className="border-border bg-card hover:bg-accent rounded-xl border transition-colors">
      {/* `relative` anchors the expand button's stretched `::after`, which is what makes the whole
          header row clickable without nesting the heading and paragraphs inside a `<button>`. */}
      <div className="relative flex items-start gap-4 p-4">
        <div className="w-32 shrink-0 sm:w-40">
          {/* Keyed by the thumbnail source: `stage` is a one-shot forward-only guard seeded on mount,
              so a card whose source changes under a list refresh has to remount to retry it. */}
          <VideoThumbnail
            key={`${item.youtubeId}:${item.thumbnailUrlReported ?? ""}`}
            youtubeId={item.youtubeId}
            reportedUrl={item.thumbnailUrlReported}
            title={item.title}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            {/* `url` is NOT NULL, so there is always something to name the card with. */}
            <h3 className="text-card-foreground line-clamp-2 text-sm font-semibold break-words">
              {item.title ?? item.url}
            </h3>
            <CharacterBadge character={item.character} />
          </div>

          {meta.length > 0 ? <p className="text-muted-foreground truncate text-xs">{meta.join(" · ")}</p> : null}

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
        <div id={contentId} className="border-border max-w-[62ch] space-y-2 border-t px-4 py-4">
          <SummaryMarkdown>{item.content}</SummaryMarkdown>
        </div>
      ) : null}
    </article>
  );
}
