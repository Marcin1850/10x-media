# Transcript → LLM Probe (F-02) — Plan Brief

> Full plan: `context/changes/transcript-llm-probe/plan.md`
> Research: `context/changes/transcript-llm-probe/research.md`

## What & Why

Prove — on the **deployed** Cloudflare Worker, not just local dev — that the product's core path works: a YouTube URL → Polish-language summary via a managed transcript API + a frontier LLM, persisted to the database. This is the roadmap's top-risk de-risk spike (`F-02`); it unblocks the north-star slice `S-01`. If this path fails on workerd or the free plan, we find out now, while schedule slack exists.

## Starting Point

The runtime is already provisioned for the target libraries (`nodejs_compat` + recent `compatibility_date` in `wrangler.jsonc`), and the F-01 `videos`/`summaries` tables exist with per-user RLS. What's absent: any AI/transcript code, the two API keys in the env schema, and a `model` column on `summaries`. Auth resolves `context.locals.user` on every request via middleware.

## Desired End State

An auth-protected `POST /api/summaries/probe` accepting `{ url, character }` returns a Polish summary and appends a `summaries` row (with the served model slug) under a get-or-created `videos` row. `wrangler tail` confirms both external APIs are reachable from CF egress, no bundle/`nodejs_compat` errors, acceptable latency, and no free-plan CPU failure. Every re-run of a video accumulates another summary (nothing overwritten).

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Transcript source | Supadata (`@supadata/js`, `mode: "auto"`) | Direct YouTube fetch is blocked on CF datacenter IPs; managed API + Whisper fallback resolves that and PRD Open Q1 | Research |
| LLM access | Vercel AI SDK (`ai` v5) behind `getSummaryModel()` | Edge-native, workerd-safe, one-file provider swap | Research |
| LLM routing | **OpenRouter now, CF AI Gateway deferred** | One key fronts all models → avoids the ~$5–10 per-provider funding floor for A/B testing; Gateway (caching/observability) layers on later with no double markup on BYOK | Plan |
| Default model | `anthropic/claude-sonnet-5` (slug) | Current authoritative frontier-multilingual pick, $3/$15 (intro $2/$10), strong Polish — supersedes research's `sonnet-4-6` at the same price | Plan |
| Probe surface | POST endpoint only (curl + `wrangler tail`) | Thinnest de-risk; the reusable services are the real deliverable S-01 keeps | Plan |
| Persistence | Persist to `summaries`; **append-only**, store served `model` | Exercises the full slice end-to-end; keeping every summary + its model enables later manual quality comparison | Plan |
| Auth | Protected — in-handler `401` JSON guard | A live LLM endpoint spends real credits; an API route needs a JSON 401, not the middleware's page redirect | Plan |
| Secret access | `astro:env/server`, passed explicitly to each SDK | Workers secrets aren't on `process.env` — the single correction to every `docs/` snippet | Research |

## Scope

**In scope:** two API keys in `env.schema`; net-new deps (`@supadata/js ai @openrouter/ai-sdk-provider zod`); additive `summaries.model` migration + DTO; transcript/LLM/persistence services; one thin `prerender=false` POST route; live-Worker deploy & `wrangler tail` verification.

**Out of scope:** any UI (that's S-01), Cloudflare AI Gateway / `ai` binding, direct provider accounts, summary listing/deletion (S-02/S-03), streaming, structured LLM output, changes to F-01's existing columns/RLS.

## Architecture / Approach

`POST /api/summaries/probe` (auth guard + zod) → **transcript service** (Supadata, explicit key) → **LLM service** (`getSummaryModel()` → OpenRouter `anthropic/claude-sonnet-5`, `generateText`, Polish prompt tailored to character) → **persistence service** (upsert `videos` on `(user_id, youtube_id)`, `INSERT` a `summaries` row with the served `model`) → return `200 { summary, model, videoId, summaryId }`. All secrets read from `astro:env/server` and passed explicitly into each SDK constructor. Everything downstream of `getSummaryModel()` is provider-agnostic.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Config, deps & secrets | Keys in `env.schema`, packages installed, `.env.example` updated | Secret not reachable via `astro:env/server` |
| 2. Schema: `model` column | Idempotent migration + `Summary` DTO update | (low) additive-only |
| 3. Services | transcript + LLM + append-only persistence seam | Provider slug drift; unavailable-transcript handling |
| 4. Endpoint + deploy/verify | Live `POST` proven on the Worker via `wrangler tail` | **The core risk** — workerd bundle / CPU / IP egress |

**Prerequisites:** Supadata + OpenRouter accounts/keys; `wrangler` auth for `secret put` + deploy; local Supabase for the migration. F-01 tables already exist.
**Estimated effort:** ~1–2 sessions across 4 phases (thin build; the deploy/verify checkpoint is the substance).

## Open Risks & Assumptions

- **CPU/plan sufficiency is unproven until the live run** — expected fine (I/O-bound), but Phase 4 is what confirms it; Railway (`@astrojs/node`) is the documented escape hatch if not.
- **Model slugs go stale fast** — confirm `anthropic/claude-sonnet-5` on OpenRouter's models page at code time.
- **OpenRouter's ~5% margin** is baked into per-token rates; negligible at MVP volume (~$0.03–0.06/summary), accepted for the fund-once convenience.

## Success Criteria (Summary)

- Authenticated `POST` to the live Worker returns a Polish summary; `wrangler tail` shows both APIs reachable with no bundle/`nodejs_compat`/CPU errors.
- Every successful call appends a `summaries` row carrying the served model slug; the video row is created once and reused.
- A clear verdict is recorded: free Cloudflare plan sufficient (expected) or Railway escape hatch needed.
