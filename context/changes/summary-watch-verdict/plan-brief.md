# Summary Watch Verdict — Plan Brief

> Full plan: `context/changes/summary-watch-verdict/plan.md`

## What & Why

Users can mark each saved summary "Warto obejrzeć" / "Nie warto", or clear the mark. That records the watch/skip decision the product exists to serve (roadmap S-14, MAR-25). It is also the app's first user-initiated Update on a persisted summary, which closes the CRUD gap flagged by the 10xBuilder MVP check.

## Starting Point

`summaries` is single-writer: `authenticated` holds only `select, delete`, and the update policy was **dropped** in `20260731130000_summaries_single_writer.sql`. Delete (S-03) gives a full precedent: `[id].ts` route, RLS-scoped service, stub and real-stack route tests, and an optimistic handler in `DashboardSummaries`.

## Desired End State

Every card shows two always-visible toggle pills (icon + label). The choice is exclusive, can be cleared, and survives a reload. `PATCH /api/summaries/[id]` sets it. The database lets the owner update `worth_watching` and **no other column**, and tests prove it.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| States | `boolean null`: null / true / false | A checkbox can't return to "unmarked" | Roadmap |
| Privilege | `grant update (worth_watching)` only + re-created owner-scoped update policy (`using` + `with check`) | A table-wide grant would let clients rewrite paid content | Roadmap / Plan |
| Roster | New column-scoped verb map + invariant | `has_table_privilege` can't see column grants, and invariant 6 would fail for the wrong reason | Plan (research) |
| Rapid clicks | Disable the card's toggle while its request is in flight | Server order always equals click order, no silent drift | Plan |
| Failure | Roll back + inline error, no reconcile | The mark is idempotent and free, so a retry converges | Plan |
| 404 | Remove the card | Same "row is gone" contract as DELETE | Plan |
| Filter facet | Not in this slice | Keeps the slice small; possible follow-up | Plan |
| Look | ThumbsUp/ThumbsDown + short Polish label | Readable at a glance, not confusable with trash | Plan |
| E2E | None | e2e suite is scoped to money flows; manual reload check instead | Plan |

## Scope

**In scope:** migration (column, column grant, update policy), roster and cross-account and column-privilege tests, `setWorthWatching` service + unit tests, `listSummaries`/`SummaryListItem` read path, `PATCH` route + stub and real-stack tests, shadcn `toggle-group`, card control, dashboard handler, `pl.ts` copy.

**Out of scope:** verdict filter facet, e2e spec, using the mark as a quality signal, reconcile-on-network-failure, click queueing, any change to `persist_summary`/credits/paid path.

## Architecture / Approach

Card toggle → `DashboardSummaries.handleSetVerdict` (optimistic, locked) → `PATCH /api/summaries/[id]` (zod, anon SSR client) → `setWorthWatching` (id-only `.update().eq().select("id")`) → Postgres, where the column grant and owner-scoped policy are the enforcement point. `listSummaries` reads the column back on every load.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema, privilege, data-boundary tests | Column + narrow write path, proved by roster/cross-account/column probes | Easy table-wide grant undoes single-writer; roster blind to column grants |
| 2. Service, read path, endpoint | `PATCH` route + mark in the list payload | Missing `worth_watching` in `LIST_SELECT` makes the mark vanish on reload |
| 3. Card toggle | Visible, accessible, optimistic control | Click bubbling to the expand button; lock/rollback ordering |

**Prerequisites:** S-02 (done); local Supabase stack running.
**Estimated effort:** ~2 sessions across 3 phases.

## Open Risks & Assumptions

- Assumes PostgREST reports a column-privilege denial as an error (not zero rows), which the `content` probe relies on. Verify on first run of Phase 1.
- Work currently sits on `master`; branch before implementing (lessons.md).

## Success Criteria (Summary)

- A user marks, switches or clears a verdict, and it survives reload.
- No client, not even the row owner, can update any `summaries` column other than `worth_watching`, and no account can touch another's mark.
- Unit + integration suites green, including the new roster invariant.
