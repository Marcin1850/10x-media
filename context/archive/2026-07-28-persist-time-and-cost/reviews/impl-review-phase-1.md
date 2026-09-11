<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Persist generation time and provider cost per summary (S-07)

- **Plan**: context/changes/persist-time-and-cost/plan.md
- **Scope**: Phase 1 of 5
- **Date**: 2026-07-29
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 1 warning, 1 observation
- **Accepted exclusions**: The deployment/RPC-signature window and telemetry for pre-change historical data were not reviewed as problems, per user direction.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Verification

- `npm.cmd run lint` — PASS
- `npm.cmd run build` — PASS
- `npx.cmd supabase migration up` — PASS (`Migrations applied`, with no pending migration)
- Local database inspection — PASS: exactly one `persist_summary`; `authenticated` cannot execute it; `transcript_cache` and `supadata_calls` both have RLS enabled and zero policies; both `resolved_via` constraints admit `stored`.
- Phase 1 manual criteria 1.7–1.11 are marked complete in `## Progress` at commit `4a1b49c`.

### Post-triage (2026-07-29)

Both findings were fixed in `supabase/migrations/20260728120000_generation_telemetry.sql`. Because the migration is already recorded as applied, `supabase migration up` is a no-op for it — the amended `save_transcript_cache` and the new index were applied to the local database directly (targeted `create or replace` / `create index`, no reset), so the local schema matches the file. A clean environment picks both up from the migration as written. Added verification:

- Two-session advisory-lock probe — PASS: session B blocked on session A's open transaction and returned `true`; A returned `false`. N concurrent cold misses now yield N−1 trues.
- `pg_indexes` for `supadata_calls` — PASS: `supadata_calls_summary_idx` present.

## Findings

### F1 — Duplicate-fetch signal misses genuine concurrent cold misses

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: supabase/migrations/20260728120000_generation_telemetry.sql:255
- **Detail**: The plan promises that N concurrent cold misses produce N−1 `true` results, so every wasted fetch is observable. The function reads `fetched_at` before the upsert without serializing that decision. Two cold transactions can both read no row; one later waits on `ON CONFLICT`, but each retained `previous_fetched_at = null`, so both return `false`. The sequential 1.11 check passes while the production race remains invisible.
- **Fix**: Acquire a transaction-scoped advisory lock keyed by `p_youtube_id` immediately before the `SELECT`, then keep the existing read/compare/upsert sequence.
  - Strength: Serializes only the inexpensive cache-write decision, not the paid external fetch, and makes the promised N−1 signal reliable.
  - Tradeoff: Concurrent cache writes for the same video briefly queue at the RPC boundary; the migration must be re-applied locally after amendment.
  - Confidence: HIGH — the race follows directly from PostgreSQL statement ordering, and the repository already uses explicit serialization where an RPC reads before deciding.
  - Blind spot: A dedicated two-session concurrency check has not yet been added to the verification steps.
- **Decision**: FIXED — `perform pg_advisory_xact_lock(hashtext(p_youtube_id));` added as the first statement in `save_transcript_cache`, before the `select`. Unqualified to match the file's existing `now()` / `make_interval()` usage under `search_path = ''`. Applied to the local database as a targeted `create or replace` (no reset). The blind spot was closed: a two-session probe held the lock in an open transaction in session A while session B called the same video — B blocked ~2.5s and returned `true` while A returned `false`, i.e. 2 concurrent cold misses produced exactly 1 `true`. Probe rows deleted.

### F2 — Ledger foreign key lacks a supporting index

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: supabase/migrations/20260728120000_generation_telemetry.sql:98
- **Detail**: `supadata_calls.summary_id` uses `ON DELETE SET NULL`, but the ledger has no index beginning with `summary_id`. As the append-only table grows, deleting a summary must scan it to enforce and apply the foreign key action. Existing foundational tables index their foreign-key-leading columns.
- **Fix**: Add `create index if not exists supadata_calls_summary_idx on public.supadata_calls (summary_id);`.
- **Decision**: FIXED — index added next to the existing two, with a comment noting that `supadata_calls_user_time_idx` already covers the `user_id` FK and `summary_id` had no equivalent. Created on the local database and confirmed present in `pg_indexes`.
