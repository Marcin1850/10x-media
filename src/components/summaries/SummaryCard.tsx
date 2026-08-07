import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { VideoThumbnail } from "@/components/summaries/VideoThumbnail";
import { SummaryMarkdown } from "@/components/summaries/SummaryMarkdown";
import { formatCreatedDate, formatDuration, formatPublishedDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChannelCharacter, SummaryListItem } from "@/types";

interface Props {
  item: SummaryListItem;
}

const CHARACTER_LABEL: Record<ChannelCharacter, string> = {
  informational: "Informational",
  educational: "Educational",
};

const CHARACTER_BADGE: Record<ChannelCharacter, string> = {
  informational: "border-blue-400/40 bg-blue-500/15 text-blue-100",
  educational: "border-purple-400/40 bg-purple-500/15 text-purple-100",
};

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

  return (
    <article className="rounded-xl border border-white/10 bg-white/5 transition-colors hover:bg-white/[0.07]">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => {
          setExpanded((open) => !open);
        }}
        className="flex w-full items-start gap-4 rounded-xl p-4 text-left"
      >
        <div className="w-32 shrink-0 sm:w-40">
          <VideoThumbnail youtubeId={item.youtubeId} reportedUrl={item.thumbnailUrlReported} title={item.title} />
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start justify-between gap-2">
            {/* `url` is NOT NULL, so there is always something to name the card with. */}
            <h3 className="line-clamp-2 text-sm font-semibold break-words text-white">{item.title ?? item.url}</h3>
            <span
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
                CHARACTER_BADGE[item.character],
              )}
            >
              {CHARACTER_LABEL[item.character]}
            </span>
          </div>

          {meta.length > 0 ? <p className="truncate text-xs text-blue-100/60">{meta.join(" · ")}</p> : null}

          <p className="text-xs text-blue-100/40">Generated {formatCreatedDate(item.createdAt)}</p>

          {expanded ? null : <p className="line-clamp-2 text-sm text-blue-50/70">{previewText(item.content)}</p>}
        </div>

        <ChevronDown
          className={cn("mt-1 size-4 shrink-0 text-blue-100/50 transition-transform", expanded && "rotate-180")}
          aria-hidden="true"
        />
      </button>

      {expanded ? (
        <div id={contentId} className="space-y-2 border-t border-white/10 px-4 py-4">
          <SummaryMarkdown>{item.content}</SummaryMarkdown>
        </div>
      ) : null}
    </article>
  );
}
