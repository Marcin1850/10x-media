import { describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { summarize } from "@/lib/services/llm";

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

/**
 * `summarize`'s own contract — the gap plan Phase 4 leaves open by mocking `llm.ts` wholesale at the
 * endpoint boundary. Nothing below reaches OpenRouter: `generateText` from the `ai` package is
 * replaced entirely, so `getSummaryModel`'s real provider object is built (cheap, synchronous, no
 * network — verified: constructing it does not call `fetch`) but never invoked.
 *
 * Oracle: `llm.ts`'s own documented contract on `SummarizeResult` and `readUsageNumber` — "every field
 * is optional in the provider's own type", "non-finite values are rejected", and the empty-text throw
 * comment ("a resolved call is not necessarily a usable summary"). These are the function's own
 * documented promises, not the vendor's — `usage.cost` is the figure risk #2 reconciles downstream,
 * so what `summarize` does with a partial or absent usage object is exactly what's under test here.
 *
 * Log copy is deliberately not asserted (test-plan §6.1) — `summarize` throws rather than logging, so
 * this note only matters insofar as no test below pins the thrown `Error`'s message beyond what a
 * caller can act on.
 */

vi.mock("ai", () => ({ generateText: vi.fn() }));

const mockGenerateText = vi.mocked(generateText);

interface FakeStep {
  response: { modelId: string };
  providerMetadata?: Record<string, unknown>;
}

/**
 * Only the three fields `summarize` reads (`llm.ts:150,158,162-165`) are given real values; the cast
 * is confined to this one function so every call site below stays fully typed.
 */
function fakeResult(text: string, finishReason: string, step: FakeStep): GenerateTextResult {
  return { text, finishReason, finalStep: step } as unknown as GenerateTextResult;
}

const ARGS = { transcript: "synthetic transcript", character: "informational" as const };
const API_KEY = "sk-or-synthetic";

describe("summarize — empty output is rejected, never delivered", () => {
  it.each([
    ["", "stop", "an empty string"],
    ["   \n\t  ", "stop", "whitespace-only text"],
  ])("throws when the model returns %j (%s)", async (text, finishReason) => {
    mockGenerateText.mockResolvedValueOnce(
      fakeResult(text, finishReason, { response: { modelId: "anthropic/claude-sonnet-5" } }),
    );

    await expect(summarize(ARGS, API_KEY)).rejects.toThrow(/empty text/);
  });

  it("keeps a truncated but non-empty summary — partial coverage still has value", async () => {
    mockGenerateText.mockResolvedValueOnce(
      fakeResult("partial summary text", "length", {
        response: { modelId: "anthropic/claude-sonnet-5" },
      }),
    );

    const result = await summarize(ARGS, API_KEY);
    expect(result.text).toBe("partial summary text");
  });
});

describe("summarize — usage figures read defensively", () => {
  it.each([
    [undefined, "providerMetadata absent entirely"],
    [{}, "providerMetadata present but carries no openrouter key"],
    [{ openrouter: {} }, "openrouter present but carries no usage key"],
    [{ openrouter: { usage: {} } }, "usage present but every field absent"],
  ])("all three figures are null when %s", async (providerMetadata, _label) => {
    mockGenerateText.mockResolvedValueOnce(
      fakeResult("summary text", "stop", {
        response: { modelId: "anthropic/claude-sonnet-5" },
        providerMetadata,
      }),
    );

    const result = await summarize(ARGS, API_KEY);
    expect(result.costUsd).toBeNull();
    expect(result.promptTokens).toBeNull();
    expect(result.completionTokens).toBeNull();
  });

  it("reads whichever figures are present and leaves the rest null — a partial report is not a failure", async () => {
    mockGenerateText.mockResolvedValueOnce(
      fakeResult("summary text", "stop", {
        response: { modelId: "anthropic/claude-sonnet-5" },
        providerMetadata: { openrouter: { usage: { cost: 0.0042, promptTokens: 1200 } } },
      }),
    );

    const result = await summarize(ARGS, API_KEY);
    expect(result.costUsd).toBe(0.0042);
    expect(result.promptTokens).toBe(1200);
    expect(result.completionTokens).toBeNull();
  });

  it.each([
    ["a string instead of a number", "5"],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a %s cost as unusable telemetry, not a failure", async (_label, cost) => {
    mockGenerateText.mockResolvedValueOnce(
      fakeResult("summary text", "stop", {
        response: { modelId: "anthropic/claude-sonnet-5" },
        providerMetadata: { openrouter: { usage: { cost } } },
      }),
    );

    const result = await summarize(ARGS, API_KEY);
    expect(result.costUsd).toBeNull();
  });
});

describe("summarize — modelId is surfaced from the response", () => {
  it("returns the model id the provider actually reported, not the requested slug", async () => {
    mockGenerateText.mockResolvedValueOnce(
      fakeResult("summary text", "stop", {
        response: { modelId: "anthropic/claude-sonnet-5-20260115" },
      }),
    );

    const result = await summarize(ARGS, API_KEY);
    expect(result.model).toBe("anthropic/claude-sonnet-5-20260115");
  });
});
