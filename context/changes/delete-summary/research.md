---
date: 2026-09-06T17:30:48+02:00
researcher: Marcin Drobiecki
git_commit: c5b399933cf96b92cb8e48c9e09af5f37f1999e1
branch: delete-summary
repository: 10xMedia
topic: "Test oracle for deleting a summary (S-03 / FR-007)"
tags: [research, testing, oracle, delete-summary, rls, credits]
status: complete
last_updated: 2026-09-06
last_updated_by: Marcin Drobiecki
---

# Research: Test oracle for deleting a summary

**Date**: 2026-09-06T17:30:48+02:00
**Researcher**: Marcin Drobiecki
**Git Commit**: `c5b3999`
**Branch**: `delete-summary`
**Repository**: 10xMedia

## Research Question

Scoped to the **test oracle only**: which independent sources establish the expected behaviour that
the delete unit test, the hermetic `delete.int.test.ts`, and `delete.db.int.test.ts` must assert?
Deliberately *not* a re-derivation of the implementation design — `plan.md` already exists and was
plan-reviewed on 2026-09-06, and was excluded from the sources consulted here.

This exists because `test-plan.md` §6.1 makes the oracle rule non-negotiable: *"What the code should
do comes from the PRD, the README's credit rules, roadmap decisions, or a function's own documented
contract. It never comes from reading the implementation."* Writing the delete tests without that
list on paper is how a test ends up recomputing the behaviour the way the code does.

## Summary

**The oracle is strong for the two properties that matter, thin for the HTTP contract, and one
commonly-cited input is circular.**

1. **Credits are the best-sourced property.** Four independent sources agree and the chain closes end
   to end. `20260723120000:13-22` anticipated this exact feature by name three months before it was
   planned, and concludes: *"Summary deletion can no longer rewrite a billing outcome."*
2. **Authorization is well-sourced** — PRD guardrail, NFR, access-control section, the policy, and
   the grant, plus a committed roster entry that already records `DELETE`.
3. **The endpoint's HTTP contract has almost no independent oracle.** FR-007 is one line. There is
   **no prior art anywhere in the repo** for 404-on-zero-rows. That part of the oracle is the plan's
   own status table, legitimate under §6.1's "a function's own documented contract" but only for the
   response *shape* — never for the credit or authorization properties.
4. **Circularity warning.** The roadmap's §S-03 paragraph reads like a decision record but has **no
   `Decisions` block**; its nine items were written *by* the planning step and are explicitly a
   summary of `plan.md`. They are design decisions, not independent sources. The one exception is
   decision (1), which the roadmap itself tags **"(user constraint)"** — sourced from the user.
5. **Two harness facts invalidate a plan assumption** (§4) and **one citation in the plan is wrong**
   (§7).
6. **Three questions the sources did not resolve** (§8) — two since decided, one accepted.

## Detailed Findings

### 1. The credit invariant — the strongest oracle in this change

The property `delete.db.int.test.ts` case 2 must assert is *the balance does not move*.

- **`README.md:259`** — *"Every account starts with **5 credits**; a successful summary spends **1
  credit**, or **2 credits** for a long video … Refills are **manual-only** — there is no self-serve
  top-up."* The README states no delete-side credit rule at all; every credit-returning event it
  names is generation-side. Manual-only refills make **any** balance increase outside an operator
  action a bug by definition — which is what makes "unchanged" assertable as an absolute rather than
  as a comparison against a computed cost.
- **`supabase/migrations/20260723120000_atomic_persist_summary.sql:13-15`**, verbatim:

  > `2. DELIVERED, THEN UNLINKED. summaries_delete_authenticated (20260613145120) lets an owner`
  > `delete their own summary. Delivered-but-unsettled work can therefore disappear before the`
  > `sweep runs and be misclassified as failed.`

  and its conclusion at `:21-22`: *"Summary deletion can no longer rewrite a billing outcome, because
  the outcome was decided in the same transaction that wrote the summary."* **This migration header
  anticipated the delete feature by name.** It is the single best oracle sentence in the repository
  for this slice.
- **`20260722120000_link_summary_to_reservation.sql:59-66`** — `reconcile_reservation` locks only
  `where … status = 'reserved'` and returns `'noop'` otherwise. Its only balance-increasing statement
  is the refund at `:86-88`, reachable solely when no linked summary exists on a still-`reserved`
  row. A settled reservation is invisible to the sweep whether or not its summary survives.
- **`20260722120000:25-35`** — the FK is `summaries.reservation_id → credit_reservations (id,
  user_id) on delete cascade`, with the header stating the cascade *"only ever fires during account
  deletion"* and that reservations are *"never deleted on their own — only status-transitioned."*
  Direction is reservation → summary. **Deleting a summary touches no ledger row.**

**Anti-pattern this oracle must avoid** (`test-plan.md` §2, risk #1): *"Asserting the balance moved by
whatever the code computes — the oracle must come from the documented credit rules."* Case 2
therefore reads the balance before and after and asserts **equality**; it must not compute an
expected cost. Related: `synthetic-account.ts:9-13` warns the account starts with whatever
`on_auth_user_created` grants and *"callers must NOT set the initial balance by hand"* — so the test
reads the balance rather than seeding one.

### 2. The authorization property

- **`prd.md:36-37`** (Guardrails) — *"Privacy: summaries and video list visible only to the logged-in
  user. No other user or external party has access to the data."*
- **`prd.md:70-73`** (Non-Functional Requirements) — *"User data (summaries, video list) is private —
  no other user or external party has access to it."*
- **`prd.md:90-92`** (Access Control) — *"Multi-tenant architecture — each user sees only their own
  data."*
- **`20260613145120_videos_and_summaries.sql:61-63`** — `create policy
  "summaries_delete_authenticated" on public.summaries for delete to authenticated using (auth.uid()
  = user_id);` (RLS enabled at `:47`).
- **`20260731130000_summaries_single_writer.sql:27,31`** — revoke-then-grant, ending at `grant
  select, delete on public.summaries to authenticated;`. Its header at `:18-20` states the intent:
  *"authenticated keeps SELECT (read your own summaries) and DELETE (remove your own). Reads and
  deletes cannot forge a provenance or cost claim."*
- **`src/test/authorization-invariants.int.test.ts:90`** — the committed roster already records
  `summaries: ["DELETE", "SELECT"]`. **No roster edit is needed**, confirming the plan.

**Rules that bind how this is asserted** (`test-plan.md` §6.3):

- Rule 3 (`:243`) — never call `listSummaries`/`getBalance`, never pass a `user_id` filter; both apply
  `.eq("user_id", …)` on top of RLS and *mask* a broadened policy.
- Rule 4 (`:244`) — *"Never assert what a user can see through an owner or `service_role` connection…
  The owner connection appears only to _seed_, and to _read back_ what a denied `DELETE` must have
  left intact — 'PostgREST reported no rows deleted' and 'nothing was destroyed' are different
  claims."*
- Risk #4 anti-pattern (§2) — **"Testing the service function instead of the policy — the service is
  not the trust boundary."** The `deleteSummary` unit test therefore proves the *query shape* (no
  `user_id` predicate) and must **not** be counted as authorization coverage.

The precedent probe at `cross-account-policy.int.test.ts:233-263` already does exactly this for a raw
PostgREST DELETE: asserts `data` is `[]`, re-reads through `dbOwner` to prove the row survives, **and**
separately re-checks the summary survived in case a permitted `videos` delete cascaded. The new
endpoint-level case is the same assertion one layer up.

### 3. What the sources do NOT establish

- **FR-007 is one line** — `prd.md:67`: *"FR-007: User can delete a summary. Priority: nice-to-have"*
  (plus a Socrates note at `:68` saying it blocks nothing). It constrains *that* deletion exists, not
  its HTTP shape, its confirmation, its credit behaviour, or the fate of the `videos` row.
- **No prior art for 404-on-zero-rows.** A sweep of every `context/changes/**` plan, plan-review,
  impl-review and manual-verification record found nothing establishing 404-vs-500 (or vs 200) for a
  zero-row mutation. Every other `404` in the corpus is a YouTube thumbnail, a Supadata vendor code,
  or the removed `/dashboard` route. The nearest independent constraint is §6.3 rule 4 above, which
  governs how the *cross-account* case is verified, not what status is returned.
- **PRD Non-Goals do not touch deletion.** The closest, `prd.md:98` (*"Sharing summaries between
  users"*), constrains sharing, not removal.
- **`test-plan.md` §7 excludes nothing here**, but two of its entries shape the tests: `:319`
  forbids **snapshot tests on summary cards** (so removal-from-list is asserted behaviourally), and
  `:316` forbids reaching a paid vendor (so a summary under test is seeded through the owner
  connection, never generated). §7's scoped exception at `:324` explicitly permits deleting rows
  **scoped to synthetic accounts and synthetic video ids** — which is what both integration files do.
- **`context/archive/` holds only `README.md`** — no archived change contributes here.

### 4. Harness reality — two facts that contradict the plan's Phase 2 assumption

The plan says the hermetic suite *"follows `generate.int.test.ts`'s stub-layer shape … the endpoint
loaded through the same reset/mock/re-import discipline (`loadEndpoint`)"*. It cannot, as written:

- **`makeContext` has no `params` support.** `generation-harness.ts:261-280` accepts only
  `user`/`body`/`rawBody`/`headers` and returns exactly `{ locals, request, cookies }`, with the URL
  and `method: "POST"` hard-coded at `:273-274`, and `cookies` as `{} as AstroCookies` at `:278`. A
  dynamic `[id]` route reads `context.params.id`, which this cannot supply.
- **`loadEndpoint` is bound to the generate route.** Its return type is `Promise<typeof
  import("@/pages/api/summaries/generate")>` and its last line is `return
  import("@/pages/api/summaries/generate");` (`:333-356`). It also unconditionally mocks `llm.ts`
  (`:350`) — irrelevant to a delete route.

The reusable part is the **discipline**, documented at `:343-344`: *"`doMock` registrations outlive
`resetModules()` — only the module cache is cleared, not the mock factory — so a previous call's mock
would keep standing in here. Unmock first, every time."* That ordering (`vi.resetModules()` → set env
→ `vi.doUnmock` → `vi.doMock` → dynamic `import`) is what a delete loader must copy.

**No `.from().delete()` fake exists anywhere.** The only query-builder fake is `createFakeSupabase`
(`:189-195`), which stops at `from().select().eq().maybeSingle()`. The only `.delete().eq().select()`
in the test tree is the live PostgREST call at `cross-account-policy.int.test.ts:233`. This confirms
the plan's Phase 1 item 3 (the fixture seam) is genuinely new work.

**The unit seam's conventions** (`__fixtures__/supabase-stub.ts`): every factory returns
`{ client, rpc }` from one private `stubFrom` (`:33-37`), casting `as unknown as SupabaseClient` at
the boundary. Its header (`:12-13`) states the discipline a new seam must preserve: *"Three shapes,
because the ledger services distinguish three failure worlds and conflating them is exactly the bug
the tests exist to catch"* — `stubReturning` (PostgREST answered), `stubFailing` (structured error,
*"the one shape that proves nothing was written"*), `stubRejecting` (*"can happen after Postgres
commits, so this proves nothing either way"*).

### 5. Fixture and cleanup contracts the DB test must honour

- `createSyntheticAccount(admin)` → `{ userId, cookieHeader, dispose(youtubeIds?) }`
  (`synthetic-account.ts:28-44`); `dispose()` **throws** on cleanup failure by design.
- `dispose()` needs **no** `youtubeIds` here: seeded `videos`/`summaries` leave with the `auth.users`
  cascade and no `supadata_calls` row is created (`cross-account-policy.int.test.ts:149-157`).
  Matches §6.3 rule 6 — no `RESERVED_YOUTUBE_IDS` entry, since no cache row is written.
- Nested `try/finally` per §6.3 rule 5; pattern at `cross-account-policy.int.test.ts:158-172`.
- `getDbOwnerConnection()` takes no arguments (`db-owner.ts:22`) and is used as a `postgres` tagged
  template; a dynamic table name uses the call form `dbOwner(table)`. Its pool is closed by
  `fetch-firewall.ts`'s `afterAll`, not by the test.
- `sessionClient` (`cross-account-policy.int.test.ts:102-112`) is the established way to build an
  RLS-scoped client from `account.cookieHeader` through the app's own `createClient`.
- `seed()` (`:129-147`) inserts one `videos` row and one `summaries` row directly through the owner
  connection — the shape the delete DB test reuses.

### 6. Destructive-endpoint prior art that DOES transfer

From `context/changes/delete-account/` — the repo's only prior destructive endpoint:

- **Exit ladder shape** (`delete-account/plan.md:93-99`): 401 unauthenticated → 503 unconfigured →
  500 on provider failure → 200 `{ ok: true }`; *"No request body is read; the id is taken from
  `context.locals.user.id` only."*
- **Masking rule** (`impl-review.md:57-59`): a resolved provider error and a rejected promise must
  both produce the **same** masked generic 500 JSON.
- **CSRF** (`delete-account/reviews/plan-review.md:42-44`): a cookie-authenticated destructive
  endpoint is protected by Astro's default `security.checkOrigin` — *"do not disable it"*. The
  finding's fix was to state this in Critical Implementation Details. **The new `DELETE` endpoint is
  in the same class and `plan.md` does not mention it.** Worth one line, for the same reason.
- **Dialogs** (`impl-review.md:61-73`): a hand-built `role="dialog"` was rejected in favour of the
  shadcn primitive. Not binding here — the plan's control is inline, not a modal — but it is why
  "inline two-step" avoids a whole class of prior finding.

### 7. A citation error in the current documents

`plan.md`, `plan-brief.md` and `roadmap.md` all cite the delete policy as
`20260613145120:59-61`. **The delete policy is at `:61-63`**; line 59 is the `for update` line of the
now-dropped `summaries_update_authenticated` policy (verified by `grep -n`: `:57-58` update, `:61-62`
delete). A reader following the citation lands on a policy this migration's successor deleted.

### 8. Open questions the sources do not resolve

1. **Does the delete endpoint's masked 500 log via `console.error`?** Two live, deliberate, mutually
   inconsistent precedents:

   | Endpoint | Behaviour | Source |
   |---|---|---|
   | `src/pages/api/summaries/index.ts:37-41` | masks **and** logs, behind an explicit `// eslint-disable-next-line no-console` | its comment claims it matches `generate.ts` and `account/delete.ts` |
   | `src/pages/api/account/delete.ts:48-52` | masks, **does not log** — the `catch {}` binds nothing | `delete-account/reviews/impl-review.md:59`: *"Dropped the proposed server-side `console.error` to match the repo (no src file logs to console; `no-console` is enforced)."* |

   **RESOLVED 2026-09-06 — the endpoint logs.** Asked and decided after a full census of `src/`:
   roughly **50 `console.error`/`console.warn` calls exist in production code**, including 13 in
   `generate.ts` and one in the sibling `index.ts:40`. There is even a dedicated seam,
   `src/lib/services/reporting.ts` ("the one swappable notification point"), which itself writes to
   `console.error`/`console.warn`. **`account/delete.ts` is the single outlier in the entire
   codebase**, and the premise its impl-review gave for dropping the log — *"no src file logs to
   console"* — was already false when written, since `generate.ts` and `index.ts` both logged before
   2026-08-14.

   The decision: mirror `index.ts:40` exactly —
   `console.error("DELETE /api/summaries/[id] failed:", error);` preceded by
   `// eslint-disable-next-line no-console`. `no-console` is `warn` for `src/**`
   (`eslint.config.js:24`; the `off` override at `:82` covers only `scripts/**`), and an explicit
   disable at the call site is the established convention (`index.ts`, `generate.ts`,
   `reporting.ts`). Reasons, in order of weight:

   1. The masked 500 is **by design the only exit with no diagnostic surface** — generic body, the
      provider's message deliberately discarded. Without a log a production failure is invisible;
      Workers logs (`wrangler tail`) are the only place it can surface.
   2. `index.ts` is the closest sibling — same folder, same resource, same anon client, same mask
      copy — and its own header says the read endpoint was shaped so S-03 could reuse it.
   3. `reportEvent` is **not** the right seam: it is scoped to event families with a stable search
      key (budget thresholds, unsupported features). Ordinary "X failed:" diagnostics use raw
      `console.error` throughout.

   **Test consequence.** §6.1 forbids asserting log copy (*"do not assert the marker strings — they
   are log copy, not a contract any consumer reads"*). The hermetic suite therefore spies with
   `vi.spyOn(console, "error")` in `beforeEach` to keep a green run readable, and asserts only **that
   it was called** on the 500 case — never its text. That pins "the failure is observable" without
   pinning wording.

   **Follow-up, deliberately not in this slice:** `account/delete.ts` is now demonstrably the outlier
   and its stated justification is stale. Adding a log there is a separate one-line change against
   `delete-account`, not scope for S-03.

2. **`20260723130000:147-149` was already wrong — RESOLVED 2026-09-06, corrected by a migration.**
   It says settled-with-no-summary is a state *"which only an operator-side `settle_reservation()`
   produces."* Follow-up reading found that claim was **already false before this slice**:
   `charge_failed_transcript` (`20260731110000`) writes exactly that shape for a charged refusal and
   documents it in its own header — *"Both are settled rows with no summary, and `begin_generation`
   classifies both as 'unavailable'"* (`:35-41`), with `refusal_reason` as the distinguishing column.
   A user deletion is therefore the **third** producer, not the second, and in production the
   commonest of the three. (My first pass through this said "second"; the correction matters because
   it changes what the fixed comment has to enumerate.)

   The endpoint behaviour is unaffected and correct for all three (`'unavailable'` → clean 409). Only
   the causal claim was wrong — and because that comment is diagnostic guidance, a wrong one sends an
   operator debugging a 409 hunting for a manual settle that never happened.

   Fixed by `supabase/migrations/20260906170000_begin_generation_comment.sql` (user decision at plan
   review; the push+deploy window was accepted). Comments inside `as $$ … $$` live in
   `pg_proc.prosrc`, so `create or replace function` is the only mechanism — `comment on function`
   would leave the misleading text in the body, where `\sf` shows it. The body was generated by
   extracting `20260723130000:78-205` and applying one replacement, never retyped; `diff` shows
   exactly one hunk. Verified applied: `prosecdef` true, `search_path=''`, identity arguments
   unchanged, EXECUTE for `service_role` only, and the full integration suite green (83 tests).

3. **The `useRef` tombstone race (plan-review F3) has no automated oracle.** It is covered only by
   manual item 3.12, because no state-transition seam is extracted. Accepted at this slice's size;
   recorded so a future UI-testing phase knows where the gap is.

### 9. Why confirmation does not transfer from account deletion

`delete-account/reviews/impl-review.md:29` reads: *"the irreversible endpoint does not enforce **the
product's** accidental-deletion guard against a direct or future same-origin caller."* The guard is a
re-entered **email address** — proof independent of the request, protecting every row the account
owns; its own blind-spot note calls it *"an accidental-deletion guard rather than identity
re-verification."* FR-007 specifies no such guard, and the only value a card could echo back is the
summary id it just sent. The finding is scoped to a product-specified guard that exists for account
erasure and does not exist for a single summary. (Applied to `plan.md` as plan-review F7.)

## Code References

- `context/foundation/prd.md:36-37` — privacy guardrail
- `context/foundation/prd.md:67-68` — FR-007
- `context/foundation/prd.md:70-73` — NFR privacy
- `context/foundation/prd.md:90-92` — multi-tenant access control
- `README.md:259` — credit rules; manual-only refills
- `supabase/migrations/20260723120000_atomic_persist_summary.sql:13-15,21-22` — case 2
- `supabase/migrations/20260722120000_link_summary_to_reservation.sql:25-35` — FK cascade direction
- `supabase/migrations/20260722120000_link_summary_to_reservation.sql:59-66,86-88` — reconcile scope
- `supabase/migrations/20260723130000_idempotent_generation.sql:146-152` — settled-with-no-summary
- `supabase/migrations/20260613145120_videos_and_summaries.sql:61-63` — the DELETE policy
- `supabase/migrations/20260731130000_summaries_single_writer.sql:18-20,27,31` — revoke-then-grant
- `src/test/authorization-invariants.int.test.ts:90` — roster already records `DELETE`
- `src/test/cross-account-policy.int.test.ts:129-147,158-172,233-263` — seed, disposal, DELETE probe
- `src/test/synthetic-account.ts:9-13,28-44` — account contract; do not seed the balance
- `src/test/db-owner.ts:22` — `getDbOwnerConnection()`
- `src/lib/services/__fixtures__/supabase-stub.ts:12-22,33-37` — three-world discipline
- `src/pages/api/summaries/__fixtures__/generation-harness.ts:261-280,333-356` — the two gaps
- `src/pages/api/summaries/index.ts:37-41` — masks and logs
- `src/pages/api/account/delete.ts:48-52` — masks, does not log
- `context/foundation/test-plan.md` §2 risks #1/#4/#5/#6, §6.1, §6.2, §6.3, §7

## Architecture Insights

- **The schema documents its own future.** This slice's headline invariant was written into a
  migration header in July, naming the very policy that would enable the feature. Reading migration
  headers as first-class oracle sources — not just SQL — is what made the credit property assertable
  without touching the implementation.
- **Denial lives at two layers, and the tests must not conflate them.** Client-readable tables are
  denied per-row by an owner-scoped policy; internal tables are denied at the *privilege* layer
  (`revoke all`), strictly stronger because RLS is never consulted. `summaries` is the first kind, so
  its delete test is behavioural; a roster change would have been the second kind.
- **Every "defence in depth" filter is a potential test blindfold.** §6.3 rule 3 and risk #4's
  anti-pattern are the same insight from two directions: `listSummaries`' `.eq("user_id", …)` is
  correct in production and disqualifying in a probe. The plan's "no `user_id` predicate in the
  service" decision is the production-side expression of the same idea.
- **A roadmap Status paragraph is not a decision record.** S-03's nine "decisions" are a summary of
  the plan. Only the ones the roadmap tags with an external source — here, "(user constraint)" on the
  credit rule — carry oracle weight.

## Historical Context (from prior changes)

- `context/changes/delete-account/plan.md:93-99` — the exit-ladder shape this endpoint mirrors.
- `context/changes/delete-account/reviews/impl-review.md:23-35` — server-side confirmation (scoped to
  account erasure; §9) — and `:51-59` — the masking-without-logging decision.
- `context/changes/delete-account/reviews/plan-review.md:42-44` — CSRF via Astro `security.checkOrigin`.
- `context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:72-76` — the prior
  manual cross-account check that disclaims itself for filtering by `user_id`; origin of §6.3 rule 3.
- `context/changes/testing-phase-3-data-boundary/` — produced both data-boundary layers and the
  cloud/local default-privilege divergence recorded in §6.3.

## Related Research

- `context/changes/testing-phase-3-data-boundary/research.md` §5, §9 — default privileges; why the
  new-table property cannot be proven behaviourally.
- `context/changes/persist-time-and-cost/reviews/manual-verification.md` — the reconciliation practice
  that established "measure the vendor, don't recompute it", the same discipline applied here to the
  balance.

## Open Questions

See §8 — three; the first (does the masked 500 log?) was **resolved on 2026-09-06**: it logs,
mirroring `index.ts:40`. The remaining two are documentation notes, neither blocking.
