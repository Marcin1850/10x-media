# Delete Summary — Plan Brief

> Full plan: `context/changes/delete-summary/plan.md`
> Test oracle: `context/changes/delete-summary/research.md` — read before writing any test.

## What & Why

Let a signed-in user permanently delete one of their own saved summaries from the list at `/summaries`.
This closes roadmap slice **S-03** and **PRD FR-007** (nice-to-have), completing CRUD on `summaries` —
today a summary can be created and read but never removed, so a mis-pasted URL or a summary the user is
done with stays in the list forever.

## Starting Point

The database layer is already in place and needs no change: `authenticated` holds exactly
`SELECT, DELETE` on `public.summaries` behind the owner-scoped policy `summaries_delete_authenticated`
(`20260613145120:61-63`, narrowed by `20260731130000:27-39`), the committed roster in
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
| Zero rows deleted            | Server answers `404`; **the client treats it as success**          | Under RLS "not yours" and "already gone" are the same observation, and reverting the card would resurrect a summary that genuinely no longer exists. **No prior art in the repo** — this is a decision, not a convention being followed. |
| List refresh                 | Optimistic removal; **any answered status other than `200`/`404` reverts**, and a thrown fetch is reconciled | An answered non-2xx (5xx, `401`, `400`, `503`) proves the row survived, so the card comes back. A **thrown** fetch is not an answer — the `DELETE` may have committed before the response was lost — so it is settled by one read of `GET /api/summaries` before the card is restored (impl-review F1). |
| Concurrent generation re-read | A **deleted-id `useRef` set** filters every incoming list **except the first-render prop** | `refreshSummaries` replaces `summaries` wholesale, so ordering alone cannot stop a re-read resurrecting a deleted card — and a `useState` copy captured before an `await` can be older than the deletion itself, so the ref is authoritative. `initialSummaries` is the one safe exception: it lands before any deletion can exist, and `react-hooks/refs` forbids reading the ref during render. |
| Orphan `videos` row          | Left in place                                                      | Invisible to the user, holds cached metadata a re-generation reuses for free, and `videos.user_id`'s cascade already covers GDPR erasure at the account level.                  |
| Failed delete + `unlisted`   | Inline error on the card; clear `unlisted` if it names that summary | The note would otherwise claim a summary is "saved but missing from the list" after the user deliberately removed it.                                                          |
| Test depth                   | Unit on the service + **two** integration files                    | `delete.db.int.test.ts` makes "deletion never returns credits" executable against a real database; hermetic `delete.int.test.ts` pins the endpoint's six exits, three of which (`400`/`503`/`500`) a healthy real stack cannot provoke. |
| `begin_generation` comment   | **Corrected by a comment-only migration** on this branch             | Its "only an operator settle produces this" claim was already false (`charge_failed_transcript`, 20260731110000) and delete makes a third producer; a wrong diagnostic sends an operator hunting a manual action that never happened. |
| Masked 500 logging           | **Logs**, mirroring `index.ts:40`                                    | `account/delete.ts` is the codebase's only non-logging endpoint and its stated reason was already false; this exit has no other diagnostic surface (research.md §8). |
| Server-side confirmation     | **None** — the endpoint takes no confirmation field                 | `account/delete.ts`'s re-entered email is independent proof guarding every row a user owns; the only value a card could echo is the id it just sent, so it would be ceremony, and RLS is the real boundary. |

## Scope

**In scope:**

- `20260906170000_begin_generation_comment.sql` — corrects a wrong diagnostic claim in
  `begin_generation`'s body; byte-identical otherwise
- `deleteSummary` service (`src/lib/services/summary-delete.ts`) — RLS-scoped, no admin client
- `DELETE /api/summaries/[id].ts` with UUID validation and the 404-on-zero-rows contract
- A query-builder seam in `__fixtures__/supabase-stub.ts` (today it exposes only `rpc`)
- Unit tests + two integration files: hermetic `delete.int.test.ts` (401/400/503/404/masked 500/200) and
  `delete.db.int.test.ts` (row gone, **balance unchanged**, cross-account 404, repeat 404). The unit
  test is **not** authorization coverage — a stub stays green against a broadened policy (risk #4:
  *"the service is not the trust boundary"*); only the DB test proves isolation.
- Inline delete control on `SummaryCard`, delete lifecycle in `SummariesSurface`, Polish copy

**Out of scope:**

- Any schema or policy migration — the grant and policy already exist. (One **comment-only**
  migration does ship: `20260906170000_begin_generation_comment.sql`, zero behaviour change.)
- Soft delete, undo, or trash/restore (`authenticated` holds no `INSERT` on `summaries`)
- Deleting the `videos` row, bulk delete, changes to `generate.ts` or any RPC
- E2E tests — `test-plan.md` §6.4 is still TBD and there is no harness

## Architecture / Approach

```
SummaryCard (trash → "Delete?")
      │ onDelete(id)
      ▼
SummariesSurface ── optimistic remove + deletedIds ref ──► filters every incoming list
      │                                                    (read after every await, before setSummaries)
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
| 1. Server — migration + service + endpoint | The comment-only migration, `summary-delete.ts`, `[id].ts`, the fixture seam, unit tests | The fixture stub has no query-builder seam today, so the unit layer has to be extended before it can test anything. The migration must be generated by extraction + diff, never retyped — it replaces a paid-path `SECURITY DEFINER` function |
| 2. Integration — the invariants       | `delete.int.test.ts` (hermetic, six exits) + `delete.db.int.test.ts`: row gone, **balance unchanged**, cross-account 404, repeat 404 | A balance assertion that cannot fail is not evidence — it must be deliberately broken once to prove it. `generation-harness.ts` is **not** reusable (no `params`, generate-bound loader — research.md §4), so the hermetic file needs its own loader |
| 3. UI — card control + list state     | Inline two-step delete, optimistic removal, deleted-id set, Polish copy | Two writers to the same list; a post-generation re-read must not resurrect a deleted card (risk #6)     |

**Prerequisites:** the `delete-summary` branch — **already created and checked out**, with the plan
committed on it (`6e9740f`); Docker + `npx supabase start` for Phase 2; the local stack's five env keys.
**Estimated effort:** ~1–2 sessions across 3 phases. No paid vendor credit is spent at any point.
**Deploy:** `npx supabase db push` then `npx wrangler deploy` — no longer a single Worker upload.

## Test Oracle (the short form — full list in `research.md`)

| Property | Comes from | Never from |
| --- | --- | --- |
| Balance unchanged by a delete | `README.md:259` (refills manual-only) + `20260723120000:13-15,21-22` | recomputing the cost the way the code does |
| One account cannot delete another's | `prd.md:36-37` guardrail + the policy at `20260613145120:61-63` | the `deleteSummary` unit test, which is not the trust boundary |
| The endpoint's status table | this plan's Phase 1 — FR-007 (`prd.md:67`) is one line and settles nothing about shape | prior art; there is none for 404-on-zero-rows |

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
- The deleted-id ref must be mutated on rollback **before** the row is restored into `summaries`, or the
  restore is filtered straight back out. Ref discipline is the cost of choosing a ref over a reducer.
- The `useRef` race is not directly unit-testable without extracting a state-transition seam; item 3.12
  covers it manually. Accepted at this slice's size.

## Success Criteria (Summary)

- A user can remove a summary from their list, and it stays removed across a reload.
- Their credit balance is provably identical before and after — asserted by an integration test, not a comment.
- No other account can delete their summaries, and their rows survive an attempt.
