import { describe, expect, it } from "vitest";
import { overlayLocalVerdicts, type LocalVerdict } from "@/lib/summary-verdicts";
import type { SummaryListItem } from "@/types";

/**
 * `overlayLocalVerdicts` — which mark a card shows when a list re-read races a verdict change.
 *
 * Oracle: the implementation review's F1 contract (`context/changes/summary-watch-verdict/reviews/
 * impl-review.md`) — the card must show the verdict the server accepted, a read that could have been
 * issued before that acceptance must not overwrite it, and a read issued after it is the truth — plus
 * the verdict outcomes in `plan.md` Phase 3 (in flight → optimistic value shown). Not derived from the
 * branch that implements it.
 */

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const OTHER_ID = "9b2f7c1e-2a44-4d0b-8f6e-7a1c2d3e4f50";

function item(id: string, worthWatching: boolean | null): SummaryListItem {
  return {
    id,
    character: "informational",
    content: "",
    createdAt: "2026-09-01T10:00:00.000Z",
    youtubeId: "dQw4w9WgXcQ",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: null,
    thumbnailUrlReported: null,
    channelName: null,
    channelId: null,
    durationSeconds: null,
    publishedAt: null,
    worthWatching,
  };
}

function markOf(list: SummaryListItem[], id: string) {
  return list.find((entry) => entry.id === id)?.worthWatching;
}

describe("overlayLocalVerdicts", () => {
  it.each<{
    name: string;
    entry: LocalVerdict;
    readStartedAt: number;
    readValue: boolean | null;
    shown: boolean | null;
  }>([
    // The PATCH has not answered: whatever the read saw, the optimistic mark stays.
    {
      name: "a PATCH still in flight keeps the local mark",
      entry: { value: true, settledAt: null },
      readStartedAt: 7,
      readValue: null,
      shown: true,
    },
    // The read began before the server accepted the mark, so it may hold the old row.
    {
      name: "a read started before the PATCH settled cannot overwrite it",
      entry: { value: false, settledAt: 3 },
      readStartedAt: 2,
      readValue: true,
      shown: false,
    },
    // The read began after acceptance — it is the database, and the database wins (another tab changed it).
    {
      name: "a read started after the PATCH settled is authoritative",
      entry: { value: true, settledAt: 3 },
      readStartedAt: 4,
      readValue: false,
      shown: false,
    },
    // Same clock value: the read started once the settle had already advanced the clock.
    {
      name: "a read started at the settle tick is authoritative",
      entry: { value: true, settledAt: 3 },
      readStartedAt: 3,
      readValue: null,
      shown: null,
    },
    // Clearing a mark is a verdict too, and must be protected like setting one.
    {
      name: "a cleared mark is protected from a stale read",
      entry: { value: null, settledAt: null },
      readStartedAt: 0,
      readValue: true,
      shown: null,
    },
  ])("$name", ({ entry, readStartedAt, readValue, shown }) => {
    const result = overlayLocalVerdicts([item(ID, readValue)], new Map([[ID, entry]]), readStartedAt);

    expect(markOf(result, ID)).toBe(shown);
  });

  it("leaves cards with no local verdict exactly as the read returned them", () => {
    const read = [item(ID, true), item(OTHER_ID, false)];

    const result = overlayLocalVerdicts(read, new Map([[ID, { value: null, settledAt: null }]]), 0);

    expect(markOf(result, OTHER_ID)).toBe(false);
    expect(markOf(result, ID)).toBeNull();
  });

  it("returns the read itself when nothing needed overriding", () => {
    const read = [item(ID, true)];

    expect(overlayLocalVerdicts(read, new Map(), 0)).toBe(read);
    expect(overlayLocalVerdicts(read, new Map([[ID, { value: true, settledAt: null }]]), 0)).toBe(read);
  });

  it("does not mutate the list it was given", () => {
    const read = [item(ID, null)];

    overlayLocalVerdicts(read, new Map([[ID, { value: true, settledAt: null }]]), 0);

    expect(read[0].worthWatching).toBeNull();
  });

  it("keeps a mark the server accepted when a GET issued before the click lands after the PATCH", () => {
    // Timeline on one clock: GET starts (clock 0) → click → PATCH 200 advances the clock to 1 → GET lands
    // carrying the pre-click row.
    let clock = 0;
    const readStartedAt = clock;
    const local = new Map<string, LocalVerdict>([[ID, { value: true, settledAt: null }]]);
    local.set(ID, { value: true, settledAt: (clock += 1) });
    const staleRead = [item(ID, null)];

    expect(markOf(overlayLocalVerdicts(staleRead, local, readStartedAt), ID)).toBe(true);

    // The next re-read starts after the settle and reflects the database — including a change made
    // elsewhere (another tab) since.
    const freshRead = [item(ID, false)];
    expect(markOf(overlayLocalVerdicts(freshRead, local, clock), ID)).toBe(false);
  });
});
