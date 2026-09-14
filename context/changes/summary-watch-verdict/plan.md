# Summary Watch Verdict Implementation Plan

## Overview

Let the user record their watch/skip decision on each saved summary: a tri-state `worth_watching` mark (`null` unmarked · `true` worth watching · `false` not worth watching), set through a clearable single-select toggle on the summary card and persisted so it survives a reload (roadmap S-14, Linear MAR-25).

It is also the app's first user-initiated **Update** on a persisted summary. The care point is the privilege shape: `authenticated` may update `worth_watching` and nothing else, so `persist_summary` stays the single writer of paid content, reservation links and telemetry.

## Current State Analysis

- `summaries` is single-writer: `20260731130000_summaries_single_writer.sql:356-368` revoked everything from `anon, authenticated`, re-granted `select, delete` only, and **dropped** `summaries_update_authenticated`. So no update policy exists today, and the roadmap's "confirm it is still in place" resolves to *re-create it*.
- `persist_summary` (latest definition `20260814140000_channel_id_correction.sql`) always **inserts** a new `summaries` row. There is no upsert, so regenerating a video never touches an existing row's mark, and a new summary starts `null` with no extra code.
- Read path: `listSummaries` (`src/lib/services/summary-list.ts:278-327`) selects an explicit column list into `SummaryListItem` (`src/types.ts:96-111`). Both the dashboard SSR render and `GET /api/summaries` go through it.
- Delete precedent (S-03): `src/pages/api/summaries/[id].ts` (DELETE, exit order and 404 rationale), `src/lib/services/summary-delete.ts` + `.test.ts`, stub helpers `stubDeleting`/`stubDeleteFailing`/`stubDeleteRejecting` (`src/lib/services/__fixtures__/supabase-stub.ts:99-111`), route tests `delete.int.test.ts` (stub layer) and `delete.db.int.test.ts` (real stack), optimistic handler `handleDelete` in `src/components/summaries/DashboardSummaries.tsx:249-289`.
- Authorization roster (`src/test/authorization-invariants.int.test.ts`): `CLIENT_READABLE.summaries = ["DELETE","SELECT"]` (`:91`), with privileges read by `has_table_privilege` (`:172`). **A column-level grant does not show up there**, so invariant 4 stays green on its own. Invariant 6 (`:326`) derives the expected policies from `CLIENT_READABLE` table verbs, so a new `summaries:UPDATE` policy with no table-level UPDATE verb **fails invariant 6 for the wrong reason**. The roster needs a way to express a column-scoped verb.
- UI: no `toggle-group` in `src/components/ui/`; `radix-ui` umbrella package is already a dependency.

## Desired End State

- `summaries.worth_watching boolean null` exists. `authenticated` holds `UPDATE` on that column only, gated by an owner-scoped `for update` policy (`using` and `with check` both `auth.uid() = user_id`).
- `PATCH /api/summaries/[id]` with body `{ "worth_watching": true | false | null }` sets the mark on the caller's own summary. Exits in order: `401` · `400` (bad id or body) · `503` · `404` (zero rows) · `500` (masked) · `200 { ok: true, worthWatching }`.
- Every summary card shows two always-visible options, "Warto obejrzeć" (ThumbsUp) and "Nie warto" (ThumbsDown). Choosing one deselects the other, clicking the active one clears it, and the choice survives reload.
- While a card's request is in flight its toggle is disabled. On 5xx or network failure the previous mark is restored with an inline error. On 404 the card is removed from the list.
- Verification: `npm test`, `npm run test:integration`, both typechecks, lint, plus the manual steps below.

### Key Discoveries:

- Update policy was dropped, not narrowed: `20260731130000_summaries_single_writer.sql:368`.
- Roster reads table privileges only: `authorization-invariants.int.test.ts:172`. Invariant 6 couples policies to table verbs (`:326-350`).
- `persist_summary` is insert-only for `summaries` (`20260814140000_channel_id_correction.sql`, `insert into public.summaries` with no `on conflict`).
- Zero-row mutation → `404` is a documented decision for this route family (`[id].ts:60-64`); the client treats 404 as "row is gone".
- PostgREST mutation needs `.select(...)` for the affected rows to be observable (`summary-delete.ts:123-128`).

## What We're NOT Doing

- **No verdict facet in the list filter** (worth / not worth / unmarked). Deferred per user decision; possible follow-up.
- **No e2e spec.** The e2e suite is scoped to money flows (`test-plan.md` §6.4). Reload persistence and the in-flight lock are verified manually.
- **Not a quality signal.** The mark is not wired into T-5 / Open Roadmap Question 1; "not worth watching" judges the video, not the summary.
- No reconcile-against-list on network failure (unlike delete). Setting a mark is idempotent and free, so rollback + retry converges.
- No click queue / latest-wins. Clicks during a save are ignored via the lock.
- No change to `persist_summary`, credits, the paid path, the Supadata budget, or `videos`.
- No `updated_at`/audit column for the mark.

## Implementation Approach

Bottom-up, following S-03's shape: privilege and policy first, proved by the data-boundary suite before any code can use them. Then the service, read path and endpoint. Then the card. Each layer has a direct precedent, so each change mirrors its delete-side sibling rather than inventing structure.

## Critical Implementation Details

- **Column-scoped grant, never table-wide.** `grant update (worth_watching) on public.summaries to authenticated;`. A table-wide `grant update` would let a client rewrite paid `content` or detach `reservation_id`, and nothing in the UI would show it. The column-privilege probe in Phase 1 is what pins this.
- **Roster shape for a column verb.** Extend the roster so a column-scoped verb is a first-class entry (e.g. a `CLIENT_COLUMN_UPDATABLE: { summaries: ["worth_watching"] }` map). Invariant 6's expected set must include `summaries:UPDATE` derived from that map. Add an invariant asserting that the set of `(table, column)` pairs `authenticated` can UPDATE (via `has_column_privilege` over `pg_attribute`, `attnum > 0 and not attisdropped`) equals the map exactly. `CLIENT_READABLE.summaries` stays `["DELETE","SELECT"]`: the table-level check correctly still says no table-wide UPDATE, and that is now asserted rather than accidental.
- **Invariant 7 checks `using` only.** The new policy's `with check` must also be owner-scoped. Today the column grant alone stops `user_id` from being rewritten, but a `with check (true)` would silently allow re-owning rows the moment a later migration widens the grant. Extend invariant 7 (or add a sibling) to assert `with check` on UPDATE policies normalizes to `auth.uid()=user_id`.
- **Lock ordering on the client.** Record the previous value, set the in-flight flag and the optimistic value in one state update, and clear the flag only after the response settles (success, rollback, or removal). A stale previous value captured at click time is correct precisely because the lock prevents a second click in between.

## Phase 1: Schema, Privilege and Data-Boundary Tests

### Overview

Add the column and the narrow write path, and prove at the database layer that it is owner-scoped and column-scoped.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_summaries_worth_watching.sql`

**Intent**: Add the nullable mark and open exactly one column to exactly one verb for the row owner. Idempotent, with a header comment explaining why the grant is column-scoped and referencing the single-writer migration.

**Contract**:
- `alter table public.summaries add column if not exists worth_watching boolean;` (no default beyond null, no backfill).
- `grant update (worth_watching) on public.summaries to authenticated;`. No table-level update, `anon` untouched.
- `drop policy if exists "summaries_update_authenticated"` then `create policy … for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);`.

#### 2. Authorization roster

**File**: `src/test/authorization-invariants.int.test.ts`

**Intent**: Classify the new column-scoped verb so the roster stays the oracle and fails on either a missing grant or a widened one.

**Contract**: New roster map for column-scoped UPDATE (`summaries: ["worth_watching"]`, sourced to the new migration). Invariant 6's expected set includes verbs from that map. New invariant: the columns `authenticated` can UPDATE across `public` equal the map exactly. `with check` on UPDATE policies is asserted owner-scoped. Header/roster comments updated (the "INSERT/UPDATE halves were dropped" note now reads UPDATE is re-opened for one column).

#### 3. Cross-account and column-privilege probes

**File**: `src/test/cross-account-policy.int.test.ts`

**Intent**: Prove through two real sessions that the policy works, and that the grant is narrow.

**Contract**:
- Account B `update({ worth_watching: true }).eq("id", a.summaryId).select("id")` → `error` null, `data` `[]`. A's value read back through the owner connection is still `null`.
- Account A updating `content` (and separately `reservation_id`) on its **own** summary → PostgREST error (permission denied). The owner connection confirms `content` unchanged.
- Account A updating `worth_watching` on its own row → one row returned, owner connection reads the new value (the positive control that makes the two negatives meaningful).

### Success Criteria:

#### Automated Verification:

- Migration applies on the local stack without reset: `npx supabase migration up`
- Integration suite passes including roster and new probes: `npm run test:integration`
- Typecheck passes: `npm run typecheck`
- Lint passes: `npm run lint`

#### Manual Verification:

- Deliberate break: temporarily changing the grant to table-wide `grant update on public.summaries` turns the roster invariant and the `content` probe red. Revert afterwards.
- Existing local summaries still list normally in the dashboard (column is additive).

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Service, Read Path and Endpoint

### Overview

Expose the mark through the list and a `PATCH` route with the same trust shape as `DELETE`.

### Changes Required:

#### 1. Update service

**File**: `src/lib/services/summary-update.ts` (new), `src/lib/services/summary-update.test.ts` (new), `src/lib/services/__fixtures__/supabase-stub.ts`

**Intent**: RLS-scoped setter mirroring `deleteSummary`: anon client injected, no `user_id` predicate, `.select("id")` so zero rows are observable.

**Contract**: `setWorthWatching(supabase: AppSupabaseClient, summaryId: string, value: boolean | null): Promise<boolean>`. `true` = one row updated, `false` = zero rows (null payload also `false`), throws on a PostgREST error, a transport rejection propagates. Updates only `{ worth_watching: value }`. Stub helpers `stubUpdating` / `stubUpdateFailing` / `stubUpdateRejecting` alongside the delete ones, exposing `from`/`update`/`eq`/`select` spies. Unit tests mirror `summary-delete.test.ts`: the three return shapes, error, rejection, id-only predicate, payload is exactly `{ worth_watching }` (so no other column is ever sent), `.select("id")` requested, and `null` passes through as a clear rather than being dropped.

#### 2. Read path

**File**: `src/types.ts`, `src/lib/services/summary-list.ts` (and its test if it asserts the mapped shape)

**Intent**: The mark must come back on reload.

**Contract**: `SummaryListItem.worthWatching: boolean | null`. `LIST_SELECT` includes `worth_watching`, `SummaryListRow` gains it, `toListItem` maps it.

#### 3. Endpoint

**File**: `src/pages/api/summaries/[id].ts`

**Intent**: Add `PATCH` next to `DELETE` with the same exit order and a doc comment in the same style (why anon client, CSRF via `checkOrigin`, why 404).

**Contract**: `PATCH` exits: `401` unauthenticated → `400` id not `z.uuid()` or body not `z.object({ worth_watching: z.boolean().nullable() }).strict()` (a missing key is a 400, not a clear; unparseable JSON is a 400) → `503` Supabase unconfigured → `404 { error: "Summary not found" }` zero rows → `500` masked with `console.error` → `200 { ok: true, worthWatching }`.

#### 4. Route tests

**File**: `src/pages/api/summaries/update.int.test.ts` (new, stub layer, pattern of `delete.int.test.ts`), `src/pages/api/summaries/update.db.int.test.ts` (new, real stack, pattern of `delete.db.int.test.ts`)

**Intent**: Stub layer covers every exit row, including those unreachable against a healthy stack (400 variants, 503, 500). Real stack proves the value persists for the owner (read back via owner connection), that clearing to `null` persists, and that B's PATCH on A's summary answers `404` with A's value unchanged.

**Contract**: `it.each` over the 400 body cases: missing key, `"yes"` string, extra key, invalid JSON. Each is a distinct regression.

### Success Criteria:

#### Automated Verification:

- Unit suite passes: `npm test`
- Integration suite passes: `npm run test:integration`
- Typecheck passes: `npm run typecheck`
- Lint passes: `npm run lint`

#### Manual Verification:

- Using the signed-in browser session's devtools, `fetch('/api/summaries/<own id>', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worth_watching: true }) })` returns 200, and `GET /api/summaries` shows `worthWatching: true`.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Card Toggle

### Overview

Render the verdict control on each saved card, wired to the endpoint with lock, rollback and 404 removal.

### Changes Required:

#### 1. Toggle group primitive

**File**: `src/components/ui/toggle-group.tsx`, `src/components/ui/toggle.tsx` (generated)

**Intent**: Use the shadcn primitive, not a hand-written one (CLAUDE.md convention).

**Contract**: `npx shadcn@latest add toggle-group`. Used as `type="single"`; an empty value maps to `null`.

#### 2. Copy

**File**: `src/lib/copy/pl.ts`

**Intent**: All user-facing strings in one place.

**Contract**: Under `summaries.card`: group label naming the video (e.g. `verdictGroup: (title) => \`Czy warto obejrzeć: ${title}\``), `worthWatching: "Warto obejrzeć"`, `notWorthWatching: "Nie warto"`. Under `errors`: `summaryVerdictFailed` (e.g. "Nie udało się zapisać oceny. Spróbuj ponownie.").

#### 3. Card control

**File**: `src/components/summaries/SummaryCard.tsx`

**Intent**: Always-visible pills (icon + label) in the card body below the metadata/generated-on line, lifted above the stretched expand button (`relative z-10`) so clicks don't toggle expansion. Presentational: value, disabled flag and error come from props.

**Contract**: New props `onSetVerdict(id, value: boolean | null)`, `verdictSaving?: boolean`, `verdictError?: string`, `onClearVerdictError(id)`. The value is `item.worthWatching`. Group `aria-label` from copy; items expose pressed state via the primitive. The inline error uses the same `role="alert"` treatment as `deleteError`.

#### 4. List state and handler

**File**: `src/components/summaries/DashboardSummaries.tsx`, `src/components/summaries/SummaryList.tsx`

**Intent**: Own the optimistic update and its failure paths, next to `handleDelete`.

**Contract**: `handleSetVerdict(id, next)`: ignore if that id is already saving → capture previous → mark saving, set `worthWatching = next`, clear that card's verdict error → `PATCH`. `200` keeps the value. `404` removes the card (reuse the tombstone so a concurrent re-read can't re-add it). Non-OK or rejected fetch restores the previous value and sets `copy.errors.summaryVerdictFailed`. Saving flag cleared in all branches. `SummaryList` passes the new props through; the pending card gets no verdict control.

### Success Criteria:

#### Automated Verification:

- Typecheck passes: `npm run typecheck`
- Astro typecheck passes: `npm run typecheck:astro`
- Lint passes: `npm run lint`
- Unit suite passes: `npm test`
- Build succeeds: `npm run build`

#### Manual Verification:

- Mark "Warto obejrzeć", reload → still marked. Switch to "Nie warto" → the other deselects. Click the active option → unmarked; reload → unmarked.
- A newly generated summary appears unmarked.
- Clicking a verdict never expands/collapses the card, and keyboard (Tab/Space/Enter) operates the group.
- Rapid double-click: second click ignored while saving; the state after reload matches the screen.
- With the dev server stopped (network failure) or DevTools request blocking: mark rolls back and the inline error shows; a later successful click clears the error.
- Delete the summary in a second tab, then mark it in the first → card disappears.
- Layout holds at ~400px width, light and dark.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful.

---

## Testing Strategy

### Unit Tests:

- `summary-update.test.ts`: true/false/null-payload, error, rejection, id-only predicate, exact payload `{ worth_watching }`, `.select("id")`, `null` passed through as a clear.

### Integration Tests:

- Roster: column-scoped UPDATE classified, table-level UPDATE still absent, UPDATE policy `using` + `with check` owner-scoped.
- Cross-account: B's update on A's row affects no rows. A cannot update `content`/`reservation_id` on its own row. A can update `worth_watching` (positive control).
- Route stub layer: all exits including 400 body variants, 503, masked 500.
- Route real stack: set, clear, cross-account 404 with value unchanged.

### Manual Testing Steps:

1. Phase 1 deliberate break (table-wide grant → red).
2. Phase 2 devtools PATCH round-trip.
3. Phase 3 checklist above (reload persistence, exclusivity, clear, lock, rollback, 404 removal, responsive/theme).

## Performance Considerations

None material: one extra boolean column in the list select and one single-row update per click.

## Migration Notes

Additive and nullable, so existing rows read as unmarked and there is no backfill. Rollback is a follow-up migration: revoke the column grant, drop the policy, drop the column. Deploy order is the usual migration-before-Worker; the old Worker ignores the column.

## References

- Roadmap: `context/foundation/roadmap.md` §S-14
- Delete precedent: `src/pages/api/summaries/[id].ts`, `src/lib/services/summary-delete.ts`, `src/components/summaries/DashboardSummaries.tsx:249-289`
- Single-writer rationale: `supabase/migrations/20260731130000_summaries_single_writer.sql`
- Test cookbook: `context/foundation/test-plan.md` §6.1–§6.3

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema, Privilege and Data-Boundary Tests

#### Automated

- [x] 1.1 Migration applies on the local stack without reset: `npx supabase migration up` — 8e586e7
- [x] 1.2 Integration suite passes including roster and new probes: `npm run test:integration` — 8e586e7
- [x] 1.3 Typecheck passes: `npm run typecheck` — 8e586e7
- [x] 1.4 Lint passes: `npm run lint` — 8e586e7

#### Manual

- [ ] 1.5 Deliberate break: table-wide grant turns roster invariant and `content` probe red; reverted
- [ ] 1.6 Existing local summaries still list normally in the dashboard

### Phase 2: Service, Read Path and Endpoint

#### Automated

- [x] 2.1 Unit suite passes: `npm test`
- [x] 2.2 Integration suite passes: `npm run test:integration`
- [x] 2.3 Typecheck passes: `npm run typecheck`
- [x] 2.4 Lint passes: `npm run lint`

#### Manual

- [ ] 2.5 Devtools PATCH round-trip returns 200 and `GET /api/summaries` shows the mark

### Phase 3: Card Toggle

#### Automated

- [ ] 3.1 Typecheck passes: `npm run typecheck`
- [ ] 3.2 Astro typecheck passes: `npm run typecheck:astro`
- [ ] 3.3 Lint passes: `npm run lint`
- [ ] 3.4 Unit suite passes: `npm test`
- [ ] 3.5 Build succeeds: `npm run build`

#### Manual

- [ ] 3.6 Mark / switch / clear each survive reload
- [ ] 3.7 New summary appears unmarked
- [ ] 3.8 Verdict click never toggles expansion; keyboard operates the group
- [ ] 3.9 Rapid double-click ignored while saving; reload matches screen
- [ ] 3.10 Network failure rolls back with inline error; later success clears it
- [ ] 3.11 Summary deleted in another tab → card disappears on mark
- [ ] 3.12 Layout holds at ~400px, light and dark
