import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import GenerateSummaryForm from "@/components/summaries/GenerateSummaryForm";
import { SummaryList } from "@/components/summaries/SummaryList";
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
 * `SummaryList`, which keeps only its filter. Phase 3 seeds it once and never mutates it; the
 * refresh machinery is Phase 4's, but the ownership is settled here so Phase 4 restructures nothing.
 */
export function DashboardSummaries({ initialSummaries, initialCredits, listUnavailable }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // The three quote-relevant inputs, held above the dialog so closing it cannot destroy them.
  const [url, setUrl] = useState("");
  const [character, setCharacter] = useState<ChannelCharacter>("informational");
  const [allowLong, setAllowLong] = useState(false);
  const [summaries] = useState<SummaryListItem[]>(initialSummaries);

  const generation = useGenerateSummary({
    initialCredits,
    // Clearing policy: the inputs are cleared ONLY on a successful generation, so the next summary
    // starts from a clean form. An error, a dismissed dialog and a pending confirmation all retain
    // them — each is a state the user may want to retry or confirm from.
    //
    // `allowLong` in particular must not survive: it is per-video consent to a 2-credit charge, and
    // leaving it set would let the NEXT long video be charged double with no confirmation prompt at
    // all. `character` is a preference rather than consent, so it stays.
    onSuccess: () => {
      setUrl("");
      setAllowLong(false);
    },
  });

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

      <SummaryList summaries={summaries} listUnavailable={listUnavailable} />
    </div>
  );
}
