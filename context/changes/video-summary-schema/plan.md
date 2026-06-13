# Data schema for videos and summaries + per-user RLS — Implementation Plan

## Overview

Create the project's first Supabase migration: a `videos` table (one source row per YouTube URL per user) and a `summaries` table (a video has many summaries, each with a channel character and Polish content), both with row-level security enforcing per-user isolation. Add matching hand-written TypeScript entity types in `src/types.ts`. This is roadmap foundation **F-01** (`context/foundation/roadmap.md`); it unlocks S-01/S-02/S-03 and is the database-level enforcement of the PRD's only guardrail (data privacy).

## Current State Analysis

- **No domain schema exists.** `supabase/migrations/` does not exist yet — this is the first migration. Only `auth.users` is in use today.
- **Supabase client is wired.** `src/lib/supabase.ts` creates a cookie-based SSR client from `SUPABASE_URL`/`SUPABASE_KEY` (`astro:env/server`). Nothing reads domain tables yet.
- **A house migration template exists** in `.claude/skills/new-migration/SKILL.md`: lowercase SQL, `id uuid` PK, `user_id uuid references auth.users(id) on delete cascade`, `created_at timestamptz not null default now()`, RLS enabled, **one policy per (operation, role)** — never a blanket `for all`, never RLS off.
- **No `src/types.ts` yet.** CLAUDE.md designates it for shared entities/DTOs; there is no generated `database.types.ts` and no generated-types tooling in the repo.
- **Postgres 17** local stack (`supabase/config.toml`, `db.major_version = 17`), applied via `npx supabase` CLI (Docker).

## Desired End State

After this plan:

- Running `npx supabase migration up` (or a fresh `npx supabase start`) creates `public.videos` and `public.summaries` with RLS enabled.
- A logged-in user can only ever read/write their own `videos` and `summaries` rows — verifiable in Supabase Studio by querying as two different users and seeing isolated result sets.
- `src/types.ts` exports `ChannelCharacter`, `Video`, and `Summary`, so S-01 can code against typed entities.
- Lint, typecheck, and build pass; the foundation carries no integration code (S-01 owns the first real writes).

### Key Discoveries:

- Migration template + RLS contract: `.claude/skills/new-migration/SKILL.md:25-52` — follow exactly (lowercase, per-operation/per-role policies).
- SSR client + env contract: `src/lib/supabase.ts:1-24` — secrets via `astro:env/server`, not `import.meta.env`.
- Channel character is a fixed two-value set (FR-004) and the PRD non-goals forbid other characters or editing them — a CHECK constraint fits without enum-migration ceremony (`context/foundation/prd.md:58, 100-102`).
- Character is chosen **per generation** (US-01, `prd.md:41-45`), so it belongs on `summaries`, enabling both an informational and an educational summary for the same video.

## What We're NOT Doing

- **No generation-state fields** (`status`, `error`, nullable content) — deferred to S-01, which owns async/sync generation and the missing-transcript fallback (PRD Open Q1). F-02 has not yet resolved whether generation fits the Worker CPU budget, so the foundation does not presume the model.
- **No metadata-fetch logic.** `videos.title` / `videos.thumbnail_url` columns exist but are nullable and left unpopulated here; fetching YouTube metadata belongs to a later slice.
- **No repository/service layer, no API routes, no UI** — S-01 onward.
- **No generated `database.types.ts`** and no Supabase type-gen tooling — types are hand-written this round.
- **No anon access policies** — registration is closed (PRD Access Control); only `authenticated` policies are created. RLS denies anon by default.
- **No seed data.**

## Implementation Approach

Two phases. Phase 1 writes a single migration file following the in-repo template, defining both tables and their RLS policies together (summaries policies scope on the row's own `user_id`, which is duplicated onto each summary for a simple, index-friendly policy predicate rather than a subquery join to `videos`). Phase 2 adds the hand-written entity types mirroring the schema. The phases are independently verifiable: Phase 1 by applying the migration locally and inspecting RLS in Studio; Phase 2 by typecheck/lint.

## Critical Implementation Details

- **`summaries.user_id` is denormalized on purpose.** Carrying `user_id` directly on `summaries` (in addition to `video_id`) lets every summaries RLS policy use the flat predicate `auth.uid() = user_id` — matching the template and avoiding an `exists (select … from videos)` subquery in the policy hot path.
- **Owner-consistency is enforced in the DB, not trusted to the caller.** Because `user_id` is denormalized, nothing about a single-column `video_id → videos(id)` FK would stop a summary from pointing at *another* user's video while carrying its own `user_id` (the row would still pass summaries RLS). The composite FK `(video_id, user_id) → videos(id, user_id)` closes this: a summary can only reference a video with the *same* owner, so the privacy/integrity guardrail does not depend on the S-01 insert path setting `user_id` correctly. (Note: `videos` RLS already blocks *reading* another user's video through such a dangling reference, and `video_id` is an unguessable UUID — so this is defense-in-depth / integrity, not a patch for an active read leak.) The composite FK requires the `unique (id, user_id)` constraint on `videos` as its referenceable target.
- **Migration ordering:** create `videos` before `summaries` (FK dependency), and define each table's policies immediately after its `enable row level security` statement.

## Phase 1: Schema migration (videos + summaries + RLS)

### Overview

Create `public.videos` and `public.summaries` with constraints and per-user RLS in one migration file.

### Changes Required:

#### 1. New migration file

**File**: `supabase/migrations/20260613145120_videos_and_summaries.sql` (create `supabase/migrations/` directory)

**Intent**: Define both domain tables and lock the privacy guardrail at the database level before any user data lands. Follow the house template exactly (lowercase SQL, per-operation/per-role policies, RLS on).

**Contract**:

- `public.videos`
  - `id uuid primary key default gen_random_uuid()`
  - `user_id uuid not null references auth.users(id) on delete cascade`
  - `url text not null`
  - `youtube_id text not null`
  - `title text` (nullable — populated by a later slice)
  - `thumbnail_url text` (nullable — populated by a later slice)
  - `created_at timestamptz not null default now()`
  - `unique (user_id, youtube_id)` — one video row per URL per user (dedup)
  - `unique (id, user_id)` — not for dedup (`id` is already PK); exists solely as the target a composite FK can reference, so `summaries` can enforce owner-consistency at the DB level (see below).
- `public.summaries`
  - `id uuid primary key default gen_random_uuid()`
  - `user_id uuid not null references auth.users(id) on delete cascade`
  - `video_id uuid not null` — validity + owner-consistency enforced by the composite FK below (no separate single-column FK)
  - `character text not null check (character in ('informational', 'educational'))`
  - `content text not null`
  - `created_at timestamptz not null default now()`
  - `foreign key (video_id, user_id) references public.videos (id, user_id) on delete cascade` — **owner-consistency guardrail**: a summary can only point at a video owned by the *same* user. Replaces a plain `video_id → videos(id)` FK; the DB now rejects any summary whose `user_id` differs from its parent video's owner, instead of trusting the S-01 insert path to keep them aligned.
  - `index summaries_user_id_idx on (user_id)` — backs the RLS `auth.uid() = user_id` predicate (Postgres does not auto-index FK/RLS columns).
  - `index summaries_video_id_idx on (video_id)` — backs joins to `videos` and the cascade-delete lookup when a video is removed.
- RLS: `enable row level security` on both tables. For **each** table, four policies, all `to authenticated`, predicate `auth.uid() = user_id`:
  - `<table>_select_authenticated` — `for select using (auth.uid() = user_id)`
  - `<table>_insert_authenticated` — `for insert with check (auth.uid() = user_id)`
  - `<table>_update_authenticated` — `for update using (auth.uid() = user_id) with check (auth.uid() = user_id)`
  - `<table>_delete_authenticated` — `for delete using (auth.uid() = user_id)`
- No `anon` policies (RLS denies by default).

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly on a fresh local stack: `npx supabase db reset`
- Tables exist with RLS enabled (e.g. `select relrowsecurity from pg_class where relname in ('videos','summaries')` returns `t` for both)
- Indexes `summaries_user_id_idx` and `summaries_video_id_idx` exist (e.g. `select indexname from pg_indexes where tablename = 'summaries'`)
- Lint passes: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:

- In Supabase Studio, both tables appear with RLS "enabled" and four policies each.
- As user A, insert a video + summary; as user B, a `select` over both tables returns zero of user A's rows (isolation holds).
- Inserting a summary with `character = 'other'` is rejected by the CHECK constraint.
- Inserting a summary whose `video_id` belongs to user A but `user_id` is user B is rejected by the composite FK (owner-consistency holds — the row cannot be created at all).
- Deleting a `videos` row cascades to its `summaries` rows.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation that the RLS isolation check in Studio succeeded before proceeding to Phase 2.

---

## Phase 2: TypeScript entity types

### Overview

Hand-write the shared entity types mirroring the schema so S-01 has typed contracts.

### Changes Required:

#### 1. Shared entities file

**File**: `src/types.ts` (new)

**Intent**: Expose `ChannelCharacter`, `Video`, and `Summary` as the canonical entity shapes for the two tables, matching the migration column-for-column. CLAUDE.md designates `src/types.ts` for shared entities/DTOs.

**Contract**:

- `export type ChannelCharacter = "informational" | "educational";`
- `export interface Video` — fields: `id: string`, `user_id: string`, `url: string`, `youtube_id: string`, `title: string | null`, `thumbnail_url: string | null`, `created_at: string`.
- `export interface Summary` — fields: `id: string`, `user_id: string`, `video_id: string`, `character: ChannelCharacter`, `content: string`, `created_at: string`.
- Field names match SQL column names exactly (snake_case) so rows map 1:1 onto these types.

### Success Criteria:

#### Automated Verification:

- Typecheck passes: `npm run build` (Astro `astro check`/tsc via the build) or `npx tsc --noEmit`
- Lint passes: `npm run lint`

#### Manual Verification:

- `ChannelCharacter` union matches the migration's CHECK values exactly (`informational`, `educational`).
- Each interface's fields match the corresponding table's columns (names + nullability).

**Implementation Note**: After automated verification passes, this completes the change. No further manual gate needed beyond the field/CHECK parity check above.

---

## Testing Strategy

### Unit Tests:

- None — there is no business logic in this change (schema + type declarations only). Tests arrive with S-01's integration code.

### Integration Tests:

- None this round. The migration's RLS behavior is verified manually in Studio (above); automated multi-user RLS tests are deferred to when a service layer exists (S-01).

### Manual Testing Steps:

1. `npx supabase start` (or `npx supabase db reset` if already running) — migration applies without error.
2. In Studio, confirm both tables show RLS enabled with four policies each.
3. Insert a video + summary as user A; confirm user B cannot see them.
4. Attempt a summary insert with an invalid `character` — expect rejection.
5. Attempt a summary insert with a `video_id` from user A but `user_id` of user B — expect rejection by the composite FK.
6. Delete a video — confirm its summaries cascade-delete.

## Performance Considerations

Negligible at MVP scale (PRD `target_scale`: small users, low qps, small data). Index coverage is made explicit rather than assumed — Postgres auto-indexes PKs and `unique` constraints but **not** FK columns:

- `videos`: `unique (user_id, youtube_id)` backs dedup lookups and, via its leading `user_id` column, the `videos` RLS predicate.
- `summaries`: explicit `summaries_user_id_idx` backs the RLS `auth.uid() = user_id` predicate; `summaries_video_id_idx` backs joins to `videos` and the cascade-delete lookup. Without these the earlier "index-friendly" claim was unbacked — the flat `user_id` predicate only helps if `user_id` is actually indexed.

## Migration Notes

First migration in the repo — creates `supabase/migrations/`. Applied locally via `npx supabase migration up` / `db reset`; ships to remote on the next `supabase db push` / deploy. No existing data to migrate.

## References

- Roadmap item: `context/foundation/roadmap.md` (F-01)
- Change identity: `context/changes/video-summary-schema/change.md`
- Migration + RLS template: `.claude/skills/new-migration/SKILL.md:25-52`
- Supabase SSR client: `src/lib/supabase.ts:1-24`
- PRD (model constraints, privacy guardrail): `context/foundation/prd.md:36-37, 41-45, 58, 90-92, 100-102`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema migration (videos + summaries + RLS)

#### Automated

- [ ] 1.1 Migration applies cleanly on a fresh local stack: `npx supabase db reset`
- [ ] 1.2 Tables exist with RLS enabled (`pg_class.relrowsecurity` is `t` for both)
- [ ] 1.3 Indexes `summaries_user_id_idx` and `summaries_video_id_idx` exist
- [ ] 1.4 Lint passes: `npm run lint`
- [ ] 1.5 Build passes: `npm run build`

#### Manual

- [ ] 1.6 Both tables show RLS enabled with four policies each in Studio
- [ ] 1.7 User-A rows are invisible to user B (isolation holds)
- [ ] 1.8 Invalid `character` value rejected by CHECK constraint
- [ ] 1.9 Summary insert with mismatched `video_id` (user A) + `user_id` (user B) rejected by composite FK
- [ ] 1.10 Deleting a video cascades to its summaries

### Phase 2: TypeScript entity types

#### Automated

- [ ] 2.1 Typecheck passes: `npm run build` / `npx tsc --noEmit`
- [ ] 2.2 Lint passes: `npm run lint`

#### Manual

- [ ] 2.3 `ChannelCharacter` union matches the CHECK values exactly
- [ ] 2.4 Each interface's fields match the table columns (names + nullability)
