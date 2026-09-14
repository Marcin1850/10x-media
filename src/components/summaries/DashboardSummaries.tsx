import { useRef, useState } from "react";
import GenerateSummaryForm from "@/components/summaries/GenerateSummaryForm";
import { SummaryList, type UnlistedSummary } from "@/components/summaries/SummaryList";
import type { PendingSummary } from "@/components/summaries/PendingSummaryCard";
import { useGenerateSummary, type LastSuccess } from "@/components/hooks/useGenerateSummary";
import { copy } from "@/lib/copy";
import type { ChannelCharacter, SummaryListItem } from "@/types";

interface Props {
  initialSummaries: SummaryListItem[];
  initialCredits: number | null;
  listUnavailable: boolean;
}

/**
 * Backoff between re-reads that came back without the row we just paid for. One entry per *retry*,
 * so the re-read runs at most `length + 1` times.
 *
 * Short and finite on purpose: this covers a read that raced the write's visibility, not an outage.
 * A list that still lacks the row after ~1s is reported as a stale view the user can reload, which
 * is honest — the alternative, polling until it appears, hides a real backend problem behind a
 * spinner the user paid for.
 */
const REFRESH_RETRY_DELAYS_MS = [250, 750];

/**
 * The summaries surface's single island: it owns the generation hook, the capture bar, and the list.
 *
 * Its reason to exist is lifetime. The capture bar is always mounted now — there is no dialog to
 * unmount it — but the three quote-relevant inputs and the request lifecycle still live here rather
 * than in the form, because a generation that outlives a page navigation away from `/summaries` is
 * not a case this app tries to support, while a generation that outlives the form re-rendering for
 * an unrelated reason is. No `forceMount` concern remains once the dialog is gone; the state stays
 * lifted anyway so the quote and the inputs it was priced from cannot drift apart.
 *
 * **Single owner of list state.** `summaries` is held here and passed down to the controlled
 * `SummaryList`, which keeps only its filter. The re-read after a generation therefore has exactly
 * one place to land, and the list never holds a second source of truth for the same corpus.
 *
 * **Two writers, one filter.** S-03 gave that list a second writer — a delete — so the two can race:
 * a post-generation re-read issued before a deletion commits will legitimately still contain the
 * deleted row. Removing the card is therefore not enough; every list that enters `summaries` goes
 * through `commitSummaries`, which subtracts `deletedIds`. That makes the outcome independent of
 * arrival order rather than dependent on it.
 */
export function SummariesSurface({ initialSummaries, initialCredits, listUnavailable }: Props) {
  // The capture bar's URL input. A long-video 409 can arrive with the bar scrolled out of view — the
  // pending card's cost gate already states everything (thumbnail, cost, balance); this just returns
  // focus to where "Generate anyway" lives, replacing the old dialog reopen.
  const urlInputRef = useRef<HTMLInputElement>(null);
  // The three quote-relevant inputs.
  const [url, setUrl] = useState("");
  const [character, setCharacter] = useState<ChannelCharacter>("informational");
  const [allowLong, setAllowLong] = useState(false);
  /**
   * Every summary this session has deleted. A tombstone set, not a mirror of the list.
   *
   * A `useRef` for the same reason `refreshSeq` is one: the value must be correct **across an
   * await**, not merely eventually. Both writers of `summaries` cross one — `refreshSummaries`
   * awaits the fetch, and the generation `onSuccess` callback is captured at submit time (the
   * closure hazard the comment above already warns about) — so a `useState<Set>` read from either
   * closure can predate a deletion that happened during the wait and put the deleted card straight
   * back. The ref is mutated synchronously on confirm and on rollback, and every commit of
   * `summaries` reads `deletedIds.current` after its last `await`.
   *
   * Ids are kept for the life of the page. That is bounded by the number of deletions in one
   * session and costs nothing.
   */
  const deletedIds = useRef<Set<string>>(new Set());
  // The one list that is committed *without* passing through `commitSummaries`, and the only one
  // that can be: it lands on the first render, before any delete can have happened, and reading
  // `deletedIds.current` during render is exactly what `react-hooks/refs` forbids. Every later list
  // — from the re-read, or from anything added after it — goes through the filter.
  const [summaries, setSummaries] = useState<SummaryListItem[]>(initialSummaries);
  // Per-id message from a deletion that failed and put its row back. There is deliberately no
  // "ids in flight" state alongside it: an id being deleted is exactly an id in `deletedIds` with
  // no card rendered, and tracking that twice would be two sources of truth for one fact.
  const [deleteErrors, setDeleteErrors] = useState<Record<string, string | undefined>>({});
  /**
   * The verdict lock (S-14): ids whose PATCH is in flight. A ref for the same reason `deletedIds` is one —
   * two clicks inside one render would both read a stale state copy and both pass the "already saving"
   * check. `verdictSaving` mirrors it for rendering (the disabled toggle); the ref is the authority.
   */
  const verdictInFlight = useRef<Set<string>>(new Set());
  const [verdictSaving, setVerdictSaving] = useState<Record<string, boolean | undefined>>({});
  const [verdictErrors, setVerdictErrors] = useState<Record<string, string | undefined>>({});
  // Seeded from the server read, but not frozen to it: a re-read that succeeds proves the corpus is
  // readable again, and continuing to show "we couldn't load your summaries" over a list we are
  // holding would be the same wrong statement about their data, just in the other direction.
  const [unavailable, setUnavailable] = useState(listUnavailable);
  // The summary that is saved but absent from the list on screen, if any — see `UnlistedSummary`
  // for why this is an identity and not a "the last refresh failed" boolean.
  const [unlisted, setUnlisted] = useState<UnlistedSummary | null>(null);
  // Monotonic id of the latest re-read. Two generations in quick succession can have their responses
  // land out of order, and the older one would otherwise overwrite the newer list — the same class of
  // bug `requestSeq` guards on the generate path.
  const refreshSeq = useRef(0);

  const generation = useGenerateSummary({
    initialCredits,
    // Clearing policy: the inputs are cleared ONLY on a successful generation, so the next summary
    // starts from a clean form. An error and a pending confirmation both retain them — each is a
    // state the user may want to retry or confirm from.
    //
    // `allowLong` in particular must not survive: it is per-video consent to a 2-credit charge, and
    // leaving it set would let the NEXT long video be charged double with no confirmation prompt at
    // all. `character` is a preference rather than consent, so it stays.
    //
    // A paid success is applied even when it is stale (see `useGenerateSummary`), so the URL is
    // cleared only if the field still holds the URL that was summarized — otherwise the success of
    // an earlier request would erase a newer URL the user has already typed. The comparison must be
    // a functional update: this callback is captured at submit time, so its closure sees the
    // submitted URL, not the live one. `allowLong` is cleared either way — losing a toggle is a
    // re-click, keeping one is a silent double charge.
    onSuccess: (success) => {
      setUrl((current) => (current === success.url ? "" : current));
      setAllowLong(false);
      // Driven off the hook's success *callback* rather than an effect watching `lastSuccess.seq`:
      // a success is an event, and syncing state in an effect that reacts to it is both the wrong
      // model and a cascading render the react-hooks lint rejects outright. The callback fires once
      // per committed generation, which is exactly once per re-read we want.
      void refreshSummaries(success);
    },
  });

  /** Drops anything already deleted. Reads the ref, never a state copy — see `deletedIds`. */
  function keepUndeleted(list: SummaryListItem[]): SummaryListItem[] {
    return list.filter((item) => !deletedIds.current.has(item.id));
  }

  /**
   * The one way a list becomes `summaries`. Filtering lives here rather than at each call site so a
   * future third writer cannot forget it, and it reads `deletedIds.current` at commit time — which
   * is what makes the outcome independent of when the list was fetched. `refreshSeq` orders re-reads
   * against each other and knows nothing about deletions; this is the other half.
   */
  function commitSummaries(list: SummaryListItem[]) {
    setSummaries(keepUndeleted(list));
  }

  /** One read of the saved list. Throws on anything that isn't a usable list. */
  async function readSummaries(): Promise<SummaryListItem[]> {
    const response = await fetch("/api/summaries");
    if (!response.ok) throw new Error(`GET /api/summaries answered ${response.status}`);

    const data: unknown = await response.json();
    const payload = (data ?? {}) as { summaries?: SummaryListItem[] };
    if (!Array.isArray(payload.summaries)) throw new Error("GET /api/summaries returned no list");
    return payload.summaries;
  }

  /**
   * Re-read the saved list so the card for a freshly generated summary is byte-identical to the one
   * a reload would render — the generate response carries no video metadata, so a card assembled
   * from it would quietly differ from itself after a refresh.
   *
   * Best-effort by design. Its failure annotates the list and never discards the paid result the
   * generation hook already committed, and it retains the pending card rather than clearing it, so
   * the user still sees what was generated.
   *
   * **Bound to the success it serves.** A read is only allowed to retire the pending card once it
   * can prove the saved row is in the list it returned, and then only the attempt this success came
   * from — a generation started while the read was in flight is newer, live work whose card must
   * survive. Neither guarantee follows from `refreshSeq`, which orders reads against each other and
   * knows nothing about which attempt is on screen.
   */
  async function refreshSummaries(success: LastSuccess) {
    const seq = (refreshSeq.current += 1);
    let list: SummaryListItem[] | null = null;
    let landed = false;

    for (let attempt = 0; attempt <= REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const read = await readSummaries();
        // A response that is no longer the latest is dropped before it touches state — including its
        // success, since a newer re-read is by definition closer to the truth.
        if (seq !== refreshSeq.current) return;
        list = read;
        landed = read.some((item) => item.id === success.summaryId);
      } catch {
        if (seq !== refreshSeq.current) return;
      }

      if (landed || attempt === REFRESH_RETRY_DELAYS_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAYS_MS[attempt]));
      if (seq !== refreshSeq.current) return;
    }

    // Any list we did get is fresher than the one on screen, so it lands even when the new row is
    // missing from it — being behind by one row beats being behind by everything since page load.
    if (list !== null) {
      // Committed here, after the last `await` above, so a deletion that happened while this read
      // was in flight still suppresses its row.
      commitSummaries(list);
      setUnavailable(false);
    }
    setUnlisted((current) => {
      // This re-read did not produce its own row: that summary is the orphan now. It replaces any
      // earlier one — the next successful read surfaces both rows regardless, so what is lost is a
      // mention, not a summary.
      if (!landed) return { summaryId: success.summaryId, url: success.url };
      // Otherwise an existing orphan is retired only by a list that actually contains it. A read
      // started for a *different* success still counts: any list showing the row proves the gap is
      // closed. What must not happen is this success's own landing being read as evidence about a
      // row nobody has seen since it was written — its card is already gone by then, and clearing
      // here would leave that summary in neither place.
      if (current === null) return null;
      return list?.some((item) => item.id === current.summaryId) ? null : current;
    });
    // Only now, with the saved row proven present, does the pending entry go — so there is no frame
    // in which the summary appears in neither place.
    if (landed) generation.clearAttempt(success.attemptId);
  }

  /** Forget an id's failure message. The card cannot do it: the error is owned here. */
  function clearDeleteError(id: string) {
    setDeleteErrors((current) =>
      current[id] === undefined ? current : Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
    );
  }

  /**
   * Which way an ambiguous delete actually went, asked of the only authority on it — the saved list.
   *
   * A probe, not a refresh: the list it reads is fresher than the one on screen, but committing it
   * would add a second writer of `summaries` outside `refreshSeq`'s ordering, and the caller is
   * mid-delete holding a tombstone. It answers the question and touches no state.
   */
  async function reconcileDelete(id: string): Promise<"present" | "absent" | "unknown"> {
    try {
      return (await readSummaries()).some((item) => item.id === id) ? "present" : "absent";
    } catch {
      return "unknown";
    }
  }

  /**
   * Delete one summary, optimistically.
   *
   * The card goes the moment the user confirms and only comes back if the server says the row still
   * exists. **`200` and `404` are both terminal success** — under RLS "not yours" and "already gone"
   * are the same observation, so a `404` means the summary is gone and the removal was right; the
   * obvious "non-2xx → revert" reading would resurrect a row that no longer exists (a second tab, or
   * a retried request). Any other *status* — a 5xx, a `401`, a `400`/`503` — restores the card,
   * because in every one of those the server answered and the row is still there.
   *
   * A **thrown** fetch is the exception, because it is not an answer: the request may have reached
   * Postgres and committed before the response was lost. That case is settled by `reconcileDelete`
   * against the saved list rather than assumed — the card stays gone, comes back, or comes back
   * reporting an unknown outcome, on what the list says.
   *
   * Ordering is load-bearing on both paths. The tombstone goes into `deletedIds` **before** the row
   * leaves `summaries`, so a re-read landing in between cannot re-add it; and it is removed
   * **before** the row is restored, or the restore would be filtered straight back out by the
   * tombstone it is undoing.
   */
  async function handleDelete(id: string) {
    // From this render's list: the click came from a card that is in it.
    const removed = summaries.find((item) => item.id === id);

    deletedIds.current.add(id);
    setSummaries((current) => current.filter((item) => item.id !== id));
    clearDeleteError(id);
    // The note says this summary is saved but missing from the list. Once the user has deliberately
    // removed it, that is a wrong statement about their data — the thing `SummaryList`'s three
    // non-list states exist to avoid.
    setUnlisted((current) => (current !== null && current.summaryId === id ? null : current));

    let message: string;
    try {
      const response = await fetch(`/api/summaries/${id}`, { method: "DELETE" });
      if (response.ok || response.status === 404) return;
      message = copy.errors.summaryDeleteFailed;
    } catch {
      // A rejected fetch is the one outcome that is not an answer: the request may have reached
      // Postgres and committed before the response was lost. Restoring the card here would assert
      // the row survived — the one claim we cannot make. Ask the list instead.
      const state = await reconcileDelete(id);
      // Deleted after all: the tombstone stays and the card stays gone.
      if (state === "absent") return;
      message = state === "present" ? copy.errors.summaryDeleteNetwork : copy.errors.summaryDeleteUnknown;
    }

    deletedIds.current.delete(id);
    if (removed !== undefined) {
      setSummaries((current) =>
        current.some((item) => item.id === id)
          ? current
          : // Back into `created_at` order — the list is newest-first, and re-appending would move a
            // months-old summary to the top, which misreports when it was generated.
            [...current, removed].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    }
    setDeleteErrors((current) => ({ ...current, [id]: message }));
  }

  /** Put one card's mark to `value` without touching anything else about the list. */
  function applyVerdict(id: string, value: boolean | null) {
    setSummaries((current) => current.map((item) => (item.id === id ? { ...item, worthWatching: value } : item)));
  }

  /**
   * Set, switch or clear one summary's watch/skip verdict, optimistically (S-14).
   *
   * **Lock ordering.** The previous value is captured at click time, then the lock, the optimistic value
   * and the cleared error are set together. The lock is released only once the response has settled
   * (kept, rolled back, or removed). Capturing `previous` at click time is correct *because* of the lock:
   * no second click on this card can land in between and change what "previous" means. Clicks during a
   * save are ignored rather than queued — setting a mark is idempotent and free, so the user re-clicks.
   *
   * **Outcomes.** `200` keeps the value. `404` means the summary is gone (deleted in another tab — under
   * RLS "not yours" and "already gone" are one observation), so the card is removed through the same
   * tombstone a delete uses, and a concurrent re-read cannot put it back. Any other status, or a thrown
   * fetch, restores the previous mark with an inline error. Unlike a delete there is no reconcile step on a
   * network failure: a retry of an idempotent mark converges on its own.
   */
  async function handleSetVerdict(id: string, next: boolean | null) {
    if (verdictInFlight.current.has(id)) return;
    const previous = summaries.find((item) => item.id === id)?.worthWatching ?? null;

    verdictInFlight.current.add(id);
    setVerdictSaving((current) => ({ ...current, [id]: true }));
    applyVerdict(id, next);
    setVerdictErrors((current) =>
      current[id] === undefined ? current : Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)),
    );

    try {
      const response = await fetch(`/api/summaries/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ worth_watching: next }),
      });
      if (response.status === 404) {
        deletedIds.current.add(id);
        setSummaries((current) => current.filter((item) => item.id !== id));
        setUnlisted((current) => (current !== null && current.summaryId === id ? null : current));
      } else if (!response.ok) {
        applyVerdict(id, previous);
        setVerdictErrors((current) => ({ ...current, [id]: copy.errors.summaryVerdictFailed }));
      }
    } catch {
      applyVerdict(id, previous);
      setVerdictErrors((current) => ({ ...current, [id]: copy.errors.summaryVerdictFailed }));
    } finally {
      verdictInFlight.current.delete(id);
      setVerdictSaving((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    }
  }

  const attempt = generation.attempt;
  const lastSuccess = generation.lastSuccess;
  // Whether the attempt on screen is the one the last success settled. `attemptId` is what makes
  // this answerable at all: `lastSuccess` outlives the attempt it came from, so without it a stale
  // success would label a brand-new generation as already saved.
  const committed = attempt !== null && lastSuccess?.attemptId === attempt.id;
  // ...and whether that same summary is the one missing from the list. Checked by id rather than by
  // "a refresh failed at some point", so the card never reports another generation's orphan as its
  // own state.
  const committedUnlisted = committed && unlisted !== null && unlisted.summaryId === lastSuccess.summaryId;

  // The in-flight attempt as the list needs to see it. `loading` is checked first on purpose: the
  // confirmation replay generates with `confirm` still set, and reading that first would show a
  // "needs confirmation" card for a request already running.
  const pending: PendingSummary | null =
    attempt === null
      ? null
      : {
          url: attempt.url,
          character: attempt.character,
          status: generation.loading
            ? "generating"
            : generation.confirm !== null
              ? "needs-confirmation"
              : generation.error !== null
                ? "failed"
                : committed
                  ? // Paid and persisted. What is left is the re-read that replaces this card —
                    // either running, or given up on, and the copy must not confuse the two with
                    // work that hasn't happened yet.
                    committedUnlisted
                    ? "saved-refresh-failed"
                    : "saved"
                  : // Not loading, no outcome, no success event: the endpoint answered 200 without a
                    // `summaryId`, so the hook raised no success. Nothing has settled that this card
                    // can report, so it keeps naming the attempt as running.
                    "generating",
          error: generation.error,
          charged: generation.charged,
        };

  return (
    <div className="space-y-6">
      <h1 className="font-display text-foreground text-lg font-semibold">{copy.summaries.page.heading}</h1>

      <GenerateSummaryForm
        url={url}
        onUrlChange={(value) => {
          setUrl(value);
          generation.inputsChanged();
        }}
        character={character}
        onCharacterChange={(value) => {
          setCharacter(value);
          generation.inputsChanged();
        }}
        allowLong={allowLong}
        onAllowLongChange={(value) => {
          setAllowLong(value);
          // Keeps the quote: the toggle does not change which video is priced, and it is the
          // very consent the confirmation prompt is asking for.
          generation.inputsChanged({ keepConfirm: true });
        }}
        generation={generation}
        urlInputRef={urlInputRef}
      />

      <SummaryList
        summaries={summaries}
        listUnavailable={unavailable}
        pending={pending}
        confirm={generation.confirm}
        credits={generation.credits}
        unlisted={unlisted}
        // The gate's full detail already renders in the pending card; this just returns the user's
        // focus to the capture bar, where the submit button is the actual "generate anyway" trigger.
        onPendingConfirm={() => {
          urlInputRef.current?.focus();
        }}
        // Wrapped rather than passed through: `clearAttempt` now takes an optional attempt id, and
        // a bare handler reference would hand it the click event. The user dismisses the card they
        // can see, so clearing whatever is current is the right behaviour here.
        onPendingDismiss={() => {
          generation.clearAttempt();
        }}
        onDeleteSummary={(id) => {
          void handleDelete(id);
        }}
        deleteErrors={deleteErrors}
        onClearDeleteError={clearDeleteError}
        onSetVerdict={(id, value) => {
          void handleSetVerdict(id, value);
        }}
        verdictSaving={verdictSaving}
        verdictErrors={verdictErrors}
      />
    </div>
  );
}
