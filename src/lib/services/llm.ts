import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";
import type { ChannelCharacter } from "@/types";

const SUMMARY_MODEL_SLUG = "anthropic/claude-sonnet-5";

/**
 * `usage: { include: true }` turns on OpenRouter's usage accounting (S-07). Without it the response
 * carries no `providerMetadata.openrouter.usage` at all, so `cost` never arrives and every summary is
 * persisted with unknown spend — which is the gap this slice exists to close.
 *
 * The provider is callable as `(modelId, settings)`; the settings object was simply absent before.
 * Usage accounting adds no latency: the figures ride the response already being parsed.
 */
export function getSummaryModel(apiKey: string) {
  return createOpenRouter({ apiKey })(SUMMARY_MODEL_SLUG, { usage: { include: true } });
}

const SYSTEM_PROMPTS: Record<ChannelCharacter, string> = {
  informational: `You are an expert summarizer for a Polish-language app that helps a user
decide whether a YouTube video is worth watching in full. Your input is the
transcript of one video.

This video comes from an INFORMATIONAL channel: it delivers facts, news, data,
and conclusions rather than teaching a skill.

Produce a thorough overview of the key information in the video so the reader
understands what it covers and can decide whether to watch it.

Rules:
- Always answer in Polish, regardless of the transcript's language.
- Format the whole answer as Markdown. Use "- " for bullet items and **bold**
  to highlight key figures, names, or terms. Do not wrap the answer in a code
  block and do not use raw HTML.
- Begin with one or two short sentences framing what the video is about.
- Then give a bulleted list where each bullet states one concrete fact, figure,
  claim, or conclusion from the video — specific, not vague (e.g. "Ceny energii
  wzrosły o **12%** w 2024 r.", not "Mówiono o cenach energii").
- Cover every distinct key point. Let the length follow the video's actual
  content — a fact-dense video warrants a longer list, a simple one a short list.
  Keep each bullet concise; do not omit important information to stay short, and
  do not repeat or pad to seem thorough.
- You may end with one or two short sentences stating the video's overall
  takeaway or conclusion, if it has one.
- Use only information present in the transcript. Do not speculate or add outside
  knowledge.
- Neutral, factual tone.`,
  educational: `You are an expert summarizer for a Polish-language app that helps a user
decide whether a YouTube video is worth watching in full. Your input is the
transcript of one video.

This video comes from an EDUCATIONAL channel: it teaches concepts, techniques,
or skills.

Produce a clear overview of what the video teaches and what the viewer would
learn from it, so the reader can judge whether it covers what they want and is
worth their time. Describe the material, not just list it.

Rules:
- Always answer in Polish, regardless of the transcript's language.
- Format the whole answer as Markdown. You may use "### " subheadings to group
  topics, "- " for bullet items, and **bold** to highlight topic names or key
  terms. Do not wrap the answer in a code block and do not use raw HTML.
- Begin with one or two short sentences naming the video's topic and who it is
  for (its assumed level or prior knowledge).
- Then walk through the topics the video covers. For each one, name it and
  describe concisely what is taught about it and what the viewer takes away —
  going into more depth only where the video itself does.
- Cover the full scope of what the video teaches, but let the length follow the
  material. Do not cut important topics to stay short, and do not pad to seem
  thorough.
- Use only what the transcript actually covers. Do not invent prerequisites,
  topics, or outcomes.
- Clear, approachable, didactic tone.`,
};

/**
 * Wall-clock deadline for the OpenRouter call (F23). Cloudflare imposes no duration limit on an
 * HTTP-triggered Worker — only CPU time is capped, and waiting on a subrequest is not CPU time — so
 * without this a hung provider connection has nothing bounding it. Two things downstream assume it is
 * bounded: the generation lease's 600s stale window (a request that outlives it is swept and can run
 * concurrently with its successor) and the one-hour reconciliation sweep (which would refund a
 * reservation whose work is still in flight).
 *
 * 300s sits under the lease window with ~60s of margin after the transcript job poll's ~240s worst
 * case. An abort throws, so it routes into the endpoint's existing refund + 502 path — the user is
 * never charged for a summary that timed out.
 */
const SUMMARY_TIMEOUT_MS = 300_000;

export interface SummarizeResult {
  text: string;
  model: string;
  /**
   * OpenRouter's own reported cost for this call, in USD. Null when usage accounting reported
   * nothing — a missing figure is telemetry that did not arrive, never a reason to fail a generation
   * whose work is already done and already paid for.
   */
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** Plain-object narrowing — `typeof null === "object"` and arrays are objects, so both are excluded. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Digs `openrouter.usage` out of a step's provider metadata, or null.
 *
 * Every hop is checked at runtime rather than typed through. The AI SDK types `providerMetadata` as
 * nested `JSONValue` keyed by provider name — not as the provider's `OpenRouterUsageAccounting` — and
 * its static shape says the keys are always present while the runtime says otherwise. A cast or a
 * non-null assertion here would be a claim about a vendor response this code cannot make.
 */
function readUsage(providerMetadata: unknown): Record<string, unknown> | null {
  const openrouter = asRecord(asRecord(providerMetadata)?.openrouter);
  return asRecord(openrouter?.usage);
}

/**
 * Reads one numeric field out of the usage-accounting object, or null. Every field is optional in the
 * provider's own type (`cost?: number`), so absence is expected rather than exceptional.
 *
 * Non-finite values are rejected too: `cost_usd` is `numeric` and the token columns are `integer`, so
 * a NaN reaching the persist call would abort the write of a summary already paid for.
 */
function readUsageNumber(usage: Record<string, unknown> | null, field: string): number | null {
  const value = usage?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function summarize(
  { transcript, character }: { transcript: string; character: ChannelCharacter },
  apiKey: string,
): Promise<SummarizeResult> {
  const result = await generateText({
    model: getSummaryModel(apiKey),
    system: SYSTEM_PROMPTS[character],
    prompt: transcript,
    abortSignal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  });

  // A resolved call is not necessarily a usable summary. Throwing here routes into the endpoint's
  // existing refund + 502 path, so the user isn't charged for an empty summary.
  // A truncated one (finishReason "length") is deliberately kept — partial coverage still has value.
  const text = result.text.trim();
  if (text === "") {
    throw new Error(`summarize: model returned empty text (finishReason: ${result.finishReason})`);
  }

  // Usage accounting (S-07). Absent figures become null and the summary is returned regardless — the
  // LLM call has already been made and billed by the time we get here, so telemetry that failed to
  // arrive must never turn a delivered summary into an error.
  const usage = readUsage(result.finalStep.providerMetadata);

  return {
    text,
    model: result.finalStep.response.modelId,
    costUsd: readUsageNumber(usage, "cost"),
    promptTokens: readUsageNumber(usage, "promptTokens"),
    completionTokens: readUsageNumber(usage, "completionTokens"),
  };
}
