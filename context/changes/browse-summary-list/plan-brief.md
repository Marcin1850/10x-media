# Browse Summary List (S-02) — Plan Brief

> Full plan: `context/changes/browse-summary-list/plan.md`

## What & Why

The app can generate summaries but has nowhere to read them. This slice builds that surface — FR-006, the last must-have functional requirement without an implementation. It is also the mechanism by which the PRD's only success criterion gets measured: the user judges "75% good enough" by browsing what they've accumulated.

## Starting Point

Every field the list needs is already persisted and none of it is rendered. S-01 writes `summaries`, S-08 persists video metadata onto `videos`, and both tables kept `select` for `authenticated` behind owner-scoped RLS when the single-writer migrations stripped their write paths. `/dashboard` today is a single centered card holding the generate form; there is no navigation and no read surface anywhere in the app. S-08 shipped zero UI deliberately, leaving all rendering — including the null-metadata fallback — to this slice.

## Desired End State

`/dashboard` becomes the summary list: every summary the user has generated, newest first, as cards carrying the video's thumbnail, title, channel, duration and upload date plus a character badge. Clicking expands the full summary in place; a character filter narrows the list. Generation moves into a dismissable dialog, and a generation in flight appears as a live card at the top of the list that resolves into a real card when it commits.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Placement | `/dashboard` becomes the list | The list is the product's main surface per the PRD, so it gets top billing rather than a secondary route. |
| List unit | Flat — one card per summary | `persist_summary` appends unconditionally, so a video can hold several summaries; every credit spent stays visible. |
| Disclosure | Preview + inline expand | Matches the PRD's reading model — opening sentences serve the watch/skip call, the body serves the reader skipping the video. |
| Generation | Freely dismissable dialog | The user is never trapped watching a slow generation. |
| Generation state | Lifted into a `useGenerateSummary` hook on a parent island | An unmounted island cannot finish its own paid request, so the fetch lifecycle must outlive the dialog. |
| New summary reaches the list | Re-read `GET /api/summaries` on success | The generate response carries no metadata, so re-reading is the only way the new card matches the post-reload card. |
| In-progress visibility | Pending card at the top of the list | User request; it also answers "where did my summary go" when the dialog is closed. |
| Pending state on reload | Dropped, accepted | The server lease and idempotency ledger already prevent a double charge, so the cost is a missing spinner, not a lost credit. |
| Long-video 409 with dialog closed | Card reopens the dialog | Keeps consent copy and pricing in one place instead of duplicating it onto the card. |
| Card fields | Thumbnail, title, channel, duration, upload date, character badge | Telemetry excluded — `cost_usd` is provider spend, not the credit the user paid, and invites misreading. |
| Volume | Newest first, no paging, client-side character filter | Credits cap the corpus at tens of rows; the filter handles the duplication the flat list creates. |
| Deletion | Out — stays S-03 | Keeps this surface read-only and the roadmap's parallel-work assumption intact. |

## Scope

**In scope:** RLS-scoped read service · `GET /api/summaries` · summary card with thumbnail fallback and metadata · character filter and inline expand · extraction of the hardened Markdown renderer · generation moved into a dialog with its lifecycle lifted into a hook · pending/error/needs-confirmation cards.

**Out of scope:** deletion (S-03) · design system (S-06) · any migration, schema change or backfill · telemetry on the card · pagination · search or sorting · per-summary deep links · any change to the generation endpoint, credit ledger or paid path.

## Architecture / Approach

```
dashboard.astro  ──server reads──▶  listSummaries()  ──RLS──▶  summaries ⋈ videos
       │
       └─▶ <DashboardSummaries client:load>          ← owns useGenerateSummary()
              ├─ "New summary" ▶ Dialog ▶ GenerateSummaryForm   (presentational)
              └─ SummaryList
                   ├─ PendingSummaryCard   ← hook state
                   └─ SummaryCard[]        ← re-read via GET /api/summaries on success
```

The page server-seeds the island, following the pattern `initialCredits` already uses. The hook sits above the dialog so a dismissed dialog cannot orphan an in-flight paid request.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Read path | `listSummaries` + `GET /api/summaries`, RLS-scoped | Embed typing — `AppDatabase` declares `Relationships: []`, so the join must be narrowed at the boundary |
| 2. List UI | Cards, filter, expand, thumbnail fallback; form untouched | Thumbnail `onError` looping; a second Markdown renderer reintroducing `img`/`a` |
| 3. Lift generation state | Hook + dialog; **no behavior change** | The whole slice's regression risk — idempotency key lifetime and the apply-before-staleness-check ordering must survive verbatim |
| 4. In-progress cards | Pending/error/confirm cards + re-read on success | A re-read failure must never discard a paid result already on screen |

**Prerequisites:** none outstanding — S-01 shipped, S-08 is deployed and verified. Local Supabase stack running with its 16 seeded summaries (which already contain every edge case: null metadata, duplicate videos across characters, `webp` and signed-param thumbnails).

**Estimated effort:** ~3–4 sessions. Phases 1–2 are additive and independently shippable; after Phase 2 the FR-006 requirement is already met.

## Open Risks & Assumptions

- **Phase 3 touches working paid-path client code for no new user-visible benefit.** It is a pure refactor whose only justification is enabling Phase 4. If it proves hairier than expected, stopping after Phase 2 leaves a complete, shippable FR-006.
- The double thumbnail fallback (null **and** 404) can only be verified in a real browser — a build passing says nothing about it.
- Pending cards are client-session-only by design; a reload mid-generation loses the spinner. Verified safe against double-charging, but it will look like a bug to anyone who doesn't know.
- The repo has no automated test suite, so every behavioral criterion here is a manual step.

## Success Criteria (Summary)

- The user opens `/dashboard` and sees every summary they've generated, with enough video context to tell them apart, and can read any of them without leaving the page.
- Summaries generated for the same video under both characters are both visible and distinguishable.
- Generation still works exactly as it did — including the long-video confirmation and the ambiguous-retry protection — and a generation started from the dialog lands in the list whether or not the dialog stayed open.
