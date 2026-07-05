---
change_id: transcript-llm-probe
title: Transcript llm probe
status: new
created: 2026-07-04
updated: 2026-07-05
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- **2026-07-05 — Research recorded in [`research.md`](./research.md)** (`web_search_exa`). Key decisions:
  - **Transcript:** do NOT fetch from the Worker (YouTube hard-blocks CF datacenter IPs since late 2024). Use a managed transcript REST API — default **Supadata** (`@supadata/js`, 100 free credits/mo, `auto`-mode Whisper fallback resolves PRD Open Q1).
  - **LLM:** Vercel AI SDK (`ai`) + a frontier provider (Anthropic / OpenRouter) for Polish quality; avoid root `@anthropic-ai/sdk` on workerd.
  - Both calls are I/O-bound → CPU-limit + `nodejs_compat` risks largely mitigated; Railway escape hatch likely unnecessary.
  - Probe must run on the **deployed** Worker (`10x-media.nightshiftlab.workers.dev`), watched via `wrangler tail`.
