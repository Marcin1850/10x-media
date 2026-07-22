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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

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
- **Decision**: PENDING

### F26 — Transcript rate-limit responses are mislabeled as lock contention

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence / Success Criteria
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:66`; `src/pages/api/summaries/generate.ts:177`
- **Detail**: The endpoint now returns `429` both for an active generation lease and for the ten-minute transcript-attempt cap, with distinct server messages. `messageForStatus()` ignores `serverError` for every `429` and always says another summary is being generated. A rate-limited user is therefore told to wait for nonexistent work and is not told about the cooldown, weakening the clear-error contract and encouraging immediate retries.
- **Fix**: For `429`, return `serverError` when present and keep the lock-contention message only as the fallback (or introduce stable error codes if the two cases need client-owned copy).
- **Decision**: PENDING
