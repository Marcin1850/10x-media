---
change_id: transcript-llm-probe
title: Transcript llm probe
status: plan_reviewed
created: 2026-07-04
updated: 2026-07-07
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- **2026-07-05 — Research recorded in [`research.md`](./research.md)** (`web_search_exa`). Key decisions:
  - **Transcript:** do NOT fetch from the Worker (YouTube hard-blocks CF datacenter IPs since late 2024). Use a managed transcript REST API — default **Supadata** (`@supadata/js`, 100 free credits/mo, `auto`-mode Whisper fallback resolves PRD Open Q1).
  - **LLM:** Vercel AI SDK (`ai`) + a frontier provider (Anthropic / OpenRouter) for Polish quality; avoid root `@anthropic-ai/sdk` on workerd.
  - Both calls are I/O-bound → CPU-limit + `nodejs_compat` risks largely mitigated; Railway escape hatch likely unnecessary.
  - Probe must run on the **deployed** Worker (`10x-media.nightshiftlab.workers.dev`), watched via `wrangler tail`.
- **2026-07-06 — Codebase-compatibility verdict added to [`research.md`](./research.md)** (Follow-up section). Verdict: ✅ all 7 `docs/` libraries compatible; runtime already has `nodejs_compat` + recent `compatibility_date`. One codebase-specific correction to the `docs/` snippets: read keys from `astro:env/server` and pass them **explicitly** to each SDK constructor (Workers secrets are not on `process.env`). Also: declare `zod` as a direct dep (currently transitive), update stale `.env.example`, AI-Gateway `ai` binding deferred past the probe. Status new→preparing.
