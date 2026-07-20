<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Generate and Save a Video Summary (S-01)

- **Plan**: `context/changes/generate-and-save-summary/plan.md`
- **Scope**: Phases 1-7 of 8, including post-review fixes `5a02074` and `70d3cbb`
- **Date**: 2026-07-20
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
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
| `npx.cmd supabase migration up` | PASS - no pending local migrations |
| No stale `summaries/probe` references under `src/` | PASS |
| `npm.cmd audit --offline --json` | PASS - 0 known vulnerabilities |

For Phases 1-7, 17 automated/manual Progress items are checked and 16 manual acceptance items remain unchecked. Phase 7's prompt-quality check is the only manual criterion recorded complete. Phase 8 is correctly excluded because its production-deployment gate remains pending.

## Findings

### F1 - Failed-work credit compensation is still not durable

- **Severity**: ! WARNING
- **Impact**: H HIGH - architectural stakes; think carefully before deciding
- **Dimension**: Plan Adherence
- **Location**: `src/lib/services/credits.ts:73`; `src/pages/api/summaries/generate.ts:206`; `supabase/migrations/20260719120000_spend_credits_variable.sql:42`
- **Detail**: The F3 fix closes only the missing-admin-key case. `refund_credits` is still an unconditional increment with no reservation identity; `refundCredits` returns `false` on an RPC failure, but both endpoint call sites ignore the result and return the normal 500/502. A transient or ambiguous post-debit failure can therefore leave the user charged, contradicting the plan's "failed work never charges the user" invariant. Retrying manual reconciliation after an ambiguous response can also over-credit because refunds are not idempotent.
- **Fix * Recommended**: Introduce a durable generation/reservation ledger keyed by an idempotency key, with atomic/idempotent debit, finalize, and refund transitions plus reconciliation.
  - Strength: Makes compensation recoverable and prevents duplicate refunds/charges across retries and ambiguous network outcomes.
  - Tradeoff: Requires a forward migration and coordinated endpoint/service changes.
  - Confidence: HIGH - the current boolean/log path records failure but cannot repair or safely replay it.
  - Blind spot: The desired reconciliation worker/operator workflow and retention period are not yet specified.
- **Decision**: PENDING

### F2 - Stale lock recovery can release a newer request's lock

- **Severity**: ! WARNING
- **Impact**: M MEDIUM - real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: `supabase/migrations/20260720133000_generation_locks.sql:34`; `src/pages/api/summaries/generate.ts:94`
- **Detail**: Lock rows are identified only by `user_id`. After 600 seconds, request B may delete request A's row and acquire a replacement; if A later reaches `finally`, `release_generation_lock(user_id)` deletes B's row, allowing request C to overlap B. The migration says a ten-minute lock is certainly abandoned, but `generateText` has no explicit timeout and `transcript.ts:11` explicitly documents no Worker wall-clock request limit. This reopens the paid-work amplification the F4 fix was meant to close.
- **Fix * Recommended**: Add an opaque lock/lease ID returned by acquire and require both `user_id` and that ID for release; add bounded external-call deadlines or lease renewal as appropriate.
  - Strength: An old request can no longer release a successor's lock, even after a stale takeover.
  - Tradeoff: Requires a forward migration plus RPC/service/endpoint contract changes.
  - Confidence: HIGH - ownerless release creates the race directly.
  - Blind spot: Real production generation duration has not been measured, so the best lease duration remains empirical.
- **Decision**: PENDING

### F3 - The confirmation fix still has an in-flight stale-response race

- **Severity**: ! WARNING
- **Impact**: M MEDIUM - real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/components/summaries/GenerateSummaryForm.tsx:98`
- **Detail**: URL and character handlers clear an existing quote, but the controls remain editable while a request is loading. A user can submit video A, change the inputs to B, then receive A's late 409. That response installs a `ConfirmState` containing only cost/length; "Generate anyway" then submits the current B inputs with `allowLong: true`. The endpoint prices B correctly, but B was never shown its own confirmation, so the F6 consent gap remains.
- **Fix A * Recommended**: Bind the quote to the immutable submitted URL/character (or a server-issued quote token) and discard/abort responses whose input snapshot is no longer current.
  - Strength: Preserves editable controls while making authorization explicitly match the quoted request.
  - Tradeoff: Adds request identity/snapshot state.
  - Confidence: HIGH - it closes both the known handler gap and late-response races.
  - Blind spot: A server-issued token would additionally need expiry and tamper-proofing decisions.
- **Fix B**: Disable every quote-relevant control while generation is loading.
  - Strength: Smaller state model and easy to reason about.
  - Tradeoff: The user cannot edit the form during a potentially long transcript request; `FormField` needs disabled-state support.
  - Confidence: HIGH - no input mutation means the late 409 still matches the displayed inputs.
  - Blind spot: Future programmatic input changes must also respect the lockout.
- **Decision**: PENDING

### F4 - Plan and README contracts remain stale after the fixes

- **Severity**: ! WARNING
- **Impact**: L LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `context/changes/generate-and-save-summary/plan.md:333`; `README.md:109`
- **Detail**: The plan still says a null balance disables submission, despite the accepted F5 behavior. README says the service-role key is for account deletion/operator scripts, says it has "two" consumers before listing three, says every successful summary costs one credit, and later says the rest of the app works without the key even though generation returns 503. These are direct contradictions of the shipped variable-cost and preflight behavior.
- **Fix**: Update the Phase 6 contract and consolidate README service-role/credit documentation around the shipped three-consumer, 1-or-2-credit behavior.
- **Decision**: PENDING

### F5 - Empty transcript strings can be summarized and charged

- **Severity**: i OBSERVATION
- **Impact**: L LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.ts:148`; `src/lib/services/transcript.ts:36`
- **Detail**: The transcript service accepts any string, including whitespace/empty content, as `ok: true`. The endpoint checks only `transcript.ok`, prices the empty content at one credit, and calls the LLM. A generic non-empty model response could then be persisted and charged despite the no-transcript contract.
- **Fix**: Treat `transcript.content.trim().length === 0` as unavailable and return 422 before cost/debit.
- **Decision**: PENDING

### F6 - Pre-save infrastructure failures use an unstable or misleading 500 path

- **Severity**: i OBSERVATION
- **Impact**: L LOW - quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/pages/api/summaries/generate.ts:68`; `src/pages/api/summaries/generate.ts:133`; `src/components/summaries/GenerateSummaryForm.tsx:70`
- **Detail**: Lock acquisition failure returns 500 before any save, while a rejected initial `getBalance` call escapes the endpoint's JSON response contract. The client maps every 500 to "Something went wrong saving your summary," which is inaccurate for both failures and can hide a non-JSON framework response.
- **Fix**: Catch/log the initial balance failure and return stable structured error codes/messages; map preflight/infrastructure failures separately from persistence failures in the client.
- **Decision**: PENDING

### F7 - Manual acceptance evidence remains pending after behavior-changing fixes

- **Severity**: i OBSERVATION
- **Impact**: M MEDIUM - real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `context/changes/generate-and-save-summary/plan.md:501`
- **Detail**: All automated gates pass, but 16 Phase 1-7 manual checks remain unchecked. The post-review changes also need targeted checks for the Markdown allow-list, unknown balance, 429 lock contention, stale-lock takeover/ownership, confirmation changes during an in-flight request, and refund-failure handling. Existing local lock checks recorded in the prior report do not replace the Progress section's canonical manual evidence.
- **Fix * Recommended**: Run the pending manual matrix against the amended build and record evidence, adding the new post-review scenarios to the change documentation before release acceptance.
  - Strength: Validates the external-service, browser, permission, consent, and compensation paths static review cannot prove.
  - Tradeoff: Requires authenticated fixtures, controlled balances/keys, long/empty/no-transcript cases, concurrent requests, and two browsers.
  - Confidence: HIGH - the pending rows and newly changed behavior are directly observable.
  - Blind spot: This review did not mutate production data or intentionally break live credentials to manufacture evidence.
- **Decision**: PENDING
