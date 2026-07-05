# `@ai-sdk/anthropic` — Claude provider (primary)

**Package:** `@ai-sdk/anthropic` · Context7: `/vercel/ai` (provider docs)

**Role in F-02:** primary LLM provider for the Polish summary. Edge-native (`fetch`-based), runs on workerd. **Do NOT import the root `@anthropic-ai/sdk`** — it pulls Node built-ins and bloats/breaks the Worker bundle; the AI SDK provider is the workerd-safe path.

## Install

```bash
npm install @ai-sdk/anthropic
```

## Usage

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

const { text } = await generateText({
  model: anthropic("claude-opus-4-8"),
  prompt: "...",
});
```

Custom instance (e.g. to route via Cloudflare AI Gateway):

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY /*, baseURL */ });
```

## Current Claude model IDs (authoritative: `claude-api` skill table, 2026-07-05)

Bare strings — **no date suffix** (`claude-opus-4-8`, never `claude-opus-4-8-20xxxxxx`).

| Model | ID | In/out per 1M | Notes |
| --- | --- | --- | --- |
| Claude Opus 4.8 | `claude-opus-4-8` | $5 / $25 | Frontier; standing default, strong Polish |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | $3 / $15 | **Value pick for this MVP** — frontier multilingual, single-call summarization |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1 / $5 | Cost floor |
| Claude Fable 5 | `claude-fable-5` | $10 / $50 | Most capable; overkill for summarization |

**Recommendation for F-02:** `claude-opus-4-8` as the quality default; `claude-sonnet-4-6` as the pragmatic cost/quality pick for a solo after-hours MVP. One-string swap between them.

## Notes

- Summarization → omit `thinking` (adaptive thinking not needed).
- Keep prompt/output in Polish, tailored to the channel character (FR-004/FR-005).

**Source:** `claude-api` skill current-models table (authoritative for Claude IDs) + AI SDK provider docs via Context7, 2026-07-05.
