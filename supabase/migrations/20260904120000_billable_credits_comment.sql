-- Comment-only. Corrects the fifth and last stale instance of the "unit settled by Phase 5 run 3"
-- claim (README, roadmap D14/S-05, and readBillableCredits' JSDoc were already corrected in 5c20bbe).
-- No structural change, no data touched.
comment on column public.supadata_calls.billable_credits is
  'Stored VERBATIM from the response''s `x-billable-requests` header. NULL means the vendor reported '
  'nothing (or the response never arrived); 0 means it reported free. Keeping those two distinct is '
  'what makes a reconciliation gap against GET /v1/me diagnosable rather than merely visible. The '
  'header''s unit is CREDITS, despite the name saying requests — settled 2026-07-29, see '
  'context/changes/persist-time-and-cost/docs/supadata-billable-requests.md (§Resolved, §Measured).';
