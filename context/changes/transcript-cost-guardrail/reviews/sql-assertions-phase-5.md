# Phase 5 — SQL assertion record (the reservation ledger)

**Date**: 2026-08-04 · **Environment**: local Supabase stack (`supabase_db_10x-media`, Postgres 17)
**Migration**: `supabase/migrations/20260731150000_supadata_budget.sql`
**Nothing calls these RPCs.** Phase 5 is a migration and nothing else; Phase 6 is the wiring.

Phase 5 is *entirely* the automated tier by design — the property the lever rests on (two concurrent
reserves against a one-generation budget yield one reservation and one refusal) is a database property
and is provable in two psql sessions. Every row below was asserted directly in SQL rather than reasoned
about.

## Filename adaptation

The plan names this migration `20260731130000_supadata_budget.sql`. That timestamp was already taken by
`20260731130000_summaries_single_writer.sql` (a Phase 4 follow-up that landed first), and `140000` by
`20260731140000_metadata_via_fetch_failed.sql`. Migration order is filename order, so it took the next
free slot: **`20260731150000`**. Nothing else about the phase changed. Phase 6's success criterion 6.3
greps this path — it must use the actual name.

## One decision the plan left open

**The refresh claim needs a TTL and the plan does not give one.** `reserve_supadata_credits` takes four
arguments, all pinned by the plan and all mirrored by Phase 6's service, so the TTL could not become a
fifth without changing a signature the plan fixes. It is therefore a named constant inside the function
(`c_refresh_claim_ttl_seconds := 30`) with its derivation attached:

- It must **outlive one refresh round trip** — `BUDGET_READ_TIMEOUT_MS` (2 s) + the 1.2 s rate-limit
  spacing + the second reserve pass, roughly 4 s worst case. 30 s clears that by ~7×.
- It must be **far shorter than the reading TTL** (900 s). A claim whose refresh failed is left to
  expire rather than cleared (the plan's rule), so the TTL is exactly how long a dead claimant keeps the
  fleet from re-reading `/v1/me`. Tying it to the reading TTL would mean one failed refresh costs 15
  minutes of untracked traffic; 30 s means the next request retries.

## Automated assertions

| Row | Assertion | Result |
| --- | --- | --- |
| 5.1 | `npx supabase migration up` applies cleanly | **pass** — `20260731150000_supadata_budget.sql` applied |
| 5.2 | `supadata_budget` cannot hold a second row | **pass** — `insert (singleton) values (true)` → duplicate key on `supadata_budget_pkey`; `values (false)` → `supadata_budget_singleton_check` |
| 5.3 | Both tables and all three RPCs are `service_role`-only | **pass** — `has_table_privilege` false for `anon`/`authenticated` on both tables, RLS enabled, **0 policies**; `has_function_privilege(execute)` false for `anon`/`authenticated` and true for `service_role` on all three functions |
| 5.4 | **Concurrent reserves do not overdraw** | **pass** — see below |
| 5.5 | A stale unsettled reservation is swept, its credit returns to the pool | **pass** — a 20-minute-old unsettled row (`p_stale_seconds = 600`) was deleted by the sweep; `outstanding = 0`, outcome `reserved`, 0 rows left |
| 5.6 | A settled reservation with `actual_credits = null` counts at its **maximum** | **pass** — a settled row `credits = 2, actual_credits = null` produced `outstanding = 2`, not 0 → `refused` |
| 5.7 | A settled reservation with a real `actual_credits` counts at **that** figure | **pass** — the same row with `actual_credits = 1` produced `outstanding = 1`. Re-run against `used = 95`: identical rows, outcome flips to `reserved` — the real figure lets a call through where the reserved maximum would not |
| 5.8 | The seeded row exists and reads uninitialized | **pass** — exactly 1 row, `read_at is null`, `max_credits is null`; `select … where singleton for update` returned it |
| 5.9 | A clean database initializes on the first request | **pass** — see below |
| 5.10 | A refresh does not delete the work it is about to authorize | **pass** — see below |
| 5.11 | Exactly one of two concurrent stale/uninitialized readers gets `refresh_required` | **pass** — see below |
| 5.12 | The reconciliation query branches on `outcome` | **pass** — see below |

### 5.4 — concurrent reserves, two sessions, one seat

Budget seeded `max = 100, used = 96, read_at = now()`, so with `p_stop_reserve = 3` exactly **one**
1-credit call fits (`remaining 4 − 1 = 3 ≥ 3`; a second would leave `3 − 1 = 2 < 3`).

```
session A  14:30:21.970  BEGIN; reserve(1,3,900,600) -> reserved 6074b851-…   [holds the row lock]
session B  14:30:26.518  reserve(1,3,900,600)         -> BLOCKS
session A  14:30:27.97   COMMIT
session B  14:30:27.991  -> refused
```

B waited **1.47 s** on the `supadata_budget` row lock and was released only by A's commit — the blocking
interval is what makes this a serialization proof rather than a coincidence. One id, one refusal, never
two ids. A single reservation row existed afterwards.

### 5.9 — a clean database becomes active rather than failing open forever

Against the seeded-but-null row: the first `reserve_supadata_credits` returned **`refresh_required`**
with a null `reservation_id`, wrote **zero** reservation rows, and stamped `refresh_claimed_at`. After
`save_supadata_budget(100, 96, now())` the next call returned **`reserved`** (`max 100, used 96,
outstanding 0`), and the one after that **`refused`** (`outstanding 1`). The breaker demonstrably
becomes active; an uninitialized deployment is not indistinguishable from a permanently disabled one.

### 5.10 — the retention rule, asserted directly

Three rows, then `save_supadata_budget(100, 50, now() − 1 minute)`:

| Row | State | After the refresh |
| --- | --- | --- |
| `1111…` | unsettled | **survives** |
| `2222…` | settled at `now()` — *after* the reading | **survives** |
| `3333…` | settled 5 minutes ago — *before* the reading | **deleted** |

This is F1's failure mode asserted in SQL: the snapshot cannot contain work that had not finished when
it was taken, so only `settled_at <= p_read_taken_at` is prunable.

### 5.11 — exactly one refresher, both variants

Run twice, session B always starting ~1 s after A and blocking on A's lock until it committed:

- **Uninitialized** (`read_at is null`): A → `refresh_required`; B → **`uninitialized`** (no reading to
  decide against, caller fails open explicitly). B blocked 1.39 s.
- **Stale** (`read_at = now() − 1 hour`): A → `refresh_required`; B → **`reserved`**, i.e. a real
  decision against the stale reading, since the reservations written since `read_at` bound its drift.
  B blocked 1.23 s.

Neither run produced two `refresh_required`.

### 5.12 — the reconciliation query (hand-inserted rows, rolled back)

Three rows inserted into `supadata_calls` inside a transaction and rolled back:

| `outcome` | `billable_credits` | per-outcome formula | naive `sum(billable_credits)` |
| --- | --- | --- | --- |
| `unavailable` | null (`http_status 206`) | **1** | 0 ← the under-count |
| `error` | null | 0 | 0 |
| `ok` | 1 | 1 | 1 |

The flat sum reads a billed 206 as free. The formula is pinned in the migration's part 7 comment so
Phase 7 does not have to re-derive it during a live credit pass.

### settle lifecycle (supporting `settleBudget`'s Phase 6 contract)

`settle_supadata_reservation` returned **t** on the first call (row settled, `settled_at` stamped,
`actual_credits = 1`), **f** on an immediate repeat (idempotent — it does not move `settled_at` forward
and un-prune the row), and **f** for an unknown id, which is how Phase 6 will detect a reservation the
sweep already took.

## Manual rows — deliberately pending

| Row | Status |
| --- | --- |
| 5.13 `npm run lint` / `npm run build` unchanged from Phase 4 | **Both run and clean.** No TypeScript changed in this phase, so this confirms the migration did not break generated types — not that the phase works. Awaiting user confirmation before the box is ticked. |
| 5.14 reserve → settle → refresh leaves `supadata_reservations` empty | **Walked once in SQL**: reserve → `settle(…, 1)` → `save_supadata_budget(100, 51, now())` → 0 rows. Awaiting user confirmation. |

## State left behind

`supadata_budget` was restored to its seeded, **uninitialized** shape (`max_credits`, `used_credits`,
`read_at`, `refresh_claimed_at` all null) and `supadata_reservations` is empty. No pre-existing data was
touched: the only writes outside these two new tables were three `supadata_calls` rows inside a
transaction that was rolled back.

---

# Addendum — impl-review triage (2026-08-05)

**Migration revised in place** (it is branch-local and was never deployed) for findings F1, F2, F4 and
F6 of `impl-review-phase-5.md`. Re-applied to the same local stack with `psql` — `supabase migration up`
alone cannot re-run an already-recorded migration, so the file carries `drop function if exists` and
`add column if not exists` / `drop constraint if exists` guards that make it re-appliable. No error on
re-application, and no existing row violated any new constraint.

## Contract changes

| Before | After |
| --- | --- |
| `reserve_supadata_credits` returns 6 columns | returns 7 — `refresh_claim_id uuid`, non-null only on `refresh_required` |
| `save_supadata_budget(int, int, timestamptz) returns void` | `save_supadata_budget(int, int, uuid) returns boolean` — takes the claim, answers whether it still owned it |
| `read_at` = the Worker's pre-call clock | `read_at` = `refresh_claimed_at`, PostgreSQL's clock at claim grant |

This supersedes the earlier walk of manual row 5.14, which used the old three-timestamp signature; the
same reserve → settle → refresh → empty-table path is re-walked below under the new one.

## Rows asserted

### F1 — the claim fence (two-claimant interleaving, forced by ageing the claim past its 30 s TTL)

| Row | Assertion | Result |
| --- | --- | --- |
| 5.15 | a successor takes the expired claim over and mints a **different** id | **t** |
| 5.16 | the current owner's `save_supadata_budget` returns **true** | **t** |
| 5.17 | that save pruned the settled row and kept the in-flight one | **t** |
| 5.18 | that save stored its reading | **t** |
| 5.19 | the stalled predecessor's save returns **false** | **f** (as required) |
| 5.20 | the predecessor did **not** overwrite the successor's anchor | **t** |
| 5.21 | the predecessor did **not** move `read_at` backwards | **t** |
| 5.22 | the predecessor pruned nothing | **t** |
| 5.24 | a `reserved` outcome returns **no** claim id | **t** |
| 5.25 | an unknown claim id returns **false** | **f** (as required) |

This is the interleaving the finding's blind spot asked to see reproduced before triage closed.

### F2 — the boundary comes from one clock

| Row | Assertion | Result |
| --- | --- | --- |
| 5.23 | stored `read_at` is a PostgreSQL timestamp in the recent past, never the future | **t** |

No Worker timestamp reaches the comparison any more: `save_supadata_budget` reads `refresh_claimed_at`
off the row it locks, and `settled_at` is generated by the same clock.

### F4 — invariants (every row below MUST be rejected)

| Row | Rejected input | Result |
| --- | --- | --- |
| 5.26 | reservation with `credits = 0` | rejected |
| 5.27 | negative `actual_credits` | rejected |
| 5.28 | `settled = false` carrying a `settled_at` | rejected |
| 5.29 | `settled = true` without a `settled_at` | rejected |
| 5.30 | negative `used_credits` | rejected |
| 5.31 | partial reading (`read_at` set, `max_credits` null) | rejected |
| 5.32 | `refresh_claimed_at` without a `refresh_claim_id` | rejected |
| 5.33 | `reserve_supadata_credits` with a null stop reserve | raised |
| 5.34 | `reserve_supadata_credits` with a zero stale window | raised |
| 5.35 | `reserve_supadata_credits` with a null reading max age | raised |
| 5.36 | `settle_supadata_reservation` with a negative amount | raised |
| 5.37 | `save_supadata_budget` with negative max credits | raised |

The happy path still returns `reserved` after all twelve.

### F6 — provably-free settlements retire without a refresh

| Row | Assertion | Result |
| --- | --- | --- |
| 5.38 | a settlement known to have billed **0** is dropped by the sweep, no reading involved | **t** |
| 5.39 | a settlement with a **null** (unknown) figure is **kept** and still charged at its maximum | **t** |
| 5.40 | a settlement with a nonzero figure is kept | **t** |
| 5.41 | `outstanding` is identical with and without the dropped row (2 unknown-at-max + 1 real + 2 in flight = 5) | **t** |

5.41 is the point of the change: it is behaviour-neutral by construction, because
`coalesce(actual_credits, credits)` is 0 for such a row either way. 5.39 is the guard against
over-reach — `= 0` is not `is not distinct from 0`, and forgiving an unknown charge would be a
correctness regression dressed as cleanup.

## State left behind

Re-restored to the seeded, **uninitialized** shape: `supadata_reservations` empty, and `max_credits`,
`used_credits`, `read_at`, `refresh_claimed_at`, `refresh_claim_id` all null. `npm run lint` and
`npm run build` both clean after the TypeScript changes in `supadata-budget.ts` and `generate.ts`.

---

# Manual rows 5.13 / 5.14 — closed 2026-08-05

Both were held open through the impl review rather than ticked on the pre-triage evidence, and both
were re-run against the revised migration.

## 5.13 — lint and build

`npm run lint` and `npm run build` both exit 0. The row's parenthetical "(no TypeScript in this
phase)" no longer holds: F1/F2 moved the RPC contract, and the contract has a TypeScript side, so
`supadata-budget.ts` and `generate.ts` changed under Phase 5 after all. That makes the row a stronger
check than it was written to be — it now confirms the new signatures compile rather than confirming a
migration left the generated types alone. The `@astrojs/sitemap` warning about a missing `site` option
is pre-existing and unrelated.

## 5.14 — reserve → settle → refresh, walked by hand

Re-walked under the fenced `save_supadata_budget(int, int, uuid)`; the earlier record used the
three-timestamp signature, which no longer exists. Started from the seeded, uninitialized row.

| Step | Action | Assertion | Result |
| --- | --- | --- | --- |
| S1 | `reserve(1, 3, 900, 600)` on an uninitialized row | `refresh_required`, **no** reservation written, a claim issued | **t** |
| S2 | `save(100, 10, claim1)` | returns **true**; reading stored, claim released | **t** |
| S3 | `reserve(1, 3, 900, 600)` against the real reading | `reserved`; exactly one **unsettled** row | **t** |
| S4 | `settle(res, 1)` | returns **true**; the row is **not** deleted — spend stays visible until a reading supersedes it | **t** |
| S5 | age `read_at` 20 min (past the 900 s TTL), then `reserve` | `refresh_required` with a **new** claim ≠ `claim1`; the settled row survives the claim | **t** |
| S6 | `save(100, 11, claim2)` | returns **true** | **t** |
| S7 | — | **`supadata_reservations` is EMPTY**, and the anchor carries the spend instead (`used_credits = 11`) | **t** |

The settlement at S4 was deliberately given a **nonzero** `actual_credits`, so F6's known-zero sweep
provably cannot be what emptied the table at S7 — the refresh prune is, which is the property this row
exists to assert. S5 doubles as a check that a refresh claim does not prune on its own: only the save
does.

## State left behind

Restored to the seeded, uninitialized shape — `supadata_reservations` empty, all five
`supadata_budget` figures null. **Phase 5 is now fully verified**; Phase 6's manual rows 6.8–6.17
remain untouched and need a running app with a temporarily overridden `BUDGET_STOP_RESERVE`.
