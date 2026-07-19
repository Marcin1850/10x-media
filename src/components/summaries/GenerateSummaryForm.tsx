import React, { useState } from "react";
import { Link2, Sparkles, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/auth/FormField";
import { ServerError } from "@/components/auth/ServerError";
import { extractYoutubeId } from "@/lib/services/summaries";
import type { ChannelCharacter } from "@/types";

interface Props {
  initialCredits: number | null;
}

interface ConfirmState {
  cost: number;
  transcriptLength: number;
}

interface SuccessState {
  summary: string;
  cost: number;
}

const CHARACTERS: { value: ChannelCharacter; label: string; hint: string }[] = [
  { value: "informational", label: "Informational", hint: "Key facts & data" },
  { value: "educational", label: "Educational", hint: "Topics & skills to learn" },
];

/**
 * Maps a generate-endpoint HTTP status to a user-facing English message. The 402/409 paths carry
 * server-computed numbers, so they are built inline by the caller rather than here.
 */
function messageForStatus(status: number, serverError?: string): string {
  switch (status) {
    case 413:
      return "This video is too long to summarize.";
    case 422:
      return "No transcript is available for this video.";
    case 502:
      return "The transcript or summarization service failed. Please try again.";
    case 503:
      return "Summary generation isn't configured.";
    case 500:
      return "Something went wrong saving your summary. Please try again.";
    case 401:
      return "Your session expired — sign in again.";
    case 400:
      return serverError ?? "Please check the video URL and try again.";
    default:
      return serverError ?? "Something went wrong. Please try again.";
  }
}

export default function GenerateSummaryForm({ initialCredits }: Props) {
  const [url, setUrl] = useState("");
  const [character, setCharacter] = useState<ChannelCharacter>("informational");
  const [allowLong, setAllowLong] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SuccessState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [credits, setCredits] = useState<number | null>(initialCredits);

  const urlIsValid = extractYoutubeId(url) !== null;
  const noCredits = credits === null || credits <= 0;
  const submitDisabled = loading || !urlIsValid || noCredits;

  async function generate(withAllowLong: boolean) {
    setLoading(true);
    setError(null);

    let response: Response;
    try {
      response = await fetch("/api/summaries/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, character, allowLong: withAllowLong }),
      });
    } catch {
      setError("Network error — please try again.");
      setLoading(false);
      return;
    }

    const data: unknown = await response.json().catch(() => ({}));
    const payload = (data ?? {}) as {
      summary?: string;
      cost?: number;
      creditsRemaining?: number;
      transcriptLength?: number;
      requiresConfirmation?: boolean;
      error?: string;
    };

    if (response.ok) {
      setResult({ summary: payload.summary ?? "", cost: payload.cost ?? 1 });
      setConfirm(null);
      if (typeof payload.creditsRemaining === "number") setCredits(payload.creditsRemaining);
      setLoading(false);
      return;
    }

    if (response.status === 409 && payload.requiresConfirmation) {
      setConfirm({ cost: payload.cost ?? 2, transcriptLength: payload.transcriptLength ?? 0 });
      setResult(null);
      setLoading(false);
      return;
    }

    if (response.status === 402) {
      setError(payload.error ?? "You don't have enough summary credits.");
      // A 402 can arrive with a fresh authoritative balance in the message; if the server also sent a
      // number, prefer it. The endpoint currently embeds the balance in `error`, so nothing to sync here.
      setConfirm(null);
      setLoading(false);
      return;
    }

    setError(messageForStatus(response.status, payload.error));
    setConfirm(null);
    setLoading(false);
  }

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitDisabled) return;
    setResult(null);
    setConfirm(null);
    void generate(allowLong);
  }

  const confirmTooExpensive = confirm !== null && (credits === null || credits < confirm.cost);

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
          onChange={(v) => {
            setUrl(v);
          }}
          placeholder="https://www.youtube.com/watch?v=..."
          icon={<Link2 className="size-4" />}
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
                      setCharacter(option.value);
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
              setAllowLong(e.target.checked);
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
              void generate(true);
            }}
            className="w-full rounded-lg bg-amber-600 px-4 py-2 font-medium text-white transition-colors hover:bg-amber-500"
          >
            {loading ? "Generating..." : `Generate anyway (${confirm.cost} credits)`}
          </Button>
          {confirmTooExpensive ? (
            <p className="text-xs text-amber-200/70">
              Not enough credits — you need {confirm.cost} but have {credits ?? 0}.
            </p>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 px-4 py-4">
          <p className="text-xs tracking-wide text-blue-100/50 uppercase">
            Summary · {result.cost} credit{result.cost === 1 ? "" : "s"} spent
          </p>
          <p className="text-sm whitespace-pre-wrap text-blue-50/90">{result.summary}</p>
        </div>
      ) : null}
    </div>
  );
}
