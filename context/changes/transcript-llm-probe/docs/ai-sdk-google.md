# `@ai-sdk/google` — Gemini provider (plan B)

**Package:** `@ai-sdk/google` · Context7: `/websites/ai-sdk_dev`

**Role in F-02:** plan-B provider if Anthropic quality/cost disappoints. Edge-native (`fetch` + Web Streams), runs on workerd. Swap = one line behind the AI SDK abstraction.

## Install

```bash
npm install @ai-sdk/google
```

## Usage

```ts
import { google } from "@ai-sdk/google";
import { generateText } from "ai";

const { text } = await generateText({
  model: google("gemini-3.5-flash"),
  prompt: "...",
});
```

Secret: `GOOGLE_GENERATIVE_AI_API_KEY` (as a Workers Secret).

## Current Gemini model IDs (Exa / Google AI docs, 2026-07-05)

> The AI SDK cookbook still shows `gemini-3-pro-preview` — already superseded. Use the current IDs below.

| Model | ID | In/out per 1M | Status | Notes |
| --- | --- | --- | --- | --- |
| **Gemini 3.5 Flash** | `gemini-3.5-flash` | ~$1.50 / $9 | **GA / stable** | Best MVP pick — below Sonnet 4.6, "sustained frontier agentic/coding" |
| Gemini 3.1 Pro | `gemini-3.1-pro-preview` | $2/$12 (<200k), $4/$18 (>200k) | preview | SOTA reasoning, 1M ctx |
| Gemini 3.1 Flash-Lite | `gemini-3.1-flash-lite` | $0.25 / $1.50 | stable | Cost floor, high-volume |
| Gemini 3.5 Pro | (GA ~June 2026) | TBC | frontier | up to 2M ctx |

**Prefer GA/stable IDs over `-preview` for production.** The AI SDK passes the ID straight through to the Gemini API, so `google("gemini-3.5-flash")` just works.

## Notes

- Native multimodal + up to 2M context (Pro) — not needed for text summarization, but headroom.
- Provider-specific `safetySettings` exist but aren't needed for a simple summary call.

**Source:** Google AI / Gemini API docs + Exa, 2026-07-05.
