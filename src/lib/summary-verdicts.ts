/**
 * Which watch/skip mark (S-14) a card shows when a re-read of the saved list lands while, or just after,
 * the user changed that mark.
 *
 * The summaries island has two writers of `worthWatching`: the optimistic verdict toggle and the full
 * post-generation re-read. `refreshSeq` orders re-reads against each other and knows nothing about
 * verdicts, so a GET that read the database *before* a PATCH committed can land afterwards and put the
 * old mark back on the card while Postgres holds the new one. This is the verdict half of what
 * `deletedIds` is for deletions.
 *
 * **Keyed on settle time, not click time.** A read started after the click but before the PATCH
 * answered can still have read the old row, so only a read that *started* after the PATCH settled is
 * allowed to speak for that card. Both stamps come from one monotonic clock owned by the caller:
 * `settledAt` is the clock after it was advanced on settle, `readStartedAt` is the clock as the read
 * began — so a read started after the settle has `readStartedAt >= settledAt` and is authoritative.
 *
 * Pure and import-free apart from the type, so the unit project can reach it without a DOM.
 */
import type { SummaryListItem } from "@/types";

/** The mark this session last put on one card, and when the server accepted it (`null`: still in flight). */
export interface LocalVerdict {
  value: boolean | null;
  settledAt: number | null;
}

/**
 * The list as a re-read returned it, with every mark that read cannot yet know about put back.
 *
 * Returns the input array itself when nothing needed overriding, so a caller committing it to state
 * does not churn every card's identity for the common case.
 */
export function overlayLocalVerdicts(
  list: SummaryListItem[],
  local: ReadonlyMap<string, LocalVerdict>,
  readStartedAt: number,
): SummaryListItem[] {
  if (local.size === 0) return list;

  const next = list.map((item) => {
    const entry = local.get(item.id);
    if (entry === undefined) return item;
    const readIsStale = entry.settledAt === null || entry.settledAt > readStartedAt;
    if (!readIsStale || item.worthWatching === entry.value) return item;
    return { ...item, worthWatching: entry.value };
  });
  return next.every((item, index) => item === list[index]) ? list : next;
}
