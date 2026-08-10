import React from "react";
import { Link2, Sparkles, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/auth/FormField";
import { ServerError } from "@/components/auth/ServerError";
import { SummaryMarkdown } from "@/components/summaries/SummaryMarkdown";
import type { UseGenerateSummary } from "@/components/hooks/useGenerateSummary";
import { extractYoutubeId } from "@/lib/services/summaries";
import type { ChannelCharacter } from "@/types";

interface Props {
  /**
   * The three quote-relevant inputs are controlled by the parent, not held here.
   *
   * `ui/dialog` does not force-mount its content, so Radix unmounts this form on close and any state
   * left local would be destroyed. Reopening would then show a blank URL and a default character
   * sitting next to a retained confirm quote or a running request — precisely the mismatch a
   * confirmation prompt must not have. Keeping them in the parent also means the quote and the
   * inputs it was priced from cannot drift apart.
   */
  url: string;
  onUrlChange: (value: string) => void;
  character: ChannelCharacter;
  onCharacterChange: (value: ChannelCharacter) => void;
  allowLong: boolean;
  onAllowLongChange: (value: boolean) => void;
  /** Every request concern — lifecycle, credits, idempotency, staleness — lives in the hook. */
  generation: UseGenerateSummary;
}

const CHARACTERS: { value: ChannelCharacter; label: string; hint: string }[] = [
  { value: "informational", label: "Informational", hint: "Key facts & data" },
  { value: "educational", label: "Educational", hint: "Topics & skills to learn" },
];

/**
 * The generation form, now presentational: it renders inputs, validation and the hook's outcomes.
 * Input validation stays local — `urlError` and `submitDisabled` are input concerns, not request
 * concerns, and they are meaningless once the form is unmounted.
 */
export default function GenerateSummaryForm({
  url,
  onUrlChange,
  character,
  onCharacterChange,
  allowLong,
  onAllowLongChange,
  generation,
}: Props) {
  const { loading, result, error, confirm, credits, generate, clearOutcome } = generation;

  const urlIsValid = extractYoutubeId(url) !== null;
  // Only flag a non-empty URL that fails to parse — an empty field shows no error, matching the
  // auth forms. Without this the submit button just silently disables, giving no reason why.
  const urlError = url.length > 0 && !urlIsValid ? "Enter a valid YouTube video URL." : undefined;
  // `null` means the display-only balance read failed or was unavailable — not that the user is broke.
  // Never gate submission on it: the endpoint debits atomically and answers 402 if credits really ran out.
  const balanceUnknown = credits === null;
  const noCredits = credits !== null && credits <= 0;
  const submitDisabled = loading || !urlIsValid || noCredits;

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitDisabled) return;
    clearOutcome();
    generate(allowLong, url, character);
  }

  const confirmTooExpensive = confirm !== null && credits !== null && credits < confirm.cost;

  return (
    <div className="space-y-6 text-left">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-white">Generate a summary</h2>
        <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-center">
          <span className="text-lg font-bold text-white">{credits ?? "—"}</span>
          <span className="ml-1 text-xs tracking-wide text-blue-100/60 uppercase">credits</span>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <FormField
          id="url"
          label="YouTube URL"
          value={url}
          onChange={onUrlChange}
          placeholder="https://www.youtube.com/watch?v=..."
          icon={<Link2 className="size-4" />}
          error={urlError}
        />

        <fieldset>
          <legend className="mb-1 block text-sm text-blue-100/80">Channel character</legend>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Channel character">
            {CHARACTERS.map((option) => {
              const selected = character === option.value;
              return (
                <label
                  key={option.value}
                  className={
                    selected
                      ? "cursor-pointer rounded-lg border border-purple-400 bg-purple-500/20 px-3 py-2 text-white transition-colors"
                      : "cursor-pointer rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-blue-100/70 transition-colors hover:bg-white/10"
                  }
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
                  <span className="block text-xs text-blue-100/50">{option.hint}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <label className="flex items-center gap-2 text-sm text-blue-100/80">
          <input
            type="checkbox"
            checked={allowLong}
            onChange={(e) => {
              onAllowLongChange(e.target.checked);
            }}
            className="size-4 rounded border-white/20 bg-white/10 accent-purple-500"
          />
          Allow long videos (may cost 2 credits)
        </label>

        {error ? <ServerError message={error} /> : null}

        <Button
          type="submit"
          disabled={submitDisabled}
          className="w-full rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Generating...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Sparkles className="size-4" />
              Generate summary
            </span>
          )}
        </Button>

        {noCredits ? (
          <p className="text-center text-xs text-blue-100/50">
            You have no summary credits left. Generation is disabled.
          </p>
        ) : null}

        {balanceUnknown ? (
          <p className="text-center text-xs text-blue-100/50">
            Your credit balance is unavailable right now. You can still generate — we&apos;ll tell you if you&apos;re
            out of credits.
          </p>
        ) : null}
      </form>

      {confirm ? (
        <div className="space-y-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <p className="flex items-start gap-2">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>
              This is a long video (~{confirm.transcriptLength.toLocaleString()} chars). Generating costs {confirm.cost}{" "}
              credits.
            </span>
          </p>
          <Button
            type="button"
            disabled={loading || confirmTooExpensive}
            onClick={() => {
              // Replay the exact inputs this quote was priced for, not the live form.
              generate(true, confirm.url, confirm.character);
            }}
            className="w-full rounded-lg bg-amber-600 px-4 py-2 font-medium text-white transition-colors hover:bg-amber-500"
          >
            {loading ? "Generating..." : `Generate anyway (${confirm.cost} credits)`}
          </Button>
          {confirmTooExpensive ? (
            <p className="text-xs text-amber-200/70">
              Not enough credits — you need {confirm.cost} but have {credits}.
            </p>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 px-4 py-4">
          <p className="text-xs tracking-wide text-blue-100/50 uppercase">
            Summary · {result.cost} credit{result.cost === 1 ? "" : "s"} spent
          </p>
          <p className="truncate text-xs text-blue-100/40" title={result.url}>
            {result.url}
          </p>
          <div className="space-y-2">
            <SummaryMarkdown>{result.summary}</SummaryMarkdown>
          </div>
        </div>
      ) : null}
    </div>
  );
}
