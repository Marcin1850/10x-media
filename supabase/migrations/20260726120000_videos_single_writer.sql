-- Migration: make `videos` single-writer at the privilege and policy layers.
--
-- Why this exists: 20260725120000_video_metadata.sql added five vendor-reported columns
-- (channel_name, duration_seconds, published_at, transcript_lang, transcript_available_langs) and
-- renamed thumbnail_url to thumbnail_url_reported precisely to record that those values are what
-- Supadata said, never a value the app derived or repaired. That provenance claim is only as strong
-- as the set of writers: `authenticated` still held INSERT/UPDATE on the table plus matching
-- per-row RLS policies from 20260613145120, so a client talking straight to PostgREST could write
-- any of them — forging a channel, a duration, a publication date, or storing exactly the derived
-- thumbnail fallback the schema comment forbids. Cross-user isolation was never at risk (the
-- policies are owner-scoped); provenance was.
--
-- Since F23 no application code touches `videos` directly: every row is created and updated by the
-- SECURITY DEFINER `persist_summary` RPC, which runs as the function owner and is unaffected by the
-- privileges below. Removing the client write path therefore closes the forgery surface without
-- removing a path anything uses.
--
-- authenticated keeps SELECT (read your own videos) and DELETE (remove your own). Reads and deletes
-- cannot forge a vendor claim, and the owner-scoped policies for both remain in force.
--
-- Pattern follows 20260714101500: revoke-then-grant asserts the intended end state rather than
-- assuming the starting one.

-- 1. Drop to a known-empty baseline for the client-facing roles.
revoke all on public.videos from anon, authenticated;

-- 2. Re-grant exactly the intended privileges. Row-level access is still governed by the remaining
-- RLS policies; these grants only open the table so RLS can then filter it.
grant select, delete on public.videos to authenticated;

-- anon intentionally receives nothing, as before.
-- service_role is deliberately left as-is: it bypasses RLS by design.

-- 3. Remove the write policies themselves, so the intent is legible in the policy list and a future
-- re-grant cannot silently reopen the path.
drop policy if exists "videos_insert_authenticated" on public.videos;
drop policy if exists "videos_update_authenticated" on public.videos;
