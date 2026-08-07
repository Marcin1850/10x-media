import { useState } from "react";
import { CircleAlert, Sparkles } from "lucide-react";
import { SummaryCard } from "@/components/summaries/SummaryCard";
import { cn } from "@/lib/utils";
import type { ChannelCharacter, SummaryListItem } from "@/types";

interface Props {
  /**
   * Controlled, never seeded. The summaries are always owned by the caller, so Phase 4's refresh has
   * exactly one owner and this component never holds a second source of truth for the same list.
   */
  summaries: SummaryListItem[];
  /**
   * The read failed. Distinct from an empty list on purpose — see the non-list states below.
   */
  listUnavailable: boolean;
}

type Filter = "all" | ChannelCharacter;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "informational", label: "Informational" },
  { value: "educational", label: "Educational" },
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
export function SummaryList({ summaries, listUnavailable }: Props) {
  const [filter, setFilter] = useState<Filter>("all");

  const visible = filter === "all" ? summaries : summaries.filter((item) => item.character === filter);

  if (listUnavailable) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-900/20 px-4 py-3 text-sm text-red-200">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>We couldn&apos;t load your summaries just now. Reload the page to try again.</span>
      </div>
    );
  }

  if (summaries.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center">
        <Sparkles className="mx-auto size-5 text-blue-100/40" aria-hidden="true" />
        <p className="mt-2 text-sm text-blue-100/70">You haven&apos;t generated any summaries yet.</p>
        <p className="text-xs text-blue-100/40">Paste a YouTube URL above to generate your first one.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by channel character">
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
                  ? "border-purple-400 bg-purple-500/20 text-white"
                  : "border-white/15 bg-white/5 text-blue-100/70 hover:bg-white/10",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center">
          <p className="text-sm text-blue-100/70">No summaries match this filter.</p>
          <button
            type="button"
            onClick={() => {
              setFilter("all");
            }}
            className="mt-2 text-xs text-purple-300 transition-colors hover:text-purple-100 hover:underline"
          >
            Show all summaries
          </button>
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((item) => (
            <li key={item.id}>
              <SummaryCard item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
