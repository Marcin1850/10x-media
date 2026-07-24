---
change_id: generate-and-save-summary
title: Generate and save a video summary
status: deployed
created: 2026-07-18
updated: 2026-07-24
archived_at: null
---

## Deployment

Phases 1–7 are **live in production** as of 2026-07-24.

- Merged `generate-and-save-summary` → `master` (fast-forward, `99adfea..f415f12`);
  GitHub Actions CI + deploy jobs both green, Worker deployed to Cloudflare via
  `wrangler deploy`.
- The 9 expand migrations (`20260719120000` … `20260723140000`) were applied to the
  production Supabase project (`ukbptccdffiigkdekzcn`) with `supabase db push` **before**
  the Worker deploy; `supabase migration list --linked` reports prod fully in sync.
- **Remaining**: Phase 8 (contract migration dropping the six superseded RPCs) was gated
  on the phases 1–7 Worker being live — that gate is now satisfied, so Phase 8 is
  **unblocked but not yet done**. See `plan.md` §Phase 8 / Progress. The change is not
  ready to `/10x-archive` until Phase 8 ships.

## Notes

Roadmap slice **S-01** (north star) — see `context/foundation/roadmap.md`.

Outcome: the user pastes a YouTube video URL, selects the channel character
(informational or educational), and gets a Polish summary tailored to that
character, which is then saved.

- PRD refs: US-01, FR-003, FR-004, FR-005
- Prerequisites (both done): F-01 `video-summary-schema` (tables + RLS),
  F-02 `transcript-llm-probe` (transcript→LLM path verified on the Worker).
- Integrates with S-05 `summary-credits` — reuse the existing `credits` service
  for the up-front read gate + spend-on-success at the generation endpoint.
- Carry F-02 follow-ups into this slice: LLM prompt-engineering, transcript-length
  guard, upstream-error handling.
- Open (non-blocking) questions: how to handle a video with no available
  transcript (user-facing message); exact YouTube URL validation rules + error
  communication.
