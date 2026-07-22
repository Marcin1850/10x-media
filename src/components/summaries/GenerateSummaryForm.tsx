import React, { useRef, useState } from "react";
import { Link2, Sparkles, CircleAlert } from "lucide-react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
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
  // The exact inputs this quote was priced for. "Generate anyway" replays these, never the live form,
  // so a late 409 arriving after the user edited the form can't consent to a different video.
  url: string;
  character: ChannelCharacter;
}

interface SuccessState {
  summary: string;
  cost: number;
  // The URL this summary was generated for. A successful paid result is applied even if the form was
  // edited while the request was in flight, so the result is labelled with its own input to stay
  // unambiguous when it no longer matches the currently edited URL.
  url: string;
}

const CHARACTERS: { value: ChannelCharacter; label: string; hint: string }[] = [
  { value: "informational", label: "Informational", hint: "Key facts & data" },
  { value: "educational", label: "Educational", hint: "Topics & skills to learn" },
];

/**
 * Elements the summary is allowed to render. LLM output is untrusted (transcript content can steer
 * it), so `img` and `a` are excluded: an image would make the viewer's browser fetch an
 * attacker-controlled URL, and a link would offer an attacker-controlled navigation target. Anything
 * outside this list is unwrapped, so its text still shows.
 */
const SUMMARY_ALLOWED_ELEMENTS = ["p", "ul", "ol", "li", "strong", "em", "h2", "h3", "code"];

/**
 * Tailwind-styled element map for the Markdown summary, matching the cosmic theme. Raw HTML in the
 * summary is escaped by react-markdown's default (no rehype-raw), so no extra sanitizer is needed.
 */
const summaryMarkdownComponents: Components = {
  p: ({ children }) => <p className="text-sm leading-relaxed text-blue-50/90">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 text-sm text-blue-50/90">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 text-sm text-blue-50/90">{children}</ol>,
  li: ({ children }) => <li className="marker:text-blue-200/40">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h2: ({ children }) => <h2 className="text-base font-semibold text-white">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-white">{children}</h3>,
  code: ({ children }) => <code className="rounded bg-white/10 px-1 py-0.5 text-xs">{children}</code>,
};

/**
 * Maps a generate-endpoint HTTP status to a user-facing English message. The 402/409 paths carry
 * server-computed numbers, so they are built inline by the caller rather than here.
 */
function messageForStatus(status: number, serverError?: string): string {
  switch (status) {
    case 429:
      return "A summary is already being generated. Wait for it to finish before starting another.";
    case 413:
      return "This video is too long to summarize.";
    case 422:
      return "No transcript is available for this video.";
    case 502:
      return "The transcript or summarization service failed. Please try again.";
    case 503:
      return "Summary generation isn't configured.";
    case 500:
      // Several distinct server-side 500s exist (pre-save infrastructure failures vs. a persistence
      // failure), each with its own message. Prefer the server's so a lock/balance/reserve failure
      // doesn't misreport as a save failure; the generic fallback covers a non-JSON framework 500.
      return serverError ?? "Something went wrong. Please try again.";
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
  // Monotonic id of the latest in-flight request. Bumped on every submit AND on every quote-relevant
  // input change, so a response whose seq is stale is discarded instead of applied to inputs the user
  // has since edited.
  const requestSeq = useRef(0);

  const urlIsValid = extractYoutubeId(url) !== null;
  // Only flag a non-empty URL that fails to parse — an empty field shows no error, matching the
  // auth forms. Without this the submit button just silently disables, giving no reason why.
  const urlError = url.length > 0 && !urlIsValid ? "Enter a valid YouTube video URL." : undefined;
  // `null` means the display-only balance read failed or was unavailable — not that the user is broke.
  // Never gate submission on it: the endpoint debits atomically and answers 402 if credits really ran out.
  const balanceUnknown = credits === null;
  const noCredits = credits !== null && credits <= 0;
  const submitDisabled = loading || !urlIsValid || noCredits;

  async function generate(withAllowLong: boolean, submittedUrl: string, submittedCharacter: ChannelCharacter) {
    const seq = (requestSeq.current += 1);
    setLoading(true);
    setError(null);

    let response: Response;
    try {
      response = await fetch("/api/summaries/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: submittedUrl, character: submittedCharacter, allowLong: withAllowLong }),
      });
    } catch {
      // Only surface the error if this is still the current request; a superseded one just clears loading.
      if (seq === requestSeq.current) setError("Network error — please try again.");
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

    // A successful response means the summary was already saved and the user was charged. Apply it even
    // if the form was edited while the request was in flight (seq is now stale): dropping paid work
    // would hide both the result and the new balance, inviting a duplicate — and duplicate — charge.
    // Label the result with its own submitted URL so it stays unambiguous when it no longer matches the
    // currently edited form.
    if (response.ok) {
      setResult({ summary: payload.summary ?? "", cost: payload.cost ?? 1, url: submittedUrl });
      setConfirm(null);
      if (typeof payload.creditsRemaining === "number") setCredits(payload.creditsRemaining);
      setLoading(false);
      return;
    }

    // Every remaining outcome is advisory (a consent prompt or an error), not a persisted result. If
    // the inputs it was computed for are no longer current, it can't be applied to what the user now
    // sees — drop it, including any late 409.
    if (seq !== requestSeq.current) {
      setLoading(false);
      return;
    }

    if (response.status === 409 && payload.requiresConfirmation) {
      setConfirm({
        cost: payload.cost ?? 2,
        transcriptLength: payload.transcriptLength ?? 0,
        url: submittedUrl,
        character: submittedCharacter,
      });
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
    void generate(allowLong, url, character);
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
          onChange={(v) => {
            setUrl(v);
            // The long-video quote was priced for the previous inputs — drop it so a changed
            // video can't be generated at 2 credits on an earlier video's confirmation, and
            // invalidate any in-flight request so its late response can't reinstate that quote.
            requestSeq.current += 1;
            setConfirm(null);
          }}
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
                      setCharacter(option.value);
                      requestSeq.current += 1;
                      setConfirm(null);
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
              requestSeq.current += 1;
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
              void generate(true, confirm.url, confirm.character);
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
            <Markdown
              allowedElements={SUMMARY_ALLOWED_ELEMENTS}
              unwrapDisallowed
              components={summaryMarkdownComponents}
            >
              {result.summary}
            </Markdown>
          </div>
        </div>
      ) : null}
    </div>
  );
}
