---
change_id: generate-and-save-summary
title: Generate and save a video summary
status: impl_reviewed
created: 2026-07-18
updated: 2026-07-19
archived_at: null
---

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
