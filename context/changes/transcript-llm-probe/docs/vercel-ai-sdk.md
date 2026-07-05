# Vercel AI SDK (`ai`) — core

**Package:** `ai` · Current stable **v5** (`ai@5`); v6 is beta — don't adopt yet. · Context7: `/vercel/ai`, `/websites/ai-sdk_dev`

**Role in F-02:** the LLM call abstraction. Edge-native (pure Web `fetch` + Web Streams, no `node:*`), officially documented on Cloudflare, matches the typed/convention-based stack. **The reason to use it over a provider-native SDK: the model layer sits behind a provider abstraction, so switching vendors is a one-line change** (see the provider docs in this folder).

## Install

```bash
npm install ai @ai-sdk/anthropic   # + any other provider packages
```

## Core call — `generateText`

```ts
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";

const { text } = await generateText({
  model: anthropic("claude-sonnet-4-6"),
  system: "Jesteś asystentem tworzącym zwięzłe podsumowania po polsku...",
  prompt: transcript,   // or messages: [...]
});
```

`generateText` returns `{ text, usage, finishReason, ... }`. Use `streamText` for streaming (`toTextStreamResponse()` / `for await (const chunk of result.textStream)`).

## Structured output (fits the project's zod convention)

```ts
import { generateObject } from "ai";
import { z } from "zod";

const { object } = await generateObject({
  model: anthropic("claude-sonnet-4-6"),
  schema: z.object({ summary: z.string(), keyPoints: z.array(z.string()) }),
  prompt: transcript,
});
```

## Provider-agnostic pattern (keep the swap trivial)

Isolate model selection in one place, e.g. `src/lib/services/llm.ts`:

```ts
export function getSummaryModel() {
  return anthropic("claude-sonnet-4-6"); // swap provider/ID here only
}
```

Everything downstream (endpoint, zod validation, Supabase write) calls `getSummaryModel()` and never names a provider.

## Notes

- Summarization needs no extended thinking — omit provider `thinking`/`reasoning` params.
- ⚠️ **Naming collision:** `ai` (≥5.0.36) ships its own built-in `gateway` provider — that is **Vercel's** AI Gateway, a different product from Cloudflare's AI Gateway. See `cloudflare-ai-gateway.md`.

**Source:** AI SDK docs (`ai-sdk.dev`) via Context7, 2026-07-05.
