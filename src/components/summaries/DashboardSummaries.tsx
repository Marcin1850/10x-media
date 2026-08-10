import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import GenerateSummaryForm from "@/components/summaries/GenerateSummaryForm";
import { SummaryList, type UnlistedSummary } from "@/components/summaries/SummaryList";
import type { PendingSummary } from "@/components/summaries/PendingSummaryCard";
import { useGenerateSummary, type LastSuccess } from "@/components/hooks/useGenerateSummary";
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
 * The dashboard's single island: it owns the generation hook, the dialog that hosts the form, and
 * the list.
 *
 * Its reason to exist is lifetime. The dialog is freely dismissable and `ui/dialog` unmounts its
 * content on close, so a `GenerateSummaryForm` that owned its own request could not finish a paid
 * generation the user walked away from. Everything that must outlive the dialog — the request
 * lifecycle in `useGenerateSummary`, and the three inputs the quote is priced from — lives here
 * instead. No `forceMount` is needed once the state is at this level.
 *
 * **Single owner of list state.** `summaries` is held here and passed down to the controlled
 * `SummaryList`, which keeps only its filter. The re-read after a generation therefore has exactly
 * one place to land, and the list never holds a second source of truth for the same corpus.
 */
export function DashboardSummaries({ initialSummaries, initialCredits, listUnavailable }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // The three quote-relevant inputs, held above the dialog so closing it cannot destroy them.
  const [url, setUrl] = useState("");
  const [character, setCharacter] = useState<ChannelCharacter>("informational");
  const [allowLong, setAllowLong] = useState(false);
  const [summaries, setSummaries] = useState<SummaryListItem[]>(initialSummaries);
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
    // starts from a clean form. An error, a dismissed dialog and a pending confirmation all retain
    // them — each is a state the user may want to retry or confirm from.
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
   * Best-effort by design. Its failure annotates the list and never discards the paid result already
   * rendered in the dialog, and it retains the pending card rather than clearing it, so the user
   * still sees what was generated.
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
      setSummaries(list);
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
        };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-white">Your summaries</h2>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button
              type="button"
              className="rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
            >
              <Plus className="size-4" />
              New summary
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto border-white/10 bg-[#0f1529] text-white sm:max-w-lg">
            {/* Radix requires a title and description for the dialog's accessible name. The form
                carries its own visible heading next to the credit chip, so these stay screen-reader
                only rather than duplicating it. */}
            <DialogTitle className="sr-only">Generate a summary</DialogTitle>
            <DialogDescription className="sr-only">
              Paste a YouTube URL and choose the channel character to generate a summary.
            </DialogDescription>
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
            />
          </DialogContent>
        </Dialog>
      </div>

      <SummaryList
        summaries={summaries}
        listUnavailable={unavailable}
        pending={pending}
        unlisted={unlisted}
        // The 409 can arrive with the dialog closed. Send the user back to the form, where the
        // priced consent copy already lives, rather than quoting the price a second time here.
        onPendingConfirm={() => {
          setDialogOpen(true);
        }}
        // Wrapped rather than passed through: `clearAttempt` now takes an optional attempt id, and
        // a bare handler reference would hand it the click event. The user dismisses the card they
        // can see, so clearing whatever is current is the right behaviour here.
        onPendingDismiss={() => {
          generation.clearAttempt();
        }}
      />
    </div>
  );
}
