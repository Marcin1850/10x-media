-- ---------------------------------------------------------------------------------------------
-- supadata_calls: record the vendor's HTTP status, for transcript calls.
-- ---------------------------------------------------------------------------------------------
--
-- S-09 D13. Today "a 206 transcript-unavailable costs 1 credit" is a DERIVED claim: it is inferred
-- from `outcome = 'unavailable'`, which is this app's own label applied at the call site, not
-- something the vendor said. The per-outcome reconciliation formula
--
--   sum(case when outcome = 'unavailable' then 1 else coalesce(billable_credits, 0) end)
--
-- rests entirely on that inference being right, and nothing in this table can check it. One
-- additive column turns the inference into an observation, and lets the two be compared against
-- each other — if `http_status` and `outcome` ever disagree, the formula is wrong and the credit
-- delta will say so.
--
-- Purely additive: one nullable column plus a same-signature `create or replace` of the insert RPC.
-- Nothing is dropped, no grant changes, no deploy window. An older Worker that does not send
-- `http_status` writes null, which is one of the column's documented meanings anyway.
--
-- Rollback: `alter table public.supadata_calls drop column http_status`. Leaving the column in place
-- costs nothing — nothing branches on it.

-- ---------------------------------------------------------------------------------------------
-- 1. The column.
-- ---------------------------------------------------------------------------------------------
--
-- No CHECK, deliberately — mirroring `resolved_via`. `operation` and `outcome` are CHECKed because
-- code branches on them and an unexpected value would break a branch; nothing branches on a status
-- code, and a constraint here would only turn a surprising-but-true observation into a lost row.
--
-- No backfill and no default: every pre-migration row keeps null, which reads correctly as "not
-- recorded" (D13, same reasoning as D11 — an unobserved value is not reconstructed from an
-- inference).
alter table public.supadata_calls add column if not exists http_status integer;

comment on column public.supadata_calls.http_status is
  'The HTTP status the vendor answered with, recorded VERBATIM. Populated for operation = '
  '''transcript'' only. NULL has THREE distinct meanings and none of them is "the vendor answered '
  'without a status": (1) a row written before this column existed — nothing was backfilled; '
  '(2) a call that is not operation = ''transcript'' — ''metadata'' and ''transcript_poll'' are out '
  'of scope by design, not by omission; (3) a transcript call whose request never produced a '
  'response at all — a timeout or transport rejection, where there IS no status to record. Case (3) '
  'is the one most easily misread as missing data: it is the same kind of null as an unreported '
  'x-billable-requests header, and it is the honest answer rather than a gap. Diagnostic — nothing '
  'is priced or gated from it; it exists so the reconciliation formula''s "unavailable -> 1 credit" '
  'branch can be checked against an observation instead of against our own outcome label.';

-- ---------------------------------------------------------------------------------------------
-- 2. record_supadata_calls — carry the new key through.
-- ---------------------------------------------------------------------------------------------
--
-- The plan expected no RPC change here ("written through the existing insert path"), but that path
-- enumerates its columns explicitly, so the column alone would stay permanently null while the
-- service dutifully sent the value and this function silently dropped it — a failure with no error
-- anywhere. Same `(jsonb)` signature, so `create or replace` genuinely replaces rather than
-- overloading, and the existing grants survive untouched. Body otherwise verbatim from
-- 20260728120000.
create or replace function public.record_supadata_calls(p_calls jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted integer;
begin
  if p_calls is null or jsonb_typeof(p_calls) <> 'array' or jsonb_array_length(p_calls) = 0 then
    return 0;
  end if;

  insert into public.supadata_calls (
    user_id, summary_id, youtube_id, operation, outcome, resolved_via, billable_credits, http_status
  )
  select
    nullif(call ->> 'user_id', '')::uuid,
    nullif(call ->> 'summary_id', '')::uuid,
    nullif(call ->> 'youtube_id', ''),
    call ->> 'operation',
    call ->> 'outcome',
    nullif(call ->> 'resolved_via', ''),
    nullif(call ->> 'billable_credits', '')::integer,
    -- Absent key and JSON null both yield SQL null here, which is exactly right: a caller that does
    -- not report a status is indistinguishable from one that had none to report.
    nullif(call ->> 'http_status', '')::integer
  from jsonb_array_elements(p_calls) as call;

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.record_supadata_calls(jsonb) from public, anon, authenticated;
grant execute on function public.record_supadata_calls(jsonb) to service_role;
