# Delete Summary — Plan Brief

> Full plan: `context/changes/delete-summary/plan.md`

## What & Why

Let a signed-in user permanently delete one of their own saved summaries from the list at `/summaries`.
This closes roadmap slice **S-03** and **PRD FR-007** (nice-to-have), completing CRUD on `summaries` —
today a summary can be created and read but never removed, so a mis-pasted URL or a summary the user is
done with stays in the list forever.

## Starting Point

The database layer is already in place and needs no change: `authenticated` holds exactly
`SELECT, DELETE` on `public.summaries` behind the owner-scoped policy `summaries_delete_authenticated`
(`20260613145120:59-61`, narrowed by `20260731130000:27-39`), the committed roster in
`authorization-invariants.int.test.ts:91` records it, and `cross-account-policy.int.test.ts:233-263`
already proves one account cannot delete another's row. `GET /api/summaries` states in its own header
that it was *"deliberately shaped so S-03 (delete) can reuse it unchanged."* What is missing is a server
endpoint the browser can reach and a control on the card.

## Desired End State

Each saved summary card carries a delete control. Activating it flips that card's control into an inline
"Delete? / Cancel"; confirming removes the card immediately and the row is gone. The credit balance is
unchanged, a reload does not bring the summary back, and another account cannot delete it.

## Key Decisions Made

| Decision                     | Choice                                                             | Why (1 sentence)                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credits on delete            | **Never returned** — and no refund logic exists to remove          | `persist_summary` settles the reservation in the same transaction that writes the summary, so the sweep can never see delivered-then-deleted work (`20260723120000:14-22`).    |
| Confirmation UX              | Inline two-step on the card (trash → "Delete? / Cancel")           | Keeps the destructive act anchored to the exact summary; a modal per row loses which card is which.                                                                             |
| Endpoint shape               | `DELETE /api/summaries/[id]`                                       | REST-correct and sits beside the `GET /api/summaries` the read already uses; first dynamic API route in the repo.                                                              |
| Zero rows deleted            | Server answers `404`; **the client treats it as success**          | Under RLS "not yours" and "already gone" are the same observation, and reverting the card would resurrect a summary that genuinely no longer exists.                            |
| List refresh                 | Optimistic removal, revert only on 5xx / 401 / network             | The server is the only writer, so a 200 means the row is gone — no reconciliation round-trip needed.                                                                            |
| Concurrent generation re-read | A **deleted-id set** filters every incoming list                    | `refreshSummaries` replaces `summaries` wholesale, so ordering alone cannot stop a re-read from resurrecting a deleted card.                                                    |
| Orphan `videos` row          | Left in place                                                      | Invisible to the user, holds cached metadata a re-generation reuses for free, and `videos.user_id`'s cascade already covers GDPR erasure at the account level.                  |
| Failed delete + `unlisted`   | Inline error on the card; clear `unlisted` if it names that summary | The note would otherwise claim a summary is "saved but missing from the list" after the user deliberately removed it.                                                          |
| Test depth                   | Unit on the service + one `*.db.int.test.ts`                       | Makes "deletion never returns credits" an executable invariant against a real database rather than a code comment.                                                              |

## Scope

**In scope:**

- `deleteSummary` service (`src/lib/services/summary-delete.ts`) — RLS-scoped, no admin client
- `DELETE /api/summaries/[id].ts` with UUID validation and the 404-on-zero-rows contract
- A query-builder seam in `__fixtures__/supabase-stub.ts` (today it exposes only `rpc`)
- Unit tests + a DB-layer integration test (row gone, **balance unchanged**, cross-account 404, repeat 404)
- Inline delete control on `SummaryCard`, delete lifecycle in `SummariesSurface`, Polish copy

**Out of scope:**

- Any migration — the grant and policy already exist
- Soft delete, undo, or trash/restore (`authenticated` holds no `INSERT` on `summaries`)
- Deleting the `videos` row, bulk delete, changes to `generate.ts` or any RPC
- E2E tests — `test-plan.md` §6.4 is still TBD and there is no harness

## Architecture / Approach

```
SummaryCard (trash → "Delete?")
      │ onDelete(id)
      ▼
SummariesSurface ── optimistic remove + deletedIds set ──► filters every incoming list
      │                                                     (initial prop + refreshSummaries)
      ▼ DELETE /api/summaries/<id>
[id].ts ── zod uuid ──► deleteSummary(anon SSR client) ──► PostgREST DELETE … .select("id")
                                                              │
                                                      RLS policy = the trust boundary
                                                      (no user_id predicate in the query)
```

The service takes an injected RLS-scoped client and passes **no** `user_id` filter — adding one would
mask a broadened policy from the tests, which is exactly the failure mode `test-plan.md` §6.3 rule 3
warns about. `.select("id")` is what makes the affected-row count observable at all.

## Phases at a Glance

| Phase                                 | What it delivers                                                        | Key risk                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1. Server — service + endpoint        | `summary-delete.ts`, `[id].ts`, the fixture seam, unit tests            | The fixture stub has no query-builder seam today, so the unit layer has to be extended before it can test anything |
| 2. Integration — the invariants       | `delete.db.int.test.ts`: row gone, **balance unchanged**, cross-account 404, repeat 404 | A balance assertion that cannot fail is not evidence — it must be deliberately broken once to prove it |
| 3. UI — card control + list state     | Inline two-step delete, optimistic removal, deleted-id set, Polish copy | Two writers to the same list; a post-generation re-read must not resurrect a deleted card (risk #6)     |

**Prerequisites:** a `delete-summary` branch off `master` (`lessons.md` — not yet created); Docker +
`npx supabase start` for Phase 2; the local stack's five env keys.
**Estimated effort:** ~1–2 sessions across 3 phases. No paid vendor credit is spent at any point.

## Open Risks & Assumptions

- **Assumption, verified in source not assumed:** deletion cannot rewrite a billing outcome, because
  `persist_summary` settles atomically. Phase 2 pins it so a future change cannot break it silently.
- A repeat POST on the *same* idempotency key after deleting that key's summary makes `begin_generation`
  return `'unavailable'` → a clean `409 "Start a new generation."` (`generate.ts:351-352`). No charge, no
  crash; accepted as-is.
- Orphan `videos` rows accumulate, visible only in the database. Judged harmless at MVP scale; noted
  rather than fixed.
- The deleted-id set lives for the page's lifetime. Bounded by deletions per session, so unbounded growth
  is not a real concern.

## Success Criteria (Summary)

- A user can remove a summary from their list, and it stays removed across a reload.
- Their credit balance is provably identical before and after — asserted by an integration test, not a comment.
- No other account can delete their summaries, and their rows survive an attempt.
