# Data schema for videos and summaries + per-user RLS — Plan Brief

> Full plan: `context/changes/video-summary-schema/plan.md`

## What & Why

Create the project's first Supabase migration — `videos` and `summaries` tables with per-user row-level security — plus matching TypeScript entity types. This is roadmap foundation **F-01**: it unlocks S-01/S-02/S-03 and enforces the PRD's only guardrail (data privacy) at the database level before any user data lands.

## Starting Point

No domain schema exists; `supabase/migrations/` is empty and only `auth.users` is in use. A house migration template (`.claude/skills/new-migration/SKILL.md`) already defines the RLS pattern to follow. There is no `src/types.ts` yet.

## Desired End State

Applying the migration creates both tables with RLS enabled, so a logged-in user can only read/write their own rows. `src/types.ts` exports `ChannelCharacter`, `Video`, and `Summary` for S-01 to code against. No integration code ships — S-01 owns the first real writes.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Table relationship | video 1 → N summaries (`summaries.video_id` FK) | Dedupes the video source while allowing both characters / regeneration per URL | Plan |
| Channel character | On `summaries`, `text` + CHECK (`informational`/`educational`) | Character is chosen per generation (US-01); CHECK fits a fixed two-value set without enum ceremony | Plan |
| `videos` columns | `url`, `youtube_id` (+ unique per user), plus nullable `title`/`thumbnail_url` | Dedup key now; metadata columns reserved but unpopulated until a later slice | Plan |
| `summaries` columns | `content` only — no status/error this round | Faithful to scope guard; doesn't presume the (still-unprobed) generation model | Plan |
| TypeScript types | Hand-write entities in `src/types.ts` | Typed foundation for S-01 with no running-DB dependency | Plan |
| RLS predicate | Flat `auth.uid() = user_id`, `user_id` denormalized onto `summaries` | Avoids a subquery join in the policy; backed by an explicit `summaries(user_id)` index | Plan |
| Owner consistency | Composite FK `summaries(video_id, user_id) → videos(id, user_id)` | Denormalized `user_id` enforced in the DB, not trusted to the S-01 insert path | Plan (review) |
| Index coverage | Explicit `summaries_user_id_idx` + `summaries_video_id_idx` | Postgres doesn't auto-index FK/RLS columns; backs the "index-friendly" claim | Plan (review) |

## Scope

**In scope:** one migration file (both tables + constraints + per-user RLS policies); `src/types.ts` with `ChannelCharacter`/`Video`/`Summary`.

**Out of scope:** generation-state fields (status/error), metadata fetching, repository/service layer, API routes, UI, generated `database.types.ts`, anon policies, seed data, automated tests.

## Architecture / Approach

`videos` (one row per YouTube URL per user, `unique(user_id, youtube_id)`) ← `summaries` (1→N) via a **composite FK** `(video_id, user_id) → videos(id, user_id)` that forces a summary's owner to match its video's owner. Both tables get `enable row level security` and four `authenticated` policies (select/insert/update/delete) keyed on `auth.uid() = user_id`. `summaries.user_id` is denormalized so policies stay flat, with explicit indexes on `summaries(user_id)` and `summaries(video_id)`. Entity types in `src/types.ts` mirror the columns 1:1 (snake_case).

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema migration | `videos` + `summaries` tables with per-user RLS + composite owner-consistency FK | RLS predicate wrong → privacy leak; verified by two-user isolation + owner-mismatch rejection checks in Studio |
| 2. TypeScript entities | `src/types.ts` with the three entity types | Types drift from schema → caught by parity check + typecheck |

**Prerequisites:** local Supabase stack runnable (Docker) for applying/verifying the migration.
**Estimated effort:** ~1 short session across 2 phases.

## Open Risks & Assumptions

- Assumes synchronous-vs-async generation is undecided (F-02 pending) — hence no status/error columns; S-01 will likely add a small follow-up migration.
- `title`/`thumbnail_url` ship nullable and empty; a later slice must populate them.
- Denormalized `summaries.user_id` is kept consistent with the parent video's owner by the composite FK — so S-01's insert path must supply a `(video_id, user_id)` pair that already matches an existing video row (a mismatch is rejected outright rather than silently stored).

## Success Criteria (Summary)

- Migration applies cleanly on a fresh stack; both tables show RLS enabled with four policies each.
- A second user cannot see the first user's videos or summaries (isolation verified in Studio).
- `src/types.ts` typechecks and matches the schema column-for-column.
