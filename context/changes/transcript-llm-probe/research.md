---
change_id: transcript-llm-probe
title: Transcript → LLM path — research
researched_at: 2026-07-05
method: web_search_exa
prd_refs: [FR-005, NFR]
roadmap_ref: F-02
---

# Research: YouTube transcript → LLM summary on the deployed Worker

> Sourced via `web_search_exa` (2026-07-05). Validates F-02's top unknown before `/10x-plan`.

## TL;DR

Split F-02 into two independent problems and **offload the risky one**:

1. **Transcript fetch** — direct fetch from a Cloudflare Worker is a confirmed dead end (YouTube hard-blocks datacenter IPs). Use a **managed transcript REST API** instead of scraping.
2. **LLM summary** — Vercel AI SDK (`ai`) with a frontier provider (Anthropic / OpenRouter). Edge-native, workerd-safe.

Both are I/O-bound network calls → they **do not count against the Workers CPU limit**, so the free-plan 10ms CPU concern in `infrastructure.md` is largely mitigated and the Railway escape hatch is likely **not** needed.

## Problem 1 — Transcript fetching (the top external risk)

**Finding: fetching transcripts directly from the Worker will not work.** Since late 2024 YouTube hard-blocks its `api/timedtext` caption endpoint from datacenter IP ranges (AWS, GCP, Azure, **Cloudflare Workers**, Vercel, Netlify, etc.), returning `RequestBlocked` / `IpBlocked` / "confirm you're not a bot". Works on residential IPs (local dev), fails in production — exactly the pre-mortem in `infrastructure.md`.

- Compatibility matrices in `youtube-transcript-ts` and Python `youtube-transcript-api` both list **Cloudflare Workers → "No, works out of the box"**.
- The library workaround is residential proxies (Webshare), but those are `undici`-based and **don't run on workerd** anyway.

**Recommendation: call a managed transcript REST API from the Worker.** It's a plain `fetch()` — no `nodejs_compat` surface, no CPU-heavy XML parsing on the Worker (the offload is what neutralizes the CPU-limit worry).

| Provider | Fit | Notes |
| --- | --- | --- |
| **Supadata** (recommended) | `@supadata/js` TS SDK + REST | **100 free credits/mo**, $5→300. `mode: "auto"` = native caption, **Whisper AI fallback** when no captions. Native = 1 credit; AI-generated = 2 credits/min. |
| TranscriptAPI.com | REST | 100 free credits, Whisper fallback, MCP too. |
| Captapi | REST | 100 free credits, 24h cache, Whisper fallback. |
| `youtube-transcript-api14` (RapidAPI) | REST | Free tier 100/mo; `/transcript/text` returns merged plain text (ideal LLM input). |

**Supadata's `auto`-mode Whisper fallback directly resolves PRD Open Question #1** ("how to handle videos without a transcript") — instead of a fallback error message, you often just get a transcript. Still need a user-facing error for the residual "truly unavailable" case (206 response).

Risk shifts from **"YouTube blocks us"** (unsolvable in-house) → **"we depend on a paid third party"** (a normal, boundable cost/vendor risk).

## Problem 2 — LLM summary call

Use the **Vercel AI SDK** (`ai` package): edge-native (pure Web Fetch + Web Streams, no `node:*`), officially documented on Cloudflare, matches the typed/convention-based stack. `generateText` / `streamText` with zod-validated output fits the API-route conventions.

Provider (PRD needs good **Polish** summaries → favor a frontier model, not Workers-AI native small models):

- **`@ai-sdk/anthropic`** (Claude) or **OpenRouter** via `@ai-sdk/openai`-compatible base URL. Both call REST directly over `fetch`; run on workerd. Claude is a natural default for Polish quality.
- ⚠️ **Do not** import the root `@anthropic-ai/sdk` — pulls Node built-ins, bloats/breaks the Worker bundle. Use the AI SDK provider, or `@anthropic-ai/sdk/edge`, or raw `fetch` to `api.anthropic.com/v1/messages`.
- Optional upgrade: **Cloudflare AI Gateway provider** (`ai-gateway-provider`, AI-SDK-compatible) — automatic provider fallback, caching, rate-limiting, observability via `env.AI.gateway(...)`, no extra API token. Nice-to-have for MVP, not required for the probe.

## Verified packages & model ID (Context7 + claude-api skill, 2026-07-05)

**Transcript — Supadata** (`/llmstxt/supadata_ai_llms_txt`, `/supadata-ai/js`):
- Install: `npm install @supadata/js`
- Call: `const supadata = new Supadata({ apiKey }); await supadata.transcript({ url, lang: "pl", text: true, mode: "auto" })` — `text: true` returns `{ content, lang, availableLangs }` (plain text, ideal LLM input). `mode: "auto"` = native caption → Whisper fallback.
- REST equivalent: `GET https://api.supadata.ai/v1/youtube/transcript?url=...&text=true` with `x-api-key` header.

**LLM — Vercel AI SDK** (`/vercel/ai`):
- Install: `npm install ai @ai-sdk/anthropic` — current stable **AI SDK v5** (`ai@5`); v6 is in beta, don't adopt yet.
- Call: `import { anthropic } from "@ai-sdk/anthropic"; import { generateText } from "ai"; await generateText({ model: anthropic("claude-opus-4-8"), prompt })`.

**Model ID** (authoritative from the `claude-api` skill's current-models table): current IDs are `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` — **bare strings, no date suffix** (`claude-opus-4-8`, never `claude-opus-4-8-20xxxxxx`).
- **Recommended default: `claude-opus-4-8`** — the skill's standing default; frontier multilingual quality, strong Polish. $5/$25 per MTok.
- **Cost-balanced alternative for this MVP: `claude-sonnet-4-6`** — summarization is a single LLM call (the cheapest tier); Sonnet 4.6 is a frontier multilingual model at $3/$15 per MTok, a good fit for a solo, after-hours, cost-sensitive build. Swap the one model-ID string if summary quality proves good enough. `claude-haiku-4-5` ($1/$5) is the floor if volume/cost dominates, at some quality cost.
- Summarization needs no extended thinking — omit the `thinking` param. Keep the prompt/output in Polish and tailored to the channel character (FR-004/FR-005).

**Plan-B providers (also Context7-verified, for the swappability section below):**
- `@ai-sdk/google` — install `npm install @ai-sdk/google`. Current Gemini lineup (Exa/Google AI docs, mid-2026 — the AI SDK cookbook's `gemini-3-pro-preview` is already superseded): **`gemini-3.5-flash`** (GA/stable, ~$1.50/$9, best MVP pick — below Sonnet 4.6), `gemini-3.1-pro-preview` (frontier reasoning, $2/$12), `gemini-3.1-flash-lite` (cost floor, $0.25/$1.50); Gemini 3.5 Pro GA expected ~June 2026. Prefer GA/stable IDs over `-preview` for production.
- `@ai-sdk/openai` — install `npm install @ai-sdk/openai`; `openai("gpt-5.4-mini")`. Current OpenAI lineup (Exa/OpenAI API docs, mid-2026): `gpt-5.5` (frontier, $5/$30, ~1.05M ctx), `gpt-5.5-pro` ($30/$180), `gpt-5.4` ($2.50 in), **`gpt-5.4-mini`** ($0.75/$4.50, 400k ctx — value MVP pick), `gpt-5.4-nano` ($0.20/$1.25, cost floor). GPT-5.5 prefers OpenAI's Responses API, but the AI SDK handles that internally.
- `@openrouter/ai-sdk-provider` — install `npm install @openrouter/ai-sdk-provider` (Context7 `/openrouterteam/ai-sdk-provider`, v0.7.5).
- Cloudflare AI Gateway — via provider `baseURL` = `env.AI.gateway(id).getUrl(provider)`, or the `ai-gateway-provider` package for multi-provider fallback. ⚠️ Not to be confused with the `ai` package's own built-in `gateway` provider (that's *Vercel's* AI Gateway).

**Per-library reference docs:** captured under [`docs/`](./docs/) (one file per library/API — Supadata, AI SDK core + Anthropic/Google/OpenAI providers, OpenRouter, Cloudflare AI Gateway) for coding against at `/10x-plan` time.

**Coverage check (2026-07-05): all libraries referenced in this doc have been verified via Context7** — `@supadata/js`, `ai` (Vercel AI SDK v5), `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, `@openrouter/ai-sdk-provider`, Cloudflare AI Gateway. Model IDs (which go stale fast) are dated to 2026-07-05 and should be re-confirmed live at `/10x-plan` time: Claude via the authoritative `claude-api` skill table; Gemini + OpenAI via Exa/provider docs (see Sources).

## What the F-02 probe must verify (on the DEPLOYED Worker, not local)

1. `POST` endpoint (`export const prerender = false;`): videoId/URL → transcript API → transcript → AI SDK → Polish summary → return.
2. Secrets as **Workers Secrets** via `astro:env/server`: `wrangler secret put SUPADATA_API_KEY` and `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY`). Declare in `astro.config.mjs` `env.schema`.
3. Hit the live `10x-media.nightshiftlab.workers.dev` URL; watch `wrangler tail`. Confirm: transcript API reachable from CF egress, LLM call succeeds, latency acceptable, no bundle / `nodejs_compat` errors.
4. Confirm the free Cloudflare plan suffices (expected: yes — parsing offloaded, calls are I/O-bound).

## Provider swappability / plan B (if Anthropic quality is unsatisfactory)

The reason to use the **Vercel AI SDK** rather than a provider-native SDK: the model layer sits behind a provider abstraction, so switching vendors (e.g. to Google Gemini) is a **one-line change**, not a rewrite.

```ts
// Anthropic
import { anthropic } from "@ai-sdk/anthropic";
const model = anthropic("claude-opus-4-8");

// Gemini — npm install @ai-sdk/google
import { google } from "@ai-sdk/google";
const model = google("gemini-3.5-flash"); // GA/stable, ~$1.50/$9, strong for summarization
```

Everything downstream — `generateText(...)` / `streamText(...)`, zod validation, the Astro endpoint, the Supabase write — stays unchanged. Only three things move: the provider import + model factory, the model ID string, and the secret (`GOOGLE_GENERATIVE_AI_API_KEY` instead of `ANTHROPIC_API_KEY`, as a Workers Secret). `@ai-sdk/google` is also edge-native (`fetch` + Web Streams), so it runs on workerd with no `nodejs_compat` risk.

**Design so the swap stays trivial:** isolate model selection in one place (e.g. `src/lib/services/llm.ts` exposing `getSummaryModel()`); the rest of the code calls that and never names a provider. Then a provider change = editing one file.

Two options that add even more flexibility:
1. **OpenRouter** (`@openrouter/ai-sdk-provider`, Context7 `/openrouterteam/ai-sdk-provider`, v0.7.5) — one provider, one key, hundreds of models (Claude, Gemini, GPT, Llama…) behind it. Changing model = changing the ID string, no new package. Ideal for **A/B testing Polish summary quality** without touching code — directly serves the PRD's "75% good-enough" success criterion.
2. **Cloudflare AI Gateway** — two integration styles with the AI SDK:
   - **Simplest (Cloudflare-documented): keep your existing provider, route via the gateway binding URL.** `createAnthropic({ baseURL: await env.AI.gateway("my-gateway").getUrl("anthropic") })` — no extra package, just point the provider at the gateway.
   - **`ai-gateway-provider` package** (`createAiGateway`) — needed for **automatic multi-provider fallback** (primary + backup model array) as a first-class feature, plus caching/observability.
   - ⚠️ **Naming collision:** the `ai` package now ships its own built-in `gateway` provider (`import { gateway } from "ai"`, requires `ai ≥ 5.0.36`) — that is **Vercel's** AI Gateway, a different product from **Cloudflare's** AI Gateway. Don't mix them up when reading docs.

What differs when swapping: **model IDs** (per-provider — check each provider's docs); **prompt format is the same** (the AI SDK normalizes `messages`/`prompt`), but **Polish quality and "character" fidelity should be tested per model** (hence OpenRouter during validation); provider-specific params (`thinking` on Anthropic, `safetySettings` on Google) differ but aren't used for a simple summarization call. **Bottom line: vendor lock-in is effectively nil** — picking Anthropic first is a one-line-reversible decision.

## Cloudflare AI Gateway cost (verified via Cloudflare docs, 2026-07-05)

**The gateway itself is free** — logging, caching, rate/spend limits, analytics, and provider fallback are applied automatically with no per-request fee. It's a proxy layer, not a separate paid inference product. Cost depends only on the auth mode:

- **BYOK (Bring Your Own Keys) — recommended, zero markup.** Use your own Anthropic (or Google) key; traffic flows through the gateway but you bill directly with the provider — **Cloudflare adds nothing**. You pay exactly what you'd pay calling the provider without the gateway, and get caching/logs/fallback for free.
- **Unified Billing — convenient, +5%.** Load Cloudflare credits, no provider keys to manage. The only markup is a **5% fee on credits purchased** ($100 top-up → $105 charge); inference itself is passed through at provider rates with no markup. Not needed for the MVP.

Extra notes for MVP scale:
- **Caching can lower cost** — reprocessing the same video serves from cache and **skips paying for inference** again.
- **Log storage has a plan-based limit** (Free tier is smaller) — not a per-request charge; once full, old logs must be deleted to store new ones. Irrelevant for a single-user MVP.
- Works on the **free Workers plan**.

**Bottom line:** with BYOK + an Anthropic key, AI Gateway is **no additional cost** — it's pure upside (free Anthropic→Gemini fallback, caching, cost visibility). This makes plan B for poor model quality cheap: the gateway gives the fallback "for free."

## Impact on the risk register (`infrastructure.md`)

- **"YouTube rate-limits/blocks transcript fetches from CF IPs" (M/H)** — confirmed true for direct fetch; **mitigated** by using a transcript API (route via third party, as the register's own mitigation anticipated).
- **"transcript/LLM dependency uses unsupported `node:` APIs on workerd" (M/H)** — **mitigated**: transcript API is `fetch`; AI SDK is edge-native. Avoid root `@anthropic-ai/sdk`.
- **"Long-transcript processing blows the free 10ms CPU budget" (M/M)** — **largely mitigated**: heavy parsing is offloaded; token-heavy work goes to the LLM, not the Worker.
- **Railway escape hatch** — likely **not needed**.

## Open items for `/10x-plan`

- Pick transcript provider (default: Supadata) and confirm exact current package versions + Claude model ID via Context7 before coding.
- Define the residual "transcript truly unavailable" user-facing error (PRD Open Q1 remainder).
- Decide whether to route the LLM through Cloudflare AI Gateway now or defer.

## Sources

- `youtube-transcript-ts` README + issue #1 (datacenter-IP block, platform matrix) — github.com/hallelx2/youtube-transcript-ts
- Python `youtube-transcript-api` issue #572 (bot-protection on timedtext)
- Supadata pricing / docs / `@supadata/js` (free tier, `auto` Whisper fallback)
- Cloudflare `workers-ai-provider` + `ai-gateway-provider` READMEs (Vercel AI SDK on Workers, provider fallback)
- Markaicode: Cloudflare Workers + Anthropic (avoid root SDK; use `/edge` or raw fetch)
- Cloudflare docs — AI Gateway Unified Billing (5% credit fee, BYOK zero-markup), Logging (plan-based storage limit)
- Google AI / Gemini API docs + Exa (2026-07-05) — current Gemini lineup: `gemini-3.5-flash` GA, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`
- OpenAI API docs + Exa (2026-07-05) — current lineup: `gpt-5.5` / `gpt-5.5-pro`, `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.4-nano`
