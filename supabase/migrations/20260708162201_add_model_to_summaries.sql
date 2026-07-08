-- Migration: add model column to summaries (records the served model slug)
-- Created: 20260708162201
-- Additive and idempotent — no touch to existing columns, RLS, or F-01's migration.
-- Column inherits the table's existing per-user RLS policies.
-- No unique constraint added — multiple summaries per (video_id, character) remain valid by design.

alter table public.summaries add column if not exists model text;
