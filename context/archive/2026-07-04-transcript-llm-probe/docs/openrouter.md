# OpenRouter — multi-model gateway (plan B / A-B testing)

**Package:** `@openrouter/ai-sdk-provider` (Context7 `/openrouterteam/ai-sdk-provider`, v0.7.5) · **REST base:** `https://openrouter.ai/api/v1`

**Role in F-02:** one provider + one key fronting hundreds of models (Claude, Gemini, GPT, Llama…). Best for **A/B testing Polish summary quality without touching code** (change the model ID string only) — directly serves the PRD "75% good-enough" criterion — and for built-in cross-provider fallback.

## Install

```bash
npm install @openrouter/ai-sdk-provider
```

## Usage (AI SDK)

```ts
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  // appName / appUrl optional (for openrouter.ai rankings)
});

const { text } = await generateText({
  model: openrouter("anthropic/claude-sonnet-4.6"), // provider/model slug
  prompt: "...",
});
```

> Model slugs are `provider/model` (e.g. `anthropic/claude-sonnet-4.6`, `google/gemini-3.5-flash`, `openai/gpt-5.5`) and differ from each provider's native ID — check the OpenRouter models page for exact slugs. `openrouter/auto` lets OpenRouter pick the model; the chosen one comes back in `response.model`.

## Usage accounting — cost & tokens via the AI SDK

The raw REST response exposes `usage.cost`, but so does the **AI SDK path** — no need to drop to `fetch`. Opt in with `usage: { include: true }` on the model, then read `providerMetadata.openrouter.usage`:

```ts
const model = openrouter("anthropic/claude-sonnet-5", {
  usage: { include: true }, // opt in — off by default
});

const result = await generateText({ model, prompt: "..." });

// AI SDK v7 standard token details:
result.usage.inputTokens;
result.usage.outputTokens;

// OpenRouter-specific accounting (only present when include: true):
const u = result.providerMetadata?.openrouter?.usage;
u?.cost;         // actual $/credits for THIS call
u?.totalTokens;  // prompt + completion
```

`OpenRouterUsageAccounting` shape:

```ts
type OpenRouterUsageAccounting = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number; // undefined unless usage.include was set — persist null-safely
  promptTokensDetails?: { cachedTokens: number };
  completionTokensDetails?: { reasoningTokens: number };
  costDetails?: { upstreamInferenceCost: number };
};
```

> This is how S-01 should capture per-summary cost (impl-review Phase 4, F5). The F-02 probe's `getSummaryModel` omits `usage: { include: true }`, so it captures the served `model` slug (`finalStep.response.modelId`) but **not** cost — add the option when cost tracking lands.

## Provider routing & fallback (OpenRouter-native, via the AI SDK settings)

```ts
const model = openrouter("openai/gpt-4o", {
  provider: {
    order: ["anthropic", "openai", "google"], // try in this order
    allow_fallbacks: true,                     // default true
    max_price: { prompt: "0.01", completion: "0.05" },
    // also: only, ignore, require_parameters, data_collection, sort, zdr
  },
});
```

## Usage (raw REST — workerd-safe `fetch`)

```
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json
{ "model": "openai/gpt-5.2", "messages": [{ "role": "user", "content": "..." }] }
```

**Model-array fallback (REST):** pass `"models": ["~anthropic/claude-sonnet-latest", "gryphe/mythomax-l2-13b"]` — if the first fails, OpenRouter tries the next.

Response includes `usage.cost` (actual $ for the call) and `model` (which model actually served it) — useful for the "75% good-enough" cost/quality tracking.

## Cost note

OpenRouter passes through provider pricing (small routing margin baked into per-model rates). No separate platform subscription; pay per token via credits.

**Source:** OpenRouter docs (`openrouter.ai/docs`) + `@openrouter/ai-sdk-provider` via Context7, 2026-07-05; usage-accounting section added 2026-07-10 (Context7 `/openrouterteam/ai-sdk-provider`, impl-review Phase 4).
