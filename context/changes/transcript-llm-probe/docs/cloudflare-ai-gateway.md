# Cloudflare AI Gateway — optional caching / fallback / observability

**Context7:** `/llmstxt/developers_cloudflare_ai-gateway_llms-full_txt` · **npm (fallback provider):** `ai-gateway-provider`

**Role in F-02:** optional layer in front of the LLM call. Gives caching, logging, rate/spend limits, and cross-provider fallback. **Not required for the probe** — a nice-to-have. Also the cheap "plan B" mechanism: free Anthropic→Gemini fallback.

## Two integration styles with the AI SDK

### 1. Simplest (Cloudflare-documented): route an existing provider via the gateway binding URL

Keep `@ai-sdk/anthropic` (or openai/google); just point `baseURL` at the gateway. No extra package.

```ts
import { createAnthropic } from "@ai-sdk/anthropic";

const anthropic = createAnthropic({
  baseURL: await env.AI.gateway("my-gateway").getUrl("anthropic"),
});
```

Requires an `ai` binding in `wrangler.jsonc`:

```jsonc
{ "ai": { "binding": "AI" } }
```

### 2. `ai-gateway-provider` package — first-class multi-provider fallback

```ts
import { createAiGateway } from "ai-gateway-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

const aigateway = createAiGateway({ binding: env.AI.gateway("my-gateway") });
const anthropic = createAnthropic({ apiKey: "..." });
const openai = createOpenAI({ apiKey: "..." });

const model = aigateway([
  anthropic("claude-opus-4-8"),  // primary
  openai("gpt-5.4-mini"),        // fallback if the first fails
]);
```

Supported routed providers include OpenAI, Anthropic, Google AI Studio, OpenRouter, and more.

## Cost (verified via Cloudflare docs, 2026-07-05)

**The gateway itself is free** — logging, caching, rate/spend limits, analytics, and fallback are applied with no per-request fee. Cost depends only on auth mode:

- **BYOK (Bring Your Own Keys) — recommended, ZERO markup.** Use your own Anthropic/Google/OpenAI key; you bill directly with the provider. Cloudflare adds nothing. Caching/logs/fallback for free.
- **Unified Billing — +5% on credits purchased** ($100 top-up → $105 charge); inference passed through at provider rates with no markup. Not needed for MVP. (Workers AI `@cf/*` models are billed via Workers AI, not Unified Billing.)

Extra notes:
- **Caching can lower cost** — reprocessing the same video serves from cache, skipping paid inference.
- **Log storage** has a plan-based limit (Free tier smaller); once full, old logs must be deleted. Not a per-request charge.
- Works on the free Workers plan.

## ⚠️ Naming collision

The `ai` package (≥5.0.36) ships its own built-in `gateway` provider (`import { gateway } from "ai"`) — that is **Vercel's** AI Gateway, a *different product* from **Cloudflare's** AI Gateway described here.

**Source:** Cloudflare AI Gateway docs (Unified Billing, Logging) + `ai-gateway-provider` / `workers-ai-provider` READMEs via Context7, 2026-07-05.
