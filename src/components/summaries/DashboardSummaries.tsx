import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import GenerateSummaryForm from "@/components/summaries/GenerateSummaryForm";
import { SummaryList } from "@/components/summaries/SummaryList";
import type { PendingSummary } from "@/components/summaries/PendingSummaryCard";
import { useGenerateSummary } from "@/components/hooks/useGenerateSummary";
import type { ChannelCharacter, SummaryListItem } from "@/types";

interface Props {
  initialSummaries: SummaryListItem[];
  initialCredits: number | null;
  listUnavailable: boolean;
}

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
  const [refreshFailed, setRefreshFailed] = useState(false);
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
      void refreshSummaries();
    },
  });

  /**
   * Re-read the saved list so the card for a freshly generated summary is byte-identical to the one
   * a reload would render — the generate response carries no video metadata, so a card assembled
   * from it would quietly differ from itself after a refresh.
   *
   * Best-effort by design. Its failure annotates the list and never discards the paid result already
   * rendered in the dialog, and it retains the pending card rather than clearing it, so the user
   * still sees what was generated.
   */
  async function refreshSummaries() {
    const seq = (refreshSeq.current += 1);
    try {
      const response = await fetch("/api/summaries");
      if (!response.ok) throw new Error(`GET /api/summaries answered ${response.status}`);

      const data: unknown = await response.json();
      const payload = (data ?? {}) as { summaries?: SummaryListItem[] };
      if (!Array.isArray(payload.summaries)) throw new Error("GET /api/summaries returned no list");

      // A response that is no longer the latest is dropped before it touches state — including its
      // success, since a newer re-read is by definition closer to the truth.
      if (seq !== refreshSeq.current) return;
      setSummaries(payload.summaries);
      setUnavailable(false);
      setRefreshFailed(false);
      // Only now, once the fresh list is held, does the pending entry go — so there is no frame in
      // which the summary appears in neither place.
      generation.clearAttempt();
    } catch {
      if (seq !== refreshSeq.current) return;
      setRefreshFailed(true);
    }
  }

  // The in-flight attempt as the list needs to see it. `loading` is checked first on purpose: the
  // confirmation replay generates with `confirm` still set, and reading that first would show a
  // "needs confirmation" card for a request already running.
  const pending: PendingSummary | null =
    generation.attempt === null
      ? null
      : {
          url: generation.attempt.url,
          character: generation.attempt.character,
          status: generation.loading
            ? "generating"
            : generation.confirm !== null
              ? "needs-confirmation"
              : generation.error !== null
                ? "failed"
                : // Committed, and the re-read that will replace this card is in flight (or has
                  // failed, in which case the note above the list explains why it is still here).
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
        refreshFailed={refreshFailed}
        // The 409 can arrive with the dialog closed. Send the user back to the form, where the
        // priced consent copy already lives, rather than quoting the price a second time here.
        onPendingConfirm={() => {
          setDialogOpen(true);
        }}
        onPendingDismiss={generation.clearAttempt}
      />
    </div>
  );
}
