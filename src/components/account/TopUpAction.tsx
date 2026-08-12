import { useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportUnsupportedFeature } from "@/lib/services/reporting";
import { copy } from "@/lib/copy";

/**
 * The single owner of the top-up affordance (decision #2 — there is no self-serve top-up). The
 * notice, the emitted event and the dismiss behaviour are shared via `useTopUpAction` so the
 * avatar menu (phase 3, which needs its trigger and notice as separate elements to keep Radix's
 * menu-item semantics valid) and the account page's credit row (phase 7, a plain button) cannot
 * drift apart.
 */
export function useTopUpAction() {
  const [revealed, setRevealed] = useState(false);

  function trigger() {
    // One event per click, unconditionally — never emitted at render time, so a re-render while
    // the notice stays open cannot re-emit on its own.
    reportUnsupportedFeature("top-up");
    setRevealed(true);
  }

  function dismiss() {
    setRevealed(false);
  }

  return { revealed, trigger, dismiss };
}

export function TopUpNotice({ dismiss }: { dismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="border-border bg-card text-muted-foreground mt-2 flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs"
    >
      <span>{copy.nav.topUpNotice}</span>
      <button
        type="button"
        aria-label={copy.nav.dismiss}
        onClick={dismiss}
        className="text-muted-foreground hover:text-foreground shrink-0"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

export function TopUpAction() {
  const { revealed, trigger, dismiss } = useTopUpAction();

  return (
    <div>
      <Button type="button" variant="outline" size="sm" onClick={trigger}>
        {copy.nav.topUp}
      </Button>
      {revealed ? <TopUpNotice dismiss={dismiss} /> : null}
    </div>
  );
}
