# Library / API reference — transcript-llm-probe (F-02)

Per-library docs captured for the transcript→LLM path. Fetched via Context7 (libraries) and Exa (current model IDs) on **2026-07-05**. See `../research.md` for the architecture and decisions; these files are the raw API reference to code against.

| File | Package / API | Role |
| --- | --- | --- |
| [`supadata.md`](./supadata.md) | `@supadata/js` + REST | YouTube transcript fetch (with Whisper fallback) |
| [`vercel-ai-sdk.md`](./vercel-ai-sdk.md) | `ai` (v5) | LLM call abstraction (`generateText`/`streamText`) |
| [`ai-sdk-anthropic.md`](./ai-sdk-anthropic.md) | `@ai-sdk/anthropic` | Primary LLM provider (Claude) |
| [`ai-sdk-google.md`](./ai-sdk-google.md) | `@ai-sdk/google` | Plan-B provider (Gemini) |
| [`ai-sdk-openai.md`](./ai-sdk-openai.md) | `@ai-sdk/openai` | Plan-B provider (GPT) |
| [`openrouter.md`](./openrouter.md) | `@openrouter/ai-sdk-provider` + REST | Multi-model gateway (A/B testing, fallback) |
| [`cloudflare-ai-gateway.md`](./cloudflare-ai-gateway.md) | AI Gateway | Optional caching / fallback / observability |

> ⚠️ **Model IDs go stale fast** (Gemini changed twice while researching). IDs here are dated 2026-07-05 — re-confirm live at `/10x-plan` time. Package names, install commands, and usage patterns are stable.
