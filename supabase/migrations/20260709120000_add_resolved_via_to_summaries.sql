-- Migration: add resolved_via column to summaries (records how the transcript was fetched)
-- Created: 20260709120000
-- Additive and idempotent — no touch to existing columns, RLS, or prior migrations.
-- Column inherits the table's existing per-user RLS policies.
-- Names the observed fetch mechanism only ('inline' vs 'job') — not a claim about whether
-- Supadata served native YouTube captions or a Whisper-generated transcript, which the API
-- does not expose. Nullable: existing rows predate this column.

alter table public.summaries add column if not exists resolved_via text check (resolved_via in ('inline', 'job'));
