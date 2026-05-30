---
project: "10xMedia"
version: 1
status: draft
created: 2026-05-25
context_type: greenfield
product_type: web-app
target_scale:
  users: small
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 3
  hard_deadline: 2026-07-05
  after_hours_only: true
---

## Vision & Problem Statement

Watching YouTube videos is time-consuming. When regularly following informational and educational channels, the list of potentially interesting content grows faster than the time available to watch it. The result: decision paralysis — the user either wastes time watching everything, or misses valuable content because there's no way to filter without watching.

YouTube algorithms recommend too much diverse content (a wide funnel instead of focused curation). Existing summarization tools work at the single-video level — but don't help choose WHICH video is worth watching in the first place. There's no tool that turns a list of videos into a key-content overview while accounting for the channel's character (informational vs educational).

## User & Persona

Single user (the product creator themselves) — a person regularly following several YouTube channels with informational and educational content. Needs a shortcut to select the most valuable materials without watching all videos.

## Success Criteria

### Primary
- 75% of summaries are considered by the user as good enough (accurate, useful for deciding whether to watch or skip a video).

### Secondary
- None — Primary is sufficient for MVP.

### Guardrails
- Privacy: summaries and video list visible only to the logged-in user. No other user or external party has access to the data.

## User Stories

### US-01: User generates a video summary

- **Given** a logged-in user
- **When** they paste a YouTube video URL and select the channel character (informational or educational)
- **Then** they see a summary of the video in Polish, tailored to the selected channel character

## Functional Requirements

- FR-001: User can create an account (registration). Priority: must-have
  > Socrates: No counter-argument. Registration is needed and well-placed in MVP.

- FR-002: User can log into their account. Priority: must-have
  > Socrates: No counter-argument. Login is fundamental.

- FR-003: User can add a YouTube video (by pasting a URL). Priority: must-have
  > Socrates: Counter-argument considered: "Lack of URL validation may generate errors — pasting a bad link = no transcription = bad UX." Resolution: kept; manual URL addition is a deliberate MVP choice, but URL validation should be accounted for in implementation.

- FR-004: User can select the channel character (informational or educational) when adding a video. Priority: must-have
  > Socrates: No counter-argument. Two characters is a deliberate MVP choice.

- FR-005: The application generates a video summary in Polish based on the transcription, according to the selected channel character. Priority: must-have
  > Socrates: Counter-argument considered: "Generation depends on transcription availability — not every video has one." Resolution: kept; this is the product's core. The risk of missing transcription should be handled (user-facing message), but doesn't block the FR.

- FR-006: User can browse their list of summaries. Priority: must-have
  > Socrates: No counter-argument. At MVP stage the list will be short.

- FR-007: User can delete a summary. Priority: nice-to-have
  > Socrates: No counter-argument. As nice-to-have it doesn't block anything.

## Non-Functional Requirements

- The product works correctly on the latest versions of two major desktop browsers (Chrome, Firefox).
- User data (summaries, video list) is private — no other user or external party has access to it.

## Business Logic

The application transforms a video transcription into a structured summary whose shape depends on the channel character: for informational — an exhaustive list of key facts/information; for educational — an overview of what the user can learn from the video.

Inputs (from the user's perspective):
- YouTube video URL (from which the transcription is automatically fetched)
- Channel character selected by the user (informational or educational)

Output:
- Summary in Polish — format depends on the character:
  - Informational: exhaustive list of key information/facts from the video
  - Educational: overview of topics and knowledge the user can gain from the video

The user encounters the result when browsing their summary list — they see a ready-made summary based on which they decide whether the video is worth watching in full.

## Access Control

Login via email + password. Multi-tenant architecture — each user sees only their own data. In MVP, registration is closed: the only user is the product creator. No role differentiation — one user = full access to all features. Structure prepared for opening registration in the future.

## Non-Goals

- Automatic summary generation for new videos on a channel — no channel subscription/monitoring; manual URL addition only.
- Generating links to specific video moments (timestamps) — the summary doesn't point to fragments; that's a separate feature.
- Sharing summaries between users — data is private; no share mechanism.
- Sources other than YouTube (podcasts, articles, other platforms) — MVP works exclusively with YouTube.
- Channel character definitions other than informational and educational.
- Automatic channel character selection.
- Editing channel character definitions.
- Mobile applications — MVP is web only.

## Open Questions

1. **How should the application handle videos without available transcription?** — Owner: user. The FR-005 Socrates round identified this risk: not every video has a transcription. The application needs a defined fallback (error message, alternative extraction, etc.).
2. **What constitutes "good enough" for the 75% success criterion?** — Owner: user. The measurement method (subjective user assessment) needs a lightweight tracking mechanism or periodic self-review to validate.
3. **What specific URL validation rules should be applied?** — Owner: implementation. FR-003 Socrates round identified that invalid URLs would produce poor UX. Need to define what counts as a valid YouTube video URL and how to communicate validation errors.
