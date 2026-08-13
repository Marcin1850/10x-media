import React from "react";
import type { RefObject } from "react";
import { Link2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FormField } from "@/components/auth/FormField";
import { ServerError } from "@/components/auth/ServerError";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/copy";
import type { UseGenerateSummary } from "@/components/hooks/useGenerateSummary";
import { extractYoutubeId } from "@/lib/services/summaries";
import type { ChannelCharacter } from "@/types";

interface Props {
  /**
   * The three quote-relevant inputs are controlled by the parent, not held here. The parent
   * outlives this form's own mount lifetime — see `SummariesSurface` — and keeping the quote and the
   * inputs it was priced from together in one place is what stops them drifting apart.
   */
  url: string;
  onUrlChange: (value: string) => void;
  character: ChannelCharacter;
  onCharacterChange: (value: ChannelCharacter) => void;
  allowLong: boolean;
  onAllowLongChange: (value: boolean) => void;
  /** Every request concern — lifecycle, credits, idempotency, staleness — lives in the hook. */
  generation: UseGenerateSummary;
  /** Focus target for the pending card's "review and confirm" action — see `SummariesSurface`. */
  urlInputRef: RefObject<HTMLInputElement | null>;
}

const CHARACTERS: { value: ChannelCharacter; label: string; hint: string }[] = [
  {
    value: "informational",
    label: copy.generate.characters.informational.label,
    hint: copy.generate.characters.informational.hint,
  },
  {
    value: "educational",
    label: copy.generate.characters.educational.label,
    hint: copy.generate.characters.educational.hint,
  },
];

/**
 * The horizontal capture bar: the app's primary action, rendered directly above the list rather than
 * behind a dialog trigger. Input validation stays local — `urlError` and `submitDisabled` are input
 * concerns, not request concerns, and they are meaningless once the form is unmounted.
 *
 * The long-video quote (`confirm`) is answered from right here: the submit button itself switches to
 * "generate anyway at N credits" and replays the exact inputs the quote was priced for. The gate's
 * full detail — thumbnail, cost, resulting balance — renders in the pending card instead, which is
 * why this form carries no amber of its own; see `PendingSummaryCard`.
 */
export default function GenerateSummaryForm({
  url,
  onUrlChange,
  character,
  onCharacterChange,
  allowLong,
  onAllowLongChange,
  generation,
  urlInputRef,
}: Props) {
  const { loading, error, confirm, credits, generate, clearOutcome } = generation;

  const urlIsValid = extractYoutubeId(url) !== null;
  // Only flag a non-empty URL that fails to parse — an empty field shows no error, matching the
  // auth forms. Without this the submit button just silently disables, giving no reason why.
  const urlError = url.length > 0 && !urlIsValid ? copy.generate.urlInvalid : undefined;
  // `null` means the display-only balance read failed or was unavailable — not that the user is broke.
  // Never gate submission on it: the endpoint debits atomically and answers 402 if credits really ran out.
  const balanceUnknown = credits === null;
  const noCredits = credits !== null && credits <= 0;
  const confirmTooExpensive = confirm !== null && credits !== null && credits < confirm.cost;
  const submitDisabled = loading || !urlIsValid || noCredits || (confirm !== null && confirmTooExpensive);

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitDisabled) return;
    clearOutcome();
    if (confirm !== null) {
      // Replay the exact inputs this quote was priced for, not the live form.
      generate(true, confirm.url, confirm.character);
      return;
    }
    generate(allowLong, url, character);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        "border-border space-y-4 rounded-xl border p-4",
        noCredits ? "bg-background text-muted-foreground" : "bg-card",
      )}
      noValidate
    >
      <div className="space-y-3">
        <FormField
          id="url"
          label={copy.generate.urlLabel}
          value={url}
          onChange={onUrlChange}
          placeholder={copy.generate.urlPlaceholder}
          icon={<Link2 className="size-4" />}
          error={urlError}
          inputRef={urlInputRef}
        />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <fieldset>
            <legend className="text-muted-foreground mb-1 block text-sm">{copy.generate.characterLabel}</legend>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={copy.generate.characterLabel}>
              {CHARACTERS.map((option) => {
                const selected = character === option.value;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "has-[:focus-visible]:border-ring has-[:focus-visible]:ring-ring/50 cursor-pointer rounded-lg border px-3 py-2 transition-colors outline-none has-[:focus-visible]:ring-[3px]",
                      selected
                        ? "border-border bg-secondary text-foreground"
                        : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground bg-transparent",
                    )}
                  >
                    <input
                      type="radio"
                      name="character"
                      value={option.value}
                      checked={selected}
                      onChange={() => {
                        onCharacterChange(option.value);
                      }}
                      className="sr-only"
                    />
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs opacity-80">{option.hint}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Button type="submit" disabled={submitDisabled}>
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="border-primary-foreground/30 border-t-primary-foreground size-4 animate-spin rounded-full border-2" />
                {copy.generate.submitPending}
              </span>
            ) : confirm !== null ? (
              <span className="flex items-center gap-2">
                <Sparkles className="size-4" />
                {copy.generate.confirmSubmit(confirm.cost)}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Sparkles className="size-4" />
                {copy.generate.submit}
              </span>
            )}
          </Button>
        </div>
      </div>

      <label className="text-muted-foreground flex items-center gap-2 text-sm">
        <Checkbox
          checked={allowLong}
          onCheckedChange={(checked) => {
            onAllowLongChange(checked === true);
          }}
        />
        {copy.generate.allowLong}
      </label>

      {error ? <ServerError message={error} /> : null}

      {noCredits ? <p className="text-muted-foreground text-center text-xs">{copy.generate.noCredits}</p> : null}

      {balanceUnknown ? (
        <p className="text-muted-foreground flex items-center justify-center gap-2 text-center text-xs">
          <span className="bg-muted h-3 w-16 animate-pulse rounded" aria-hidden="true" />
          {copy.generate.balanceUnavailable}
        </p>
      ) : null}

      {confirm !== null && confirmTooExpensive ? (
        <p className="text-muted-foreground text-center text-xs">
          {copy.generate.gate.tooExpensive(confirm.cost, credits)}
        </p>
      ) : null}
    </form>
  );
}
