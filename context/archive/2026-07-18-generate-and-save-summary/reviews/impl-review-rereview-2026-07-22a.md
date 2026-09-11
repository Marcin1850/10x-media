<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Generate and Save a Video Summary (S-01)

- **Plan**: `context/changes/generate-and-save-summary/plan.md`
- **Scope**: Phases 1–7 of 8 and all post-review fixes through `80ee896`; deploy-gated Phase 8 excluded
- **Date**: 2026-07-22
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Verification

| Check | Result |
|-------|--------|
| `npm.cmd run lint` | PASS |
| `npm.cmd run build` | PASS |
| `npx.cmd supabase migration up` | PASS — no pending local migrations |
| No stale `summaries/probe` references under `src/` | PASS |
| `git diff --check 4f48536^..HEAD` | PASS |
| `npm.cmd audit --offline --json` | PASS — 0 known vulnerabilities |

For Phases 1–7, all 17 automated/recorded Progress items are checked and 16 manual acceptance items remain unchecked. The pending manual matrix is the already accepted F15 release gate and is not duplicated as a new finding. Phase 8 remains correctly excluded because its production-deployment precondition and all of its Progress items are pending.

## Findings

> **Finding IDs continue from the three earlier implementation reviews.** `impl-review.md` contains F1–F8, `impl-review-rereview-2026-07-20.md` contains F9–F15, and `impl-review-rereview-2026-07-22.md` contains F16–F21, so this report begins at **F22**. Resolved earlier findings are not repeated unless current HEAD creates a distinct residual failure mode.

### F22 — Generation retries are not idempotent

- **Severity**: ⚠️ WARNING
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality / Architecture
- **Location**: `src/pages/api/summaries/generate.ts:21`; `src/pages/api/summaries/generate.ts:248`; `src/pages/api/summaries/generate.ts:282`; `src/components/summaries/GenerateSummaryForm.tsx:123`
- **Detail**: The request has no operation or idempotency key. Every accepted POST opens a new reservation, calls the LLM, and appends a new summary. If the server saves and settles but the `200` response is lost, the client reports a network error and invites a retry; after the generation lease is released, that retry is a new operation that can charge the user and save the same summary again. Reservation transitions are idempotent only within one reservation and do not deduplicate the user-visible generation. This is distinct from F9/F16/F18: those fixes make one attempt recoverable and keep a paid response visible, but do not make an ambiguous HTTP retry safe.
- **Fix**: Add a client-generated request UUID with a per-user unique database identity and durable operation states (`in_progress`, `succeeded`, `failed`); replay the terminal result for a repeated key instead of starting another provider call/reservation.
  - Strength: Makes ambiguous network retries safe across Worker isolates and prevents duplicate charges, summaries, and provider spend.
  - Tradeoff: Requires a forward migration and coordinated client, endpoint, reservation, persistence, and response-replay changes.
  - Confidence: HIGH — no current request field or database uniqueness constraint identifies two POSTs as the same user operation.
  - Blind spot: The retention window and behavior for a retry whose original operation is still running need a product decision.
- **Decision**: FIXED — new migration `20260723130000_idempotent_generation.sql` (expand-only) adds `credit_reservations.request_id` plus a partial unique index on `(user_id, request_id) where request_id is not null and status <> 'refunded'`, and a service-role-only `begin_generation(target_user, request, amount)` RPC that supersedes `reserve_credits()` on the generate path. It locks any prior attempt on the key `for update` and returns `reserved` / `fresh` / `replay` / `in_progress` / `unavailable` / `insufficient`. The key rides on the reservation rather than a new operations table because 20260722120000 already links a reservation to the summary it produced, so replay is `request_id -> reservation -> summary` with no second copy of the content. A NULL `amount` means PROBE: `generate.ts` asks the identity question *before* the paid Supadata fetch (cost is unknown until the transcript exists, so deferring to the debit would pay for a transcript it then discards) and again atomically at the debit, which is what actually decides — the probe is an early exit on a possibly-stale read. `respondToRepeatedRequest()` maps the three repeat outcomes to a 200 replay / 429 / 409. `requestId` is an optional `z.uuid()` and a NULL key skips deduplication entirely, so a cached pre-F22 client still works. `GenerateSummaryForm.tsx` holds the key in a ref keyed by `url+character`, and keeps it across a **network error only** — the sole ambiguous outcome — clearing it on any HTTP response. **Blind spot resolved**: retry-while-running → `429` (backstops the lease across isolates); retention needs no new policy, since the key is a column on a row that already lives for the account's lifetime and the client discards it on any response. `refundReservation`/`reserveCredits` unchanged; `reserve_credits()` is dropped with the other legacy functions in the Phase 8 contract migration. Verified locally: migration applied; 13-case psql smoke test (fresh / reserve / in-flight probe / duplicate debit / persist / **replay after delivery** / full retry with no second charge or second summary row / refund-releases-key / keyless drop-in / actual-balance on insufficient / operator-settled `unavailable` / keyless-probe raises / grants service_role-only) all correct; lint + build pass.

### F23 — Reconciliation can refund work that is still in flight or was delivered

- **Severity**: ⚠️ WARNING
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality / Architecture
- **Location**: `supabase/migrations/20260722120000_link_summary_to_reservation.sql:57`; `src/lib/services/summaries.ts:171`; `src/pages/api/summaries/generate.ts:280`; `supabase/migrations/20260613145120_videos_and_summaries.sql:61`
- **Detail**: `reconcile_reservation()` locks the reservation and treats the absence of a linked summary at that instant as proof that work failed. Summary insertion and settlement are separate later calls, and the LLM call has no explicit deadline, so the documented one-hour sweep can refund an aged request that is still in flight; the later summary insert still accepts the now-`refunded` reservation because the foreign key validates identity/ownership, not status. The linked summary is also mutable evidence: authenticated owners may delete summaries under existing RLS, so a delivered-but-unsettled summary can disappear before reconciliation and be misclassified. The F16 link distinguishes many cases, but it is not atomic or immutable delivery evidence.
- **Fix**: Replace the separate summary insert and settle calls with one service-role-only transaction/RPC that locks a `reserved` reservation, upserts the video, inserts the linked summary, and marks the reservation `settled`; keep reconciliation based on the immutable ledger state and add an explicit external-call deadline below the reconciliation age.
  - Strength: Makes persistence and charge settlement atomic; SQL rollback leaves a genuinely unresolved reservation, while later summary deletion cannot rewrite the billing outcome.
  - Tradeoff: Moves persistence behind a privileged RPC and requires a forward migration plus service/endpoint changes.
  - Confidence: HIGH — current persistence and settlement are separate transactions, and the existing summary DELETE policy is explicit.
  - Blind spot: Existing `reserved` rows still need a one-time classification policy during rollout.
- **Decision**: FIXED — new migration `20260723120000_atomic_persist_summary.sql` adds a service-role-only `persist_summary()` RPC that locks the reservation `for update`, upserts the video, inserts the linked summary, and marks the reservation `settled` in ONE transaction, returning `persisted` / `already_persisted` (replay) / `not_reserved`. `summaries.ts` replaces `upsertVideoAndAppendSummary` with `persistSummaryAndSettle` (admin client, discriminated `ok` result); `generate.ts` drops the separate best-effort settle and fails closed on `not_reserved`; the now-dead `settleReservation` wrapper is removed from `credits.ts` (the `settle_reservation()` RPC stays as an operator recovery tool). `llm.ts` adds an explicit `AbortSignal.timeout(300_000)` deadline on the OpenRouter call — chosen to sit under the 600s generation-lease stale window given the transcript poll's ~240s worst case, and far below the 1-hour sweep. `reconcile_reservation()` deliberately left unchanged so it still classifies rows written by the pre-F23 Worker during the expand-only rollout, which is why the blind spot needs no one-time pass. Verified locally: migration applied; six-case psql smoke test (persist / replay / refunded / unknown / append-second-summary / reconcile-noop) all correct; grants confirmed service_role-only; lint + build pass.

### F24 — Expired transcript quotes retain transcript bodies indefinitely

- **Severity**: ⚠️ WARNING
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260722130000_transcript_spend_guards.sql:77`; `supabase/migrations/20260722130000_transcript_spend_guards.sql:94`; `src/lib/services/transcript-guard.ts:60`
- **Detail**: `expires_at` only prevents stale quote reads. `get_transcript_quote()` deletes an expired row only for the exact user/video/character key requested again; a key never requested again remains forever. Every distinct long video can therefore retain up to 200,000 transcript characters beyond the intended ten-minute lifetime, with no scheduled or bounded global consumer for `transcript_quotes_expires_idx`. Account deletion eventually cascades the rows, but storage and third-party transcript retention are otherwise unbounded per account.
- **Fix**: Consume/delete a quote after a confirmed use and add bounded global pruning by `expires_at` on a regular traffic path or scheduled job, with an explicit retention contract.
  - Strength: Makes the ten-minute TTL a real data lifecycle instead of only a read filter and bounds retained transcript content.
  - Tradeoff: Consumption must preserve safe retry behavior, and scheduled cleanup adds operational configuration if opportunistic pruning is insufficient.
  - Confidence: HIGH — the only current DELETE predicate targets the exact lookup key.
  - Blind spot: Expected long-video volume and whether Supabase scheduling is enabled have not been measured.
- **Decision**: FIXED — re-verified against HEAD first: F22/F23 touch neither `transcript_quotes` nor its callers, so the leak was unchanged. New migration `20260723140000_transcript_quote_lifecycle.sql` (expand-only) establishes an explicit four-rule retention contract: a quote dies at the earliest of (1) **consumed** — the generation that used it committed, so `generate.ts` calls the new service-role-only `discard_transcript_quote()` right after `persisted.ok`; (2) **superseded** — the existing exact-key expired delete; (3) **pruned** — the new bounded `prune_transcript_quotes(max_rows default 100)` (`order by expires_at … limit … for update skip locked`, driven off the previously unused `transcript_quotes_expires_idx`) now called from *both* `save_transcript_quote()` and `get_transcript_quote()`; (4) **cascaded** — account deletion. Rule 3 is what makes the table self-limiting with no operational dependency: rows are created *only* by `save_transcript_quote`, and every such call drains up to 100 expired rows, so creation cannot outpace removal — the blind spot about unmeasured volume and pg_cron availability is therefore moot (the function is granted to `service_role` so pg_cron *may* call it, but nothing requires it). Consumption deliberately does **not** happen at read time: a consuming `get` would make a confirmation retry that then fails downstream re-pay Supadata for the transcript F17 cached to avoid — so the discard sits on the success path only, guarded on `allowLong` (the sole path that can have written a quote). Signatures, return types, and result semantics of the two replaced functions are unchanged, so the deployed pre-F24 Worker keeps working (its rows just leave via rules 2–4). Verified locally: migration applied; 12-case psql smoke test (save→get / read does **not** consume / discard removes key / missing-key discard is a silent no-op / **abandoned never-revisited expired row drained by an unrelated later save** / live row untouched / prune bounded at max_rows and reports its count / read-path prune drains backlog / expired-key get returns nothing / non-positive limit no-op / null user raises / grants service_role-only) all correct; lint + build pass.

### F25 — Accepted post-review architecture is stale in the reviewed phase contracts

- **Severity**: ⚠️ WARNING
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `context/changes/generate-and-save-summary/plan.md:53`; `context/changes/generate-and-save-summary/plan.md:172`; `context/changes/generate-and-save-summary/plan.md:253`; `context/changes/generate-and-save-summary/plan.md:334`; `context/changes/generate-and-save-summary/plan-brief.md:22`
- **Detail**: Accepted fixes are documented in later amendments and implemented, but the load-bearing phase contracts still prescribe bare `spendCredit`/`refundCredits`, accept a double transcript fetch, and describe plain `whitespace-pre-wrap` output. `plan-brief.md` is more materially stale: it still makes Markdown and F-01 schema changes out of scope, says refund failure can leave a debit with no durable recovery, and says Phase 8 drops only `spend_credit()`. Current HEAD instead uses a reservation ledger plus summary link/reconciliation, owner-scoped leases, transcript rate limiting and quote reuse, Markdown allow-list rendering, `summaries.reservation_id`, and a five-RPC contract drop. The same handoff therefore gives contradictory implementation and release instructions.
- **Fix**: Synchronize Critical Details, affected Phase 2/4/5/6 contracts, Migration Notes, and `plan-brief.md` with the accepted amendments; preserve superseded behavior only in clearly labeled historical notes.
  - Strength: Restores one coherent source of truth for implementation, Phase 8 deployment, future reviews, and handoff.
  - Tradeoff: Requires careful documentation edits across the full and compressed plans so history is retained without remaining normative.
  - Confidence: HIGH — the contradictions are direct and current implementation names different RPCs, persistence guarantees, rendering, and contract-drop scope.
  - Blind spot: None significant.
- **Decision**: FIXED — `plan.md` and `plan-brief.md` resynchronized with the accepted amendments; superseded text is retained but explicitly labeled so it is no longer normative. **`plan.md`**: a dated amendment banner opens *Critical Implementation Details*, whose bullets now describe the live contract (nine expand-only migrations; owner-scoped generation lease; `begin_generation` reservation debit; `persist_summary` atomic persist+settle plus the 300s `summarize` deadline; idempotent retries; transcript rate cap + quote lifecycle; empty-transcript 422; Markdown allow-list), each carrying a labeled *Superseded* line for the behavior it replaced. Phase 2 keeps its shipped SQL as an immutable historical record under an amendment note and gains a "Contract (current)" block for `credits.ts` (`getBalance`/`reserveCredits`/`beginGeneration`/`refundReservation`, no `settleReservation`) and the `AppDatabase` Functions map. Phase 4's flow is split into "superseded" and a 0–10 step "current" contract matching `generate.ts` exactly. Phase 5 gains the F17/F24 quote-cache amendment. Phase 6's `whitespace-pre-wrap` bullet is struck through in favor of the F2 allow-list + F18 paid-result handling, plus a four-item amendment covering the F11 stale-response discard, the F22 key, F20 inline URL validation, and the three distinct 429 causes (pointing at F26 as still open). *What We're NOT Doing* records `summaries.reservation_id` as an added — not altered — column. Migration Notes expand from 4 to 9 entries. **Phase 8 is widened from five drops to six**: F22 left `reserve_credits(integer)` with no caller, and it is the one drop with live code behind it, so the phase now also deletes the dead `reserveCredits` wrapper and its type entries; `settle_reservation`/`reconcile_reservation` are explicitly *retained* as operator recovery tools, and 8.4/8.7 in Progress follow. Post-review test scenarios extend from 17 to 24 (F16 reconciliation, F17 rate cap and quote reuse, F23 atomic persist and LLM deadline, F22 idempotent retry, F24 quote lifecycle). Performance Considerations drops the stale double-fetch tradeoff and names the real latency bounds. **`plan-brief.md`**: resync banner; Key Decisions grows from 3 stale rows to 9 accurate ones (debit RPC, persistence, refund privilege, concurrency, provider-spend guards, migration strategy, rendering); Scope now states the two reversed exclusions (Markdown, `reservation_id`) explicitly instead of listing them as out of scope; the architecture flow is rewritten to the real 0–9 pipeline; Phases at a Glance corrects Phase 8's scope and notes that F1–F24 landed as fixes rather than phases; Open Risks replaces "refund is best-effort / debit may stand" with the durable-ledger reality and adds the unbounded-length cost vector and the pending manual-acceptance gate.

### F26 — Transcript rate-limit responses are mislabeled as lock contention

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence / Success Criteria
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:66`; `src/pages/api/summaries/generate.ts:177`
- **Detail**: The endpoint now returns `429` both for an active generation lease and for the ten-minute transcript-attempt cap, with distinct server messages. `messageForStatus()` ignores `serverError` for every `429` and always says another summary is being generated. A rate-limited user is therefore told to wait for nonexistent work and is not told about the cooldown, weakening the clear-error contract and encouraging immediate retries.
- **Fix**: For `429`, return `serverError` when present and keep the lock-contention message only as the fallback (or introduce stable error codes if the two cases need client-owned copy).
- **Decision**: FIXED — `messageForStatus()` now returns `serverError ?? "A summary is already being generated…"` for `429`, matching the existing `500`/`400` precedence where the server's specific message wins and the hard-coded copy is only a non-JSON fallback. HEAD has **three** distinct `429` causes, not two: the owner-scoped generation lease (`generate.ts:93`), the F22 idempotency `inProgress` backstop (`generate.ts:156`), and the F17 transcript rate cap (`generate.ts:252`) — each already sends its own message, so the client change alone makes all three read correctly, including the cooldown wording the rate-limited user was never shown. Stable error codes were not introduced: no `429` copy is client-owned (none needs client-side interpolation the way `402`/`409` do), so a code table would add a mapping layer with nothing to map. Verified: lint + build pass.
