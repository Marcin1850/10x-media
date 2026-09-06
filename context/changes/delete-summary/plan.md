# Delete Summary Implementation Plan

## Overview

Let a signed-in user permanently delete one of their own saved summaries from the list at `/summaries`.
This closes roadmap slice **S-03** and **PRD FR-007** (nice-to-have), completing CRUD on `summaries`.

The database layer for this already exists and needs no change: `authenticated` holds exactly
`SELECT, DELETE` on `public.summaries` behind an owner-scoped policy. What is missing is a server
endpoint the browser can reach and a control on the card. The paid generation path is not touched.

## Current State Analysis

**The data layer is done.** `20260613145120_videos_and_summaries.sql:61-63` created
`summaries_delete_authenticated` — `for delete to authenticated using (auth.uid() = user_id)` — and
`20260731130000_summaries_single_writer.sql:27-39` narrowed the grants to exactly
`grant select, delete on public.summaries to authenticated`, dropping the insert/update policies. The
committed roster in `src/test/authorization-invariants.int.test.ts:91` records
`summaries: ["DELETE", "SELECT"]`, and `src/test/cross-account-policy.int.test.ts:233-263` already
proves account B's `DELETE` against account A's summary reports zero rows and destroys nothing.
**The delete feature itself ships no schema change.** One migration does ride on this branch —
`20260906170000_begin_generation_comment.sql`, comment-only, zero behaviour change (Phase 1 item 1).

**The read path was shaped for this.** `src/pages/api/summaries/index.ts:20` states it in its own
header: _"is deliberately shaped so S-03 (delete) can reuse it unchanged."_ No change is needed there.

**The list has exactly one owner.** `SummariesSurface` holds `summaries` and passes it to a controlled
`SummaryList` (`src/components/summaries/DashboardSummaries.tsx:36-40`), so a delete has one place to
land. That same component also owns three pieces of generation bookkeeping a delete must coexist with:
`refreshSeq` (ordering of post-generation re-reads), `unlisted` (a saved-but-not-listed summary), and
the pending card derived from the generation hook.

**No client-side Supabase client exists.** Every secret is server-only via `astro:env/server`
(`README.md` → Environment variables), so an island cannot delete a row directly. An API route is
required.

**There is no query-builder seam in the unit fixtures.** `src/lib/services/__fixtures__/supabase-stub.ts`
exposes only `rpc` — it was built for the ledger services, which are pure with respect to an injected
admin client. A delete goes through `.from().delete().eq().select()`, which that stub cannot express.
`listSummaries` has no unit test today for the same reason. Phase 1 has to add the seam.

**No dynamic API route exists yet.** Every route under `src/pages/api/` is static
(`auth/{signin,signup,signout}`, `account/delete`, `summaries/{index,generate}`), so `[id].ts` is the
first, and its param arrives as `string | undefined` from `context.params`.

## Desired End State

A signed-in user on `/summaries` sees a delete control on each saved summary card. Activating it turns
that card's control into an inline "Delete? / Cancel" confirmation; confirming removes the card
immediately and the row is gone from the database. Their credit balance is unchanged. Another account
cannot delete their summaries. Reloading the page does not bring the summary back.

Verify by: deleting a summary in the UI and reloading; checking `select count(*) from summaries` and
`select balance from user_credits` before and after; and running `npm run test:integration`, which now
asserts both invariants automatically.

### Key Discoveries:

- **Deletion cannot return a credit, by construction — and this was designed in.**
  `20260723120000_atomic_persist_summary.sql:117-124` inserts the summary and moves its reservation to
  `settled` in ONE transaction. `reconcile_reservation` only ever looks at `status = 'reserved'` rows
  (`20260722120000:60-66`), so a delivered-then-deleted summary is invisible to the sweep. That
  migration's header names this exact scenario as case 2, _"DELIVERED, THEN UNLINKED"_, and concludes:
  _"Summary deletion can no longer rewrite a billing outcome, because the outcome was decided in the
  same transaction that wrote the summary"_ (`:14-22`). **There is no refund logic to remove — the work
  is to pin the property so a future change cannot break it silently.**
- **The one real ledger consequence is benign and already handled.** `begin_generation` replays a
  settled key by looking the summary up via `reservation_id` (`20260723130000:141-152`). With the
  summary deleted it returns `'unavailable'`, and `generate.ts:351-352` answers a clean
  `409 "This request was already processed. Start a new generation."` — no charge, no crash. Reachable
  only by re-POSTing the _same_ idempotency key after deleting that key's summary.
  **That function's comment was wrong, and this branch fixes it.** `20260723130000:147-149` claimed the
  settled-with-no-summary state is one *"which only an operator-side `settle_reservation()` produces"*.
  Research found the claim was **already stale before this slice**: `charge_failed_transcript`
  (`20260731110000`) writes exactly that shape for a charged refusal, and says so in its own header
  (`:35-41`). A user deletion makes a **third** producer — in production the commonest of the three.
  The classification stays correct for all three; only the causal claim was wrong, and it would
  misdirect an operator debugging a 409 toward a manual settle that never happened. Fixed by Phase 1
  item 1.
- **`summaries.reservation_id`'s FK cascades the other way.** `on delete cascade` on
  `credit_reservations (id, user_id)` (`20260722120000:29-35`) means deleting a _reservation_ deletes
  the summary, not the reverse. Deleting a summary touches no ledger row.
- **Pattern for a destructive endpoint**: `src/pages/api/account/delete.ts` — the id comes from
  `context.locals.user`, never the body, and the provider's message is masked behind a stable generic
  500. **Both of those carry over; its server-side confirmation does not.** That impl-review finding is
  scoped to account erasure, where the confirmation is a re-entered email address — independent proof
  the request came from the account holder, guarding an irreversible action across every row they own.
  A per-card delete has neither property: the only value the client could echo back is the summary id
  it just sent, so a `confirm: true` flag or a repeated id would be ceremony a mistaken request
  satisfies as easily as a deliberate one. **The endpoint therefore takes no confirmation field**;
  intent is captured by the card's inline two-step control, and the actual trust boundary is the
  owner-scoped RLS policy, which no client input can widen. Blast radius is one row the user can
  regenerate.
- **Do not add a `user_id` filter to a probe read.** `test-plan.md` §6.3 rule 3: `listSummaries` and
  `getBalance` both apply `.eq("user_id", …)` on top of RLS, which _masks_ a broadened policy. Probe
  reads are unfiltered or keyed by the other account's row id.
- **`lessons.md` — branch first.** The "Create a new branch when starting a change" rule was not
  applied at `/10x-new`; the `delete-summary` branch was opened later, and the plan itself is committed
  on it (`6e9740f`). The prerequisite is met — implementation creates no branch.

## What We're NOT Doing

- **No schema or policy migration.** The grant and the policy already exist and are already covered by
  the committed roster. The one migration on this branch changes a comment inside an existing
  function body and nothing else — no table, column, policy, grant, or executable statement moves.
- **No refund, and no credit accounting of any kind.** Deleting a summary never returns a credit — this
  is the user's explicit constraint and is already true structurally.
- **No soft delete, no undo, no trash/restore.** `authenticated` holds no `INSERT` on `summaries`
  (`20260731130000:27-39`), so an undo would need either a new column (a migration this slice avoids)
  or new server write surface. Deletion is immediate and irreversible, matching `delete-account`.
- **No `videos` cleanup.** The `videos` row survives its last summary. It is invisible to the user (the
  list is driven by `summaries`), it holds cached vendor metadata a re-generation reuses for free, and
  `videos.user_id`'s `on delete cascade` already covers GDPR erasure at the account level.
- **No bulk / multi-select delete.** One card, one deletion.
- **No change to `GET /api/summaries`, `generate.ts`, or any RPC.**
- **No e2e test.** `test-plan.md` §6.4 is still "TBD — see §3 Phase 4"; there is no harness, and building
  one is larger than this feature.
- **No changes to `authorization-invariants.int.test.ts`.** No relation is added, and `summaries`'
  roster entry already names `DELETE`.

## Implementation Approach

Three phases, sequenced so the invariant the user cares about is proven before any UI rests on it.

Phase 1 puts the server surface in place: a small `deleteSummary` service beside the read-side
`summary-list.ts`, and a `DELETE /api/summaries/[id]` route. The service is deliberately _not_ placed in
`services/summaries.ts` — that module owns the service-role-only persist RPC — nor in `summary-list.ts`,
whose header scopes it to the read side. It is the same trust class as `listSummaries`: a plain
RLS-scoped operation any signed-in session may run, so it takes an injected RLS-scoped client and never
the admin client.

Phase 2 proves the two properties that matter against a real database: the row is gone, and the balance
did not move. Plus the cross-account case at the endpoint boundary.

Phase 3 builds the UI. The one non-obvious piece is that `SummariesSurface` now has two writers to the
same list — the delete and the post-generation re-read — so a deleted-id set filters every incoming
list rather than trusting arrival order.

## Critical Implementation Details

**A deleted id must outlive the request that deleted it.** The post-generation re-read in
`refreshSummaries` (`DashboardSummaries.tsx:110-160`) replaces `summaries` wholesale with whatever the
server returned. A re-read issued before the delete commits will legitimately still contain the deleted
row, so removing the card from `summaries` alone is not enough — a re-read landing afterward would put it
back. The deleted-id set is what makes the outcome independent of arrival order: any list, from any
source, is filtered through it before it reaches state. It is held in a `useRef`, not `useState`, and
read after the last `await` on every path that commits a list — both writers cross an await, so a
captured state copy can be older than the deletion it is supposed to suppress (see Phase 3). Ids are
kept for the life of the page, which is bounded by the number of deletions in one session and costs
nothing.

**The `404`-on-zero-rows rule is a decision this slice makes, not a convention it follows.** Research
found **no prior art anywhere in the repo** for 404-vs-500 on a zero-row mutation — every other `404`
in the corpus is a YouTube thumbnail, a Supadata vendor code, or a removed route. Treat the reasoning
below as the contract's source, and keep it stated in the endpoint's header: a future reader will find
no convention to check it against.

**Zero rows deleted is not an error condition for the client.** Under RLS, "someone else's row" and "a
row that no longer exists" are the same observation — PostgREST reports zero affected rows for both. The
endpoint answers `404` (which leaks nothing, since the two cases are indistinguishable server-side), but
the island must treat `404` as _the row is gone_ and keep the optimistic removal. Only a 5xx, a 401, or
a network failure reverts the card. This is the one place the obvious reading ("non-2xx → revert") is
wrong, and it needs a comment at the call site or the next reader will "fix" it.

**CSRF is covered by Astro's default `security.checkOrigin` — do not disable it.** This endpoint is
authenticated purely by session cookies and reads no body, the same shape `delete-account`'s plan
review flagged (`delete-account/reviews/plan-review.md:42-44`), whose accepted fix was to state the
dependency in the plan rather than add a token. Recorded here for the same reason.

**`.select()` is what makes zero-rows detectable.** A PostgREST `DELETE` without `.select()` returns no
rows and cannot distinguish "deleted one" from "matched none". The service must chain `.select("id")` so
the affected-row count is observable.

---

## Phase 1: Server — delete service and endpoint

### Overview

The server surface: a comment-only migration correcting `begin_generation`'s diagnostic claim, an
RLS-scoped `deleteSummary` service, the `DELETE /api/summaries/[id]` route, a query-builder seam in
the unit fixtures, and unit tests for the service. The route's own exits — id
validation included — are pinned in Phase 2's hermetic handler suite, not here: the handler imports
`astro:env/server` transitively and so is unreachable from the unit project (`CLAUDE.md` → Testing).

### Changes Required:

#### 0. Branch — already satisfied, no action

`lessons.md` requires a change to have its own branch. Branch `delete-summary` exists and is checked
out (plan commit `6e9740f`); **do not attempt to create it**. Listed only so the prerequisite is
visibly accounted for.

#### 1. Comment-only migration — correct `begin_generation`'s diagnostic claim

**File**: `supabase/migrations/20260906170000_begin_generation_comment.sql` (new)

**Intent**: `begin_generation`'s body says settled-with-no-summary is a state *"which only an
operator-side `settle_reservation()` produces"*. That has three producers, not one, and the comment
was already wrong before this slice (`charge_failed_transcript`, `20260731110000:35-41`); deleting a
summary makes the third and commonest. The comment lives inside `as $$ … $$`, so it is stored in
`pg_proc.prosrc` and only `create or replace function` can correct it. A wrong diagnostic claim costs
an operator real time on a 409 that has nothing to do with an operator action.

**Contract**: the function body must be **byte-identical to `20260723130000:78-205` except the one
comment block** — same signature, `returns table`, `language plpgsql`, `security definer`,
`set search_path = ''`, same statements in the same order. Generate it by extracting that line range
and applying the single replacement, never by retyping; prove it with a `diff` that shows exactly one
hunk before applying. `create or replace` preserves owner and ACL, but re-assert
`revoke all … from public, anon, authenticated;` + `grant execute … to service_role;` anyway, per the
revoke-then-grant discipline of `20260714101500` / `20260731130000:22-24`. The corrected comment
enumerates all three producers and names `refusal_reason` as what distinguishes the second.
**No roster change**: no relation is added, and invariant 5 already covers this function's EXECUTE.

#### 2. Delete service

**File**: `src/lib/services/summary-delete.ts` (new)

**Intent**: One function that deletes a single summary through an RLS-scoped client and reports whether
a row was actually removed. Kept out of `services/summaries.ts` (service-role-only write path) and out
of `summary-list.ts` (whose header scopes it to the read side); its own header should state the same
trust-class reasoning `summary-list.ts:5-9` states for the read.

**Contract**: `deleteSummary(supabase: AppSupabaseClient, summaryId: string): Promise<boolean>` —
`true` when exactly one row was deleted, `false` when zero rows matched, and it **throws** on a genuine
PostgREST error so the caller can distinguish "nothing to delete" from "the delete failed". The query
chains `.select("id")` (see Critical Implementation Details — without it the row count is unobservable).
It passes **no `user_id` predicate**: the owner-scoped `DELETE` policy is the trust boundary, and adding
a filter would mask a broadened policy from the tests exactly as `test-plan.md` §6.3 rule 3 describes.
Reuse the `AppSupabaseClient` type already imported from `@/lib/services/summaries` by `summary-list.ts`.

#### 3. The endpoint

**File**: `src/pages/api/summaries/[id].ts` (new)

**Intent**: The browser-reachable `DELETE`. First dynamic route in `src/pages/api/`; the param arrives
as `string | undefined`, so it needs explicit validation before it reaches PostgREST.

**Contract**: `export const prerender = false;` and an uppercase `DELETE: APIRoute` export. Ordered exits:

| Condition                                     | Status | Body                                                                                       |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| no `context.locals.user`                      | 401    | `{ error: "Unauthorized" }`                                                                |
| `context.params.id` missing or not a UUID     | 400    | `{ error: <zod message> }`                                                                 |
| `createClient` returns null                   | 503    | `{ error: "Supabase is not configured" }`                                                  |
| service returned `false` (zero rows)          | 404    | `{ error: … }`                                                                             |
| service threw                                 | 500    | `{ error: "Something went wrong. Please try again." }` (masked, logged — see below) |
| one row deleted                               | 200    | `{ ok: true }`                                                                             |

**The masked 500 logs — decided, do not re-litigate.** Mirror `index.ts:40` exactly:
`// eslint-disable-next-line no-console` then
`console.error("DELETE /api/summaries/[id] failed:", error);`. The repo has ~50 `console.error` calls
in production code (13 in `generate.ts` alone) and a dedicated `reporting.ts` seam that itself writes
to the console; `account/delete.ts` is the **single** non-logging endpoint in the codebase, and the
reason its impl-review gave — *"no src file logs to console"* — was already false when written. This
exit is by design the only one with no diagnostic surface (generic body, provider message discarded),
so without the log a production failure is invisible. Do **not** reach for `reportEvent`: that seam is
for event families with a stable search key (budget, unsupported-feature), not ordinary "X failed:"
diagnostics. Full reasoning: `research.md` §8 question 1.

Validate with `z.uuid()` — zod v4 is on `^4.4.3` and `src/lib/schemas/generate-summary.ts:26` already
uses that exact top-level form. Use the anon SSR `createClient(context.request.headers, context.cookies)`,
**never** `createAdminClient` — the RLS policy is the enforcement point, and an admin client would
bypass the very thing under test. Mirror `index.ts`'s eslint-disable comment for the untyped-client
`any` gap. `200 { ok: true }` rather than `204` so the shape matches `account/delete.ts` and the client
can `res.json()` uniformly.

#### 4. Query-builder seam in the unit fixtures

**File**: `src/lib/services/__fixtures__/supabase-stub.ts`

**Intent**: The existing stub exposes only `rpc`, which cannot express `.from().delete().eq().select()`.
Add a minimal chainable seam so `deleteSummary` is unit-testable at the same layer the ledger services
are, without mocking `fetch` or Supabase's transport.

**Contract**: a `stubDeleting(result)`-style export returning the client plus the individual mocks
(`from`, `delete`, `eq`, `select`), so a test can assert _which table_ and _which id_ the service asked
for; the chain terminates in the `{ data, error }` shape PostgREST returns. Follow the existing file's
three-shape discipline — a structured error and a rejected promise are different worlds and must stay
distinguishable. Extend the file's header comment to say the seam now covers the query builder too, so
the "the seam is the injected client, never fetch" rule stays stated.

#### 5. Unit tests

**File**: `src/lib/services/summary-delete.test.ts` (new)

**Intent**: Cover the service's three outcomes and the fact that it does not narrow the query itself.

**Contract**: colocated, `vitest` imports explicit (globals are off), module under test imported through
`@/`. Cases, one regression each: one row deleted → `true`; zero rows → `false`; structured PostgREST
error → throws with the message wrapped; and an assertion that the call carries **no `user_id` filter**
(the property that keeps the policy, not the query, as the trust boundary — this is the one a future
"let's be more precise" edit would break). Header comment records the oracle: the policy in
`20260613145120:61-63` and `test-plan.md` §6.3 rule 3.

**This file is NOT authorization coverage, and its header must say so.** `test-plan.md` §2 risk #4
names the exact anti-pattern: *"Testing the service function instead of the policy — the service is
not the trust boundary."* A stub answers whatever it is told to, so every case here would stay green
against a policy broadened to `using (true)`. What it proves is that the service does not narrow the
query itself; that another account genuinely cannot delete your row is proved only by Phase 2 case 3,
against a real database and two real sessions.

### Success Criteria:

#### Automated Verification:

- The migration's function body differs from `20260723130000:78-205` in exactly one hunk, the comment block: `diff` shows nothing else
- Migration applies to a running local stack: `npx supabase migration up`
- `begin_generation` still reports `prosecdef` true, `search_path=''`, the same identity arguments, and EXECUTE for `service_role` only
- Integration suite still passes after the migration, `authorization-invariants.int.test.ts` included: `npm run test:integration`
- Lint passes: `npm run lint`
- Types pass: `npm run typecheck`
- Astro types pass: `npm run typecheck:astro`
- Unit suite passes, including the new file: `npm test`
- Build passes: `npm run build`

#### Manual Verification:

- `DELETE /api/summaries/<own summary id>` returns `200 {"ok":true}` and the row is gone from the database
- The same call repeated returns `404`, not `500`
- `DELETE /api/summaries/not-a-uuid` returns `400`
- A valid UUID belonging to another account returns `404`, and that row still exists when read back through a table-owner connection
- Signed out, the call returns `401`

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human before proceeding to the next phase. Phase blocks use plain
bullets — the corresponding checkboxes live in the `## Progress` section at the bottom of the plan.

---

## Phase 2: Integration test — the row is gone, the balance is not

### Overview

Two files. A hermetic handler suite pins every exit of the route's status table with no database at
all; a DB-layer suite proves against a real local Postgres the two properties the feature rests on,
plus the cross-account boundary at the endpoint level. The DB half is where the "deletion must not
return credits" constraint becomes executable rather than a comment.

### Changes Required:

#### 1. Hermetic handler integration test

**File**: `src/pages/api/summaries/delete.int.test.ts` (new)

**Intent**: Pin the route's status table — every row of it — with no database. Phase 1's unit test
covers the service; nothing yet covers the handler's translation of that service into a response, and
three of its six exits (`400`, `503`, `500`) are unreachable from the DB suite by construction: a
malformed id, an unconfigured Supabase, and a thrown service call cannot be provoked against a real
healthy stack. Today they are manual-only.

**Contract**: follows `generate.int.test.ts`'s stub-layer *discipline*, but **cannot reuse
`generation-harness.ts` itself** — research.md §4 established two blockers: `makeContext`
(`:261-280`) has no `params` support and hard-codes `method: "POST"` and the generate URL, and
`loadEndpoint` (`:333-356`) returns `typeof import("@/pages/api/summaries/generate")` and
unconditionally mocks `llm.ts`. This file therefore carries its own small loader and context helper
(colocated, or a sibling fixture if a second dynamic route ever needs them), copying the ordering the
harness documents at `:343-344`: `vi.resetModules()` → set env → **`vi.doUnmock` first, every time**
(mock factories outlive `resetModules()`) → `vi.doMock` the client constructor and the
`summary-delete` service → dynamic `import()`. `vi.restoreAllMocks()` in `afterEach`. No `fetch` stub
is needed: nothing paid is on this path. The context helper supplies `locals.user` **and**
`params.id`. One case per exit, each catching a different regression:

1. **No `locals.user`** → `401`, and the service is never called.
2. **`params.id` missing, and `params.id` not a UUID** → `400` with the zod message; the service is
   never called. This is item 1.8 promoted out of manual verification.
3. **`createClient` returns `null`** → `503 "Supabase is not configured"`; the service is never called.
4. **Service resolves `false`** → `404`.
5. **Service rejects** → `500` with the generic masked body and the provider's message absent from
   the response. Assert the mask by its own shape — that the body equals the stable copy — not as
   "not the provider message". Spy with `vi.spyOn(console, "error")` in `beforeEach` to keep a green
   run readable, and assert only **that it was called**, never its text: `test-plan.md` §6.1 —
   *"do not assert the marker strings — they are log copy, not a contract any consumer reads."*
6. **Service resolves `true`** → `200 {"ok":true}`.

Oracle: the status table in this plan's Phase 1 and `account/delete.ts`'s established masking
pattern — not read off the handler under test.

**Why an integration-project file and not a unit test**: the route imports `astro:env/server`
transitively through `@/lib/supabase`, which the unit project cannot resolve; the integration project
aliases it to `src/test/astro-env-server-stub.ts` (`CLAUDE.md` → Testing). This file needs no Docker,
but it lives in the project that can load the module.

#### 2. DB-layer integration test

**File**: `src/pages/api/summaries/delete.db.int.test.ts` (new)

**Intent**: Drive the real `DELETE` route against the local stack with synthetic accounts, asserting the
row's disappearance and the balance's stability — the balance half is the whole reason this phase exists.

**Contract**: follows the `generate.db.int.test.ts` shape — real `@/lib/supabase`, real
`@/lib/supabase-admin`, accounts from `createSyntheticAccount`, cleanup via `dispose()` in
`try/finally`. **Nothing paid is involved**, so unlike `generate.db.int.test.ts` this file mocks no
vendor and seeds no `transcript_cache`/`metadata_cache`; rows are seeded directly through
`getDbOwnerConnection()`, the same way `cross-account-policy.int.test.ts`'s `seed()` does. Synthetic
youtube ids follow that file's precedent and are **not** added to `RESERVED_YOUTUBE_IDS` — that registry
guards the user-agnostic caches, which this file never touches (`test-plan.md` §6.3 rule 6).

Four cases, each catching a different regression:

1. **Deleting your own summary**: `200`, and the row is gone when read back through the owner connection.
2. **The balance is unchanged** across that same delete — read before and after. The oracle is the
   documented credit rule (`README.md:259` — a credit is spent on a successful summary; refills are
   **manual-only**, which is what makes any increase outside an operator action a bug by definition)
   plus `20260723120000:13-15,21-22` — case 2 "DELIVERED, THEN UNLINKED" and its conclusion that
   deletion cannot rewrite a billing outcome. **Not** recomputed the way the code computes it. Do not
   seed a starting balance either: `synthetic-account.ts:9-13` states callers *"must NOT set the
   initial balance by hand"* — read it, before and after.
3. **Account B deleting account A's summary**: `404`, and A's row still exists when read back through
   the owner connection. Read back through the owner connection specifically — "PostgREST reported no
   rows deleted" and "nothing was destroyed" are different claims (`test-plan.md` §6.3 rule 4). The
   oracle is the PRD's own guardrail, not this plan: *"summaries and video list visible only to the
   logged-in user"* (`prd.md:36-37`), restated at `prd.md:70-73` and `prd.md:90-92`, enforced by the
   policy at `20260613145120:61-63`. **The mechanic that makes this case mean anything** is that the
   request carries account B's `cookieHeader` (`synthetic-account.ts:31`), so the `createClient` inside
   the route resolves B's session and RLS evaluates `auth.uid()` as B — the same thing production does.
   Build it the way `cross-account-policy.int.test.ts:102-112`'s `sessionClient` does, through the
   app's own factory; a hand-made client would test a different code path.
4. **Deleting an already-deleted id**: `404`, not `500` — the contract the island depends on.

Nested `try/finally` for the two-account case so a first `dispose()` that throws cannot swallow the
second (§6.3 rule 5).

**Do not** assert what a user can see through the owner or `service_role` connection, and do not reach
for `listSummaries` to check the row is gone — both bypass or mask RLS.

### Success Criteria:

#### Automated Verification:

- Integration suite passes against a running local stack: `npm run test:integration`
- Both new files run in that suite: `delete.int.test.ts` (hermetic, six exits) and `delete.db.int.test.ts` (real stack)
- Lint passes on the new files: `npm run lint`
- Types pass: `npm run typecheck`
- `authorization-invariants.int.test.ts` and `cross-account-policy.int.test.ts` still pass unchanged (no relation added, no grant changed)

#### Manual Verification:

- The balance assertion genuinely fails if broken: temporarily make the endpoint credit the user, confirm case 2 goes red, then revert. A test that cannot fail is not evidence.

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human before proceeding to the next phase.

---

## Phase 3: UI — the card control and the list state

### Overview

The user-facing half: an inline two-step delete on each card, optimistic removal owned by
`SummariesSurface`, a deleted-id set that keeps a post-generation re-read from resurrecting a deleted
card, and Polish copy.

### Changes Required:

#### 1. Polish copy

**File**: `src/lib/copy/pl.ts`

**Intent**: Every user-visible string in Polish, in the single-locale copy module. `Copy` is
`typeof pl` (`src/lib/copy/index.ts:4`), so adding keys here is what makes them available and
type-checked.

**Contract**: new keys under `summaries.card` for the delete control — the trigger's accessible label
(naming the video, as `summaryOf` / `openVideo` already do), the confirmation question, confirm, cancel,
and a failure message. **No in-flight label**: removal is optimistic, so the card is out of the list
before the request resolves and a "deleting…" state can never render. The existing `copy.errors` group
is where a network-failure string belongs, matching `accountDeleteNetwork`.

#### 2. The card's delete control

**File**: `src/components/summaries/SummaryCard.tsx`

**Intent**: A trash control on the card that flips in place into "Delete? / Cancel" and calls up. The
card stays presentational about the _outcome_ — it owns only which of the two steps is showing.

**Contract**: new props — an `onDelete` callback, an optional `error` string, and an
`onClearDeleteError` callback; the card holds a local `confirming` boolean and nothing else. There is
deliberately **no `deleting` flag**: the parent removes the card the moment deletion starts, so an
in-flight prop on this component would be dead code. The error is the only delete state that reaches
the card, and it arrives only after a failed deletion has restored the row. Two placement constraints from the
existing markup: the header row's expand button uses a stretched `::after` that catches every click in
the row, so the control needs the same `relative z-10` treatment the two links already carry
(`SummaryCard.tsx:105` and its comment); and the control must not be nested inside the expand button.
The error renders inline on the card, using the `role="alert"` destructive treatment
`DeleteAccountDialog.tsx` already establishes. Cancel returns to the idle state and calls
`onClearDeleteError(id)` — the error is owned by the parent, so the card cannot clear it by itself.

#### 3. List plumbing

**File**: `src/components/summaries/SummaryList.tsx`

**Intent**: Pass the delete wiring through to each card. The list keeps owning only its filter; it gains
no state.

**Contract**: new props forwarded from the caller — a delete handler keyed by summary id, per-id error
strings, and an error-clear handler keyed by summary id. No in-flight set is passed: an id being
deleted has no card in this list to receive it. The pending card is unaffected: a generation in flight
is not a saved summary and has no delete control.

#### 4. Delete lifecycle and list state

**File**: `src/components/summaries/DashboardSummaries.tsx`

**Intent**: Own the delete the way it already owns the generation: fire the request, remove the card
optimistically, and make the removal survive a concurrent re-read.

**Contract**: two pieces of delete bookkeeping — per-id errors and a **deleted-id set**. There is no
separate "ids in flight" state: an id being deleted is exactly an id in the deleted set with no card
rendered, so tracking it twice would be two sources of truth for one fact. Errors are ordinary
`useState`; the deleted-id set is a
`useRef<Set<string>>` and the ref — not a state copy — is authoritative. React state updates are
asynchronous, but both writers of `summaries` cross an `await` before they commit: `refreshSummaries`
awaits the fetch, and the generation `onSuccess` callback is captured at submit time (the closure
hazard `DashboardSummaries.tsx:72-76` already warns about). A `useState<Set>` read from either closure
can predate a deletion that happened during the wait, which resurrects exactly the card this design
exists to keep buried. The ref is mutated synchronously on confirm and on rollback, and **every commit
of `summaries` reads `deletedIds.current` after its last `await`, immediately before calling
`setSummaries`** — the same discipline `refreshSeq` (`:116`, `:125-134`) already uses for ordering.
Mirror `refreshSeq`'s header comment: state a ref is used here because the value must be correct
across an await, not because a re-render is unwanted.

The behaviour:

- On confirm: add to `deletedIds.current`, drop from `summaries`, issue `DELETE /api/summaries/<id>`.
- `200` **and** `404` are both terminal success — the row is gone either way, so the card stays removed
  and the id stays in the deleted set. This needs the comment described in Critical Implementation
  Details; the obvious "non-2xx → revert" reading is wrong here.
- Any other status, or a thrown fetch: remove the id from `deletedIds.current` **before** restoring
  the row into `summaries` in `created_at` order (so it does not jump to the top), then set that id's
  error. Ref-first is load-bearing: a restore committed while the tombstone is still present would be
  filtered straight back out.
- **Every list that enters `summaries` is filtered through `deletedIds.current`, read after the last
  `await` on that path** — the initial prop, `refreshSummaries`'s result, and any list the generation
  success path commits. This is the guard against a post-generation re-read resurrecting a deleted
  card, and it is order-independent by design (`refreshSeq` orders re-reads against each other and
  knows nothing about deletions).
- If the deleted id equals `unlisted.summaryId`, clear `unlisted`. The note would otherwise keep telling
  the user a summary was saved and is missing from the list, after they deliberately removed it — a
  wrong statement about their data, which is what `SummaryList.tsx:60-68` is at pains to avoid.
- `listUnavailable` is untouched by a delete; a failed deletion is not a failed read.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Types pass: `npm run typecheck`
- Astro types pass: `npm run typecheck:astro`
- Unit suite passes: `npm test`
- Integration suite still passes: `npm run test:integration`
- Build passes: `npm run build`

#### Manual Verification:

- Deleting a summary removes its card immediately; a page reload does not bring it back
- Cancel at the confirmation step leaves the summary untouched
- The credit balance in the topbar is identical before and after a deletion
- Deleting the same summary in a second tab, then confirming in the first, leaves the card removed and shows no error (the `404`-is-success path)
- With the network offline, a failed deletion restores the card in its original list position and shows an inline error; retrying afterward succeeds
- Starting a generation, deleting an unrelated saved summary while it runs, and letting the generation finish: the new summary appears and the deleted card does **not** come back
- Keyboard only: the delete control is reachable by Tab, activating it does not toggle the card's expand state, and the confirmation is operable and dismissible
- The whole flow reads in Polish

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human.

---

## Epilogue (not a phase)

- `context/changes/delete-summary/change.md` → status advanced, `updated` bumped.
- `context/foundation/roadmap.md`: S-03's `- **Status:**`, the _At a glance_ row, **and** the _Backlog
  Handoff_ row updated together (`lessons.md`, "Sync Backlog Handoff when a slice's status changes").
- Linear: the S-03 issue moved to the matching state with a comment summarizing what landed
  (`lessons.md`, "Update Linear status + comment at each lifecycle step").
- Deploy is no longer a single Worker upload: `npx supabase db push` then `npx wrangler deploy`. The
  migration is inert (a comment), so the two are not coupled, but the push must not be forgotten or
  the deployed function keeps the wrong diagnostic text.
- No README or CLAUDE.md change: no new script, env var, or convention is introduced, and the one
  migration adds no table, column, policy or grant that any documented rule covers.

---

## Testing Strategy

### Unit Tests:

- `deleteSummary`: one row deleted → `true`; zero rows → `false`; structured PostgREST error → throws.
- The query carries no `user_id` predicate — the property that keeps the RLS policy, not the query, as
  the trust boundary.

### Integration Tests:

- Hermetic (`delete.int.test.ts`, no database): one case per row of the endpoint's status table —
  `401`, `400` (missing and malformed id), `503`, `404`, masked `500`, `200`. Covers the three exits a
  healthy real stack cannot provoke.
- DB-layer (`delete.db.int.test.ts`, real stack): own delete succeeds; **balance unchanged**;
  cross-account `404` with the row intact; already-deleted `404`.

### Manual Testing Steps:

1. Generate or pick a saved summary; note the credit balance in the topbar.
2. Delete it, confirm the card disappears, reload, confirm it is still gone and the balance is identical.
3. Open `/summaries` in two tabs, delete the same summary in each; the second shows no error.
4. Set the network to offline, attempt a delete, confirm the card returns with an inline error in its
   original position; restore the network and retry.
5. Start a generation, delete a different saved summary while it runs, let it finish; confirm the new
   card appears and the deleted one does not return.
6. Tab to the delete control and drive the whole flow from the keyboard.

## Performance Considerations

None. A single-row `DELETE` by primary key against a table with a `user_id` index; no new query runs on
page load, and the optimistic removal means no extra round-trip for the list.

## Migration Notes

One comment-only migration, no data migration. `20260906170000_begin_generation_comment.sql` replaces
`begin_generation` with a body byte-identical to `20260723130000:78-205` except one corrected comment
block — verified by diff before applying, and re-asserting the same least-privilege grant. **Deploy
ordering:** `npx supabase db push` before `npx wrangler deploy`, the same window S-08/S-09 used;
because the change is inert, the two are not coupled and either order is safe in practice. Rolling it
back is re-applying the previous definition. The grant and policy this feature depends on have been live since
`20260613145120` / `20260731130000`. Rolling the feature back is a Worker redeploy — nothing to reverse
in the database. Deletions themselves are irreversible by design (no soft delete, no undo).

## References

- Test oracle (read before writing any test here): `context/changes/delete-summary/research.md`
- Roadmap slice: `context/foundation/roadmap.md` → S-03
- PRD: `context/foundation/prd.md:67` FR-007 (nice-to-have — one line; it constrains *that* deletion
  exists, not its shape), and the privacy guardrail that is the cross-account oracle: `prd.md:36-37`,
  `prd.md:70-73`, `prd.md:90-92`
- Credit rules (the balance oracle): `README.md:259`
- Test plan: `context/foundation/test-plan.md` §6.1 (unit), §6.2 (integration), §6.3 (data-access policy), risk #4, risk #6
- Policy and grant: `supabase/migrations/20260613145120_videos_and_summaries.sql:61-63`, `supabase/migrations/20260731130000_summaries_single_writer.sql:27-39`
- Why deletion cannot rewrite a billing outcome: `supabase/migrations/20260723120000_atomic_persist_summary.sql:14-22`
- Destructive-endpoint pattern: `src/pages/api/account/delete.ts`
- Read endpoint this reuses: `src/pages/api/summaries/index.ts:20`
- List state owner: `src/components/summaries/DashboardSummaries.tsx:36-40`
- Existing cross-account DELETE probe: `src/test/cross-account-policy.int.test.ts:233-263`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Server — delete service and endpoint

#### Automated

- [ ] 1.1 The migration's function body differs from `20260723130000:78-205` in exactly one hunk, the comment block: `diff` shows nothing else
- [ ] 1.2 Migration applies to a running local stack: `npx supabase migration up`
- [ ] 1.3 `begin_generation` still reports `prosecdef` true, `search_path=''`, the same identity arguments, and EXECUTE for `service_role` only
- [ ] 1.4 Integration suite still passes after the migration, `authorization-invariants.int.test.ts` included: `npm run test:integration`
- [ ] 1.5 Lint passes: `npm run lint`
- [ ] 1.6 Types pass: `npm run typecheck`
- [ ] 1.7 Astro types pass: `npm run typecheck:astro`
- [ ] 1.8 Unit suite passes, including the new file: `npm test`
- [ ] 1.9 Build passes: `npm run build`

#### Manual

- [ ] 1.10 `DELETE /api/summaries/<own summary id>` returns `200 {"ok":true}` and the row is gone from the database
- [ ] 1.11 The same call repeated returns `404`, not `500`
- [ ] 1.12 `DELETE /api/summaries/not-a-uuid` returns `400`
- [ ] 1.13 A valid UUID belonging to another account returns `404`, and that row still exists when read back through a table-owner connection
- [ ] 1.14 Signed out, the call returns `401`

### Phase 2: Integration test — the row is gone, the balance is not

#### Automated

- [ ] 2.1 Integration suite passes against a running local stack: `npm run test:integration`
- [ ] 2.2 Both new files run in that suite: `delete.int.test.ts` (hermetic, six exits) and `delete.db.int.test.ts` (real stack)
- [ ] 2.3 Lint passes on the new files: `npm run lint`
- [ ] 2.4 Types pass: `npm run typecheck`
- [ ] 2.5 `authorization-invariants.int.test.ts` and `cross-account-policy.int.test.ts` still pass unchanged (no relation added, no grant changed)

#### Manual

- [ ] 2.6 The balance assertion genuinely fails if broken: temporarily make the endpoint credit the user, confirm case 2 goes red, then revert. A test that cannot fail is not evidence.

### Phase 3: UI — the card control and the list state

#### Automated

- [ ] 3.1 Lint passes: `npm run lint`
- [ ] 3.2 Types pass: `npm run typecheck`
- [ ] 3.3 Astro types pass: `npm run typecheck:astro`
- [ ] 3.4 Unit suite passes: `npm test`
- [ ] 3.5 Integration suite still passes: `npm run test:integration`
- [ ] 3.6 Build passes: `npm run build`

#### Manual

- [ ] 3.7 Deleting a summary removes its card immediately; a page reload does not bring it back
- [ ] 3.8 Cancel at the confirmation step leaves the summary untouched
- [ ] 3.9 The credit balance in the topbar is identical before and after a deletion
- [ ] 3.10 Deleting the same summary in a second tab, then confirming in the first, leaves the card removed and shows no error (the `404`-is-success path)
- [ ] 3.11 With the network offline, a failed deletion restores the card in its original list position and shows an inline error; retrying afterward succeeds
- [ ] 3.12 Starting a generation, deleting an unrelated saved summary while it runs, and letting the generation finish: the new summary appears and the deleted card does **not** come back
- [ ] 3.13 Keyboard only: the delete control is reachable by Tab, activating it does not toggle the card's expand state, and the confirmation is operable and dismissible
- [ ] 3.14 The whole flow reads in Polish
