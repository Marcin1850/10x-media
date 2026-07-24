---
change_id: generate-and-save-summary
title: Generate and save a video summary
status: impl_reviewed
created: 2026-07-18
updated: 2026-07-24
archived_at: null
---

## Deployment

All 8 phases are **live in production** as of 2026-07-24.

- Merged `generate-and-save-summary` → `master` (fast-forward, `99adfea..f415f12`);
  GitHub Actions CI + deploy jobs both green, Worker deployed to Cloudflare via
  `wrangler deploy`.
- The 9 expand migrations (`20260719120000` … `20260723140000`) were applied to the
  production Supabase project (`ukbptccdffiigkdekzcn`) with `supabase db push` **before**
  the Worker deploy; `supabase migration list --linked` reports prod fully in sync.
- **Phase 8** (contract migration `20260724120000_drop_legacy_rpcs.sql` dropping the six
  superseded RPCs) is **live in production** as of 2026-07-24. Implemented in `9085d03`
  (migration + removal of the dead `reserveCredits` wrapper and its `AppDatabase` Function
  entries), merged fast-forward to `master` (`f415f12..a3c67d1`), Worker redeployed via CI
  run 30128397834 (`ci` + `deploy` green), then `supabase db push --linked` applied the drop;
  `migration list --linked` reports local/remote in sync.
- Cloud verification (plan.md Progress 8.5–8.7, all closed): the deployed Worker never called
  any dropped RPC — `reserveCredits` had no call site; a production `supabase db dump` shows
  all six functions absent (definitions and grants); `settle_reservation` and
  `reconcile_reservation` remain, `service_role`-only. The live normal/long generation smoke
  test was **accepted without re-execution** — the drops are structurally verified and the
  generation path is covered by `reviews/manual-e2e-2026-07-23.md`.
- S-01 is complete and ready for `/10x-archive`.

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
