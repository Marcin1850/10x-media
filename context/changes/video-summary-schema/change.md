---
change_id: video-summary-schema
title: Data schema for videos and summaries + per-user RLS
status: impl_reviewed
created: 2026-06-13
updated: 2026-06-18
archived_at: null
---

## Notes

Derived from roadmap item **F-01** (`context/foundation/roadmap.md`).

- **Outcome:** `videos` and `summaries` tables exist in Supabase with per-user RLS policies; multi-tenant privacy enforced at the database level.
- **PRD refs:** Access Control, NFR (data privacy), FR-006.
- **Unlocks:** S-01 (generate-and-save-summary), S-02 (browse-summary-list), S-03 (delete-summary); reduces the privacy-guarantee risk before any user data lands in the DB.
- **Prerequisites:** — (auth present in baseline). **Parallel with:** F-02 (transcript-llm-probe).
- **Scope guard:** two tables + RLS policies only — does NOT build "the whole data layer". S-01 integrates this layer through real summary writes.
- **Risk:** Low. Sequenced early because every data slice assumes these tables and skipping RLS would break the privacy guarantee.
