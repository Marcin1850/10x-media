# `@ai-sdk/openai` — GPT provider (plan B)

**Package:** `@ai-sdk/openai` · Context7: `/websites/ai-sdk_dev`

**Role in F-02:** plan-B provider. Edge-native (`fetch`-based), runs on workerd. Swap = one line behind the AI SDK abstraction.

## Install

```bash
npm install @ai-sdk/openai
```

## Usage

```ts
import { openai } from "@ai-sdk/openai";
import { generateText } from "ai";

const { text } = await generateText({
  model: openai("gpt-5.4-mini"),
  prompt: "...",
});
```

Secret: `OPENAI_API_KEY`.

## Current OpenAI model IDs (Exa / OpenAI API docs, 2026-07-05)

| Model | ID | In/out per 1M | Notes |
| --- | --- | --- | --- |
| GPT-5.5 | `gpt-5.5` (snapshot `gpt-5.5-2026-04-23`) | $5 / $30 | Frontier; ~1.05M ctx, 128k out, cutoff Dec 2025 |
| GPT-5.5 Pro | `gpt-5.5-pro` | $30 / $180 | Highest accuracy |
| GPT-5.4 | `gpt-5.4` | $2.50 / — | More affordable frontier |
| **GPT-5.4 mini** | `gpt-5.4-mini` | $0.75 / $4.50 | **Value MVP pick** — 400k ctx |
| GPT-5.4 nano | `gpt-5.4-nano` | $0.20 / $1.25 | Cost floor, high-volume |

## Notes

- OpenAI recommends its **Responses API** for GPT-5.5 and tuning `reasoning.effort` (`none`/`low`/`medium`/`high`/`xhigh`). The AI SDK handles the API surface internally, so `openai("gpt-5.4-mini")` works normally — no reasoning params needed for plain summarization.
- `>272K` input tokens on GPT-5.5 is priced at 2x input / 1.5x output — irrelevant for single-video transcripts.

**Source:** OpenAI API docs (`developers.openai.com`) + Exa, 2026-07-05.
