-- Migration: split `summaries.metadata_via = 'fetched'` into 'fetched' and 'fetch_failed'.
--
-- Why this exists: 20260731120000_metadata_cache.sql wrote 'fetched' on every cache MISS — before
-- the vendor call was made — and left it there when `fetchVideoMetadata` came back with nothing.
-- The value therefore meant "a request was attempted", while its own comment described it as a
-- billed call. Those are not the same row: a failed metadata call is billed 0 (which is exactly why
-- D9 refuses to cache it), so reading 'fetched' as billing truth overcounts every failure.
--
-- Rather than soften the comment and leave one value covering two outcomes, the outcome now lives in
-- the marker. 'fetched' means the vendor returned metadata; 'fetch_failed' means the request went
-- out and produced nothing. Both bracket an HTTP call in `metadata_ms`; only the first produced a
-- row worth caching. Exact billing is still `supadata_calls`, per call, as it always was — the
-- marker records provenance, not money.
--
-- No backfill. Rows written between 20260731120000 and this migration carry 'fetched' whether or not
-- the call succeeded, and nothing on the row can tell them apart after the fact. Reconstructing the
-- distinction from an inference is the thing D11 and D13 refuse to do, so those rows stay as
-- written and the split is honest only from here forward.

alter table public.summaries drop constraint if exists summaries_metadata_via_check;
alter table public.summaries
  add constraint summaries_metadata_via_check
  check (metadata_via is null or metadata_via in ('fetched', 'fetch_failed', 'stored', 'skipped_budget'));

comment on column public.summaries.metadata_via is
  'How this generation obtained video metadata: ''fetched'' = a Supadata call that RETURNED metadata; '
  '''fetch_failed'' = a Supadata call was attempted and returned nothing (billed 0, not cached per '
  'S-09 D9); ''stored'' = served from metadata_cache with NO call at all; ''skipped_budget'' = the '
  'budget breaker refused the call and nulls were persisted (S-09 Phase 6). This column records '
  'PROVENANCE, not spend — for what was actually billed, join supadata_calls, which logs each call '
  'individually including the retry. Null on rows predating S-09 Phase 4; rows written between '
  '20260731120000 and 20260731140000 say ''fetched'' even when the call failed, and are not '
  'retroactively distinguishable. '
  'METADATA_MS IS ONLY COMPARABLE ACROSS ROWS THAT ACTUALLY CALLED THE VENDOR (''fetched'' and '
  '''fetch_failed''): on a hit that column brackets a database read and reads near zero, on a call it '
  'brackets HTTP including its ~1.2 s rate-limit retry sleep. Compare success latency on ''fetched'' '
  'alone — a failure''s duration is a timeout or an error, not a service time.';
