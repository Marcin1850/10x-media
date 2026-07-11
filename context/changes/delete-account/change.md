---
change_id: delete-account
title: Delete account + all data (GDPR)
status: plan_reviewed
created: 2026-07-11
updated: 2026-07-11
archived_at: null
---

## Notes

Derived from roadmap item **S-04** (`context/foundation/roadmap.md`) — Linear **MAR-10**.

- **Outcome:** the user permanently deletes their account, and all associated data (videos, summaries, credits) is removed — satisfying the GDPR right to erasure.
- **PRD refs:** Access Control, NFR (data privacy).
- **Prerequisites:** F-01 (done). Auth account already exists in the baseline.
- **Parallel with:** S-05 (summary-credits).
- **Unknowns:** hard delete vs. soft-delete + purge window (owner: user); how to remove the Supabase `auth.users` record from an SSR endpoint — service-role key vs. client (owner: implementation).
- **Care point:** completeness (no orphaned rows) over complexity.
