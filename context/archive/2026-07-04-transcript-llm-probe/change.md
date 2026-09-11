---
change_id: transcript-llm-probe
title: Transcript llm probe
status: archived
created: 2026-07-04
updated: 2026-09-11
archived_at: 2026-09-11T00:06:22Z
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- **2026-07-05 — Research recorded in [`research.md`](./research.md)** (`web_search_exa`). Key decisions:
  - **Transcript:** do NOT fetch from the Worker (YouTube hard-blocks CF datacenter IPs since late 2024). Use a managed transcript REST API — default **Supadata** (`@supadata/js`, 100 free credits/mo, `auto`-mode Whisper fallback resolves PRD Open Q1).
  - **LLM:** Vercel AI SDK (`ai`) + a frontier provider (Anthropic / OpenRouter) for Polish quality; avoid root `@anthropic-ai/sdk` on workerd.
  - Both calls are I/O-bound → CPU-limit + `nodejs_compat` risks largely mitigated; Railway escape hatch likely unnecessary.
  - Probe must run on the **deployed** Worker (`10x-media.nightshiftlab.workers.dev`), watched via `wrangler tail`.
- **2026-07-06 — Codebase-compatibility verdict added to [`research.md`](./research.md)** (Follow-up section). Verdict: ✅ all 7 `docs/` libraries compatible; runtime already has `nodejs_compat` + recent `compatibility_date`. One codebase-specific correction to the `docs/` snippets: read keys from `astro:env/server` and pass them **explicitly** to each SDK constructor (Workers secrets are not on `process.env`). Also: declare `zod` as a direct dep (currently transitive), update stale `.env.example`, AI-Gateway `ai` binding deferred past the probe. Status new→preparing.
- **2026-07-09 — Phase 4 live-Worker verdict recorded in [`research.md`](./research.md)** (F-02 deliverable). Probe deployed and exercised end-to-end against `10x-media.nightshiftlab.workers.dev` under `wrangler tail`; all calls **Ok**. ✅ **Free Cloudflare plan sufficient — Railway escape hatch not needed.** Supadata + OpenRouter reachable from CF egress, no `nodejs_compat`/bundle errors, no CPU-limit failures; `401`/`400`/`422`/`200` paths all behave. Persistence appends per call, `videos` reused. F-02 de-risk complete. Follow-up (S-01, not a blocker): LLM prompts in `llm.ts` are deliberately brief and need real prompt-engineering work.
- **2026-07-09 — Phase 4 impl-review + long-form validation** ([`reviews/impl-review-phase-4.md`](./reviews/impl-review-phase-4.md)). Endpoint code matches the plan contract (thin, in-handler `401`, zod `400`, `422`/`503` fallbacks, explicit key passing); lint + Cloudflare build pass. Review flagged the async-job/long-form path as unproven on live; **closed by a live run against two long videos** — inline branch (`1zKTCcdVcGQ`, ~1 h) → `200`/33 s/`resolved_via='inline'`, and async-job branch (`1ZYbU82GVz4`, music) → `pollTranscriptJob` to full 12-attempt exhaustion (~254 s) → `422`, no rows. Two plan-assumption corrections recorded in `research.md`: long video resolved inline (not `{ jobId }`); served model slug (`…-20260630`) differs from requested. Open observations (deferred to S-01): no transcript length guard (F2), uncaught upstream errors → raw 500 (F3).
