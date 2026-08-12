import { useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportUnsupportedFeature } from "@/lib/services/reporting";
import { copy } from "@/lib/copy";

/**
 * The single owner of the top-up affordance (decision #2 — there is no self-serve top-up).
 * `variant` only changes how the trigger presents; the notice, the emitted event and the dismiss
 * behaviour are identical so the avatar menu (phase 3) and the account page's credit row (phase 7)
 * cannot drift apart.
 */
type Variant = "menu-item" | "row-button";

interface Props {
  variant: Variant;
}

export function TopUpAction({ variant }: Props) {
  const [revealed, setRevealed] = useState(false);

  function handleClick() {
    // One event per click, not per render — the notice staying open on a later re-render must not
    // re-emit.
    if (!revealed) {
      reportUnsupportedFeature("top-up");
    }
    setRevealed(true);
  }

  return (
    <div>
      {variant === "menu-item" ? (
        <button
          type="button"
          onClick={handleClick}
          className="hover:bg-accent hover:text-accent-foreground flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-hidden select-none"
        >
          {copy.nav.topUp}
        </button>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={handleClick}>
          {copy.nav.topUp}
        </Button>
      )}
      {revealed ? (
        <div
          role="status"
          aria-live="polite"
          className="border-border bg-card text-muted-foreground mt-2 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"
        >
          <span>{copy.nav.topUpNotice}</span>
          <button
            type="button"
            aria-label={copy.nav.dismiss}
            onClick={() => {
              setRevealed(false);
            }}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
