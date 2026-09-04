# Paid-path integration tests — Implementation Plan

## Overview

Build the two-layer test net for the summary-generation request path: a **real local Supabase** layer that proves the money invariants (a failed generation leaves the user whole), and a **stubbed-client** layer that proves everything the ledger's arithmetic is not needed for (refusal exits, the vendor budget breaker, spend reconciliation). Paid vendors are faked at the `fetch` boundary and at the `llm.ts` module boundary. **No production code changes.**

Covers test-plan risks #1 (credits spent without delivery), #2 (derived spend drifts from the vendor's), #3 (budget exhaustion degrades instead of refusing cleanly), #5 (a crafted request drives the paid pipeline for free).

## Current State Analysis

`npm test` is the CI entry point and is deliberately env-less — its own comment in `.github/workflows/ci.yml` records that "nothing in the suite reaches Supabase, Supadata or OpenRouter." Three unit test files exist (`generate-summary.test.ts`, `credits.test.ts`, `summaries.test.ts`), all pure or hermetic against `__fixtures__/supabase-stub.ts`. There is **no test infrastructure for the paid-vendor HTTP boundary at all**, and no test touches an HTTP endpoint.

The generation endpoint has 35 terminating exits. Six charge, two charge-then-refund, one 422 deliberately does not charge, and one — exit #34 — returns 500 without touching the balance in three materially different situations that the code cannot tell apart.

`research.md` established the enabling fact empirically: `generate.ts` is reachable from Vitest under the existing plain `vitest/config` once `astro:env/server` resolves to a stub module. `vi.mock` on the two client-constructor modules reaches the RPC layer. Neither requires `getViteConfig()` nor a production refactor.

## Desired End State

Two runner projects. `npm test` keeps its current meaning and speed — unit only, no infrastructure. `npm run test:integration` runs the new layer against a local Supabase stack. A parallel `integration` job in CI gates `deploy` alongside `ci`. The five stale records that testable rules are read from state what the code actually does. `test-plan.md` §6.2 stops saying "TBD".

Verified by: both suites green locally and in CI; the `globalSetup` guard aborting when pointed at a non-localhost database; `test-plan.md` §3 Phase 2 reading `complete`.

### Key Discoveries

- **One alias unlocks the endpoint** — `resolve.alias` for `astro:env/server`; no adapter conflict arises because a plain `vitest/config` never loads `astro.config.mjs` (`research.md` §2.2).
- **`POST` needs only three things off `APIContext`** — `locals.user`, `request`, `cookies` (`generate.ts:123,127,138`).
- **`createClient` reads the `Cookie` header, not an `AstroCookies` object** (`src/lib/supabase.ts:11-14`) — a real session reaches the handler as a header string.
- **Both 503 preflights run before the 401** (`generate.ts:110-125`). With keys unset every exit collapses to 503, so a suite would silently assert nothing.
- **`on_auth_user_created` seeds 5 credits** (`20260712175240_user_credits.sql:36`); deleting the account cascades everything per-user **except `supadata_calls`**, which is `on delete set null` (`20260728120000:97`) and leaves orphans.
- **A cache hit bypasses the breaker entirely** (D5) — seeding `transcript_cache` keeps the singleton untouched.
- **`BUDGET_STOP_RESERVE = 3`** (`supadata-budget.ts:73`), unrelated to `LONG_TRANSCRIPT_CHARS = 40000` (`summaries.ts:159`). Two budgets, two units.
- **All four Supadata calls go through the global `fetch`** — `@supadata/js` is a types-only dependency now.

## What We're NOT Doing

- **No production code changes.** Not extracting `runGeneration`, not adding `fetchImpl` parameters, not changing `summarize`'s signature. The spike proved none of it is needed for reachability.
- **No live vendor contact, ever** — including the free `GET /v1/me`. Reconciliation runs against recorded fixtures, with the cost of that stated in §7.
- **Not fixing exit #34.** All three branches are pinned, not endorsed. A fix would have to branch on `persisted.reason` — an unconditional refund would double-refund the branch the sweep already reimbursed.
- **No fresh-fetch path against the real database.** Fresh fetches are exercised on the stub layer only, so `transcript_cache` and the budget singleton are out of reach by construction.
- **No second Supabase stack**, locally or in CI.
- **Not covering the Whisper job path** — unreachable under `TRANSCRIPT_MODE = "native"`, and already excluded by test-plan §7.
- **No e2e, no component rendering, no Playwright** — that is Phase 4.

## Implementation Approach

Fix the oracle first, then build the harness, then the cheap layer, then the expensive one, then wire CI. Each phase is independently verifiable, and no phase depends on a later one.

The split between layers is drawn where the isolation hazard is, not where it is convenient: anything needing a **real balance** goes to the real database (per-user tables, cleanup permitted by test-plan §7); anything needing a **forced vendor or budget state** goes to the stub, where no shared row exists to contaminate.

## Critical Implementation Details

**Two guards must exist before the first integration test runs, not after.** The `build` step in the `ci` job uses `secrets.SUPABASE_URL`, which points at production. The integration tests create and delete `auth.users` rows. A copy-paste of those two env lines into the integration job would run account creation and deletion against the production database. `globalSetup` must therefore abort unless `SUPABASE_URL` resolves to loopback — this is the only irreversible failure mode in the phase.

**Ordering inside a test matters more than usual.** `supadata_calls` rows survive account deletion by design (`on delete set null`). Cleanup must delete those rows **by `youtube_id` before** deleting the synthetic account; the reverse order silently orphans them into the ledger that risk #2 sums.

**Every integration test must set all five env keys.** Missing `SUPABASE_SERVICE_ROLE_KEY` alone turns every exit into a 503 that looks like a passing refusal test.

---

## Phase 1: Oracle correction

### Overview

Five records state rules that the code no longer follows. Two of them are what test-plan §6.1 instructs a test author to derive assertions from, so they are fixed before any assertion cites them.

### Changes Required:

#### 1. README credit rules

**File**: `README.md`

**Intent**: The "Summary credits" section documents the credit system without mentioning that a refused submission can charge a credit, and describes the block as happening "at 0 credits" when the real gate is `balance >= cost`. A test author following §6.1 would derive the invariant "credits are only spent on delivered summaries", which is false.

**Contract**: Add the refusal-charge rule (1 credit, four of the five 422 exits, naming the transient `failed`/`timeout` exit as the exemption) and restate the gate so a 1-credit balance against a long video is covered. Do not restructure the section.

#### 2. Roadmap S-09 D14

**File**: `context/foundation/roadmap.md`

**Intent**: D14 still says the charge "ships silently — copy and 422 body unchanged", superseded by S-06 Phase 9, which added `charged`/`ambiguousCharge` to those bodies and rendered them. `test-plan.md:27` quotes the stale sentence verbatim as risk #1's evidence.

**Contract**: Amend D14's body with a dated supersession note pointing at S-06 Phase 9 and `PendingSummaryCard.tsx`. Keep the original text visible as history — the decision was real, only its consequence changed.

#### 3. Roadmap S-05 enforcement model

**File**: `context/foundation/roadmap.md`

**Intent**: S-05's "Enforcement model: spend-on-success … no refund" describes the pre-ledger mechanism, replaced by S-01/S-09 with debit-before-work, refund-on-failure, and charge-on-refusal.

**Contract**: Same supersession-note treatment as D14, pointing at S-01 and S-09.

#### 4. Schema comment on the header's unit

**File**: `supabase/migrations/<timestamp>_billable_credits_comment.sql` (new)

**Intent**: `supadata_calls.billable_credits`'s comment still says the unit is "settled by Phase 5 run 3". It was settled 2026-07-29 as credits. This is the fifth and last instance of that stale claim; the doc and the JSDoc were corrected in `5c20bbe`.

**Contract**: A **comment-only** migration — a single `comment on column public.supadata_calls.billable_credits is …`. No structural change, no data touched.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly against a fresh database: `npx supabase db reset` is **not** used; verify with `npx supabase migration up` on the local stack
- Formatting passes: `npm run format`
- Existing suite still green: `npm test`

#### Manual Verification:

- README's credit section, read cold, would lead a test author to the correct invariant
- D14 and S-05 read as superseded, not as rewritten history

---

## Phase 2: Runner split and guards

### Overview

Split the runner into two projects and build the safety rail before any test that can touch a database exists.

### Changes Required:

#### 1. The `astro:env/server` stub

**File**: `src/test/astro-env-server-stub.ts` (new)

**Intent**: Make the virtual module resolvable outside an Astro build so endpoint modules can be imported, and let each test control the values.

**Contract**: Re-export the five schema keys (`SUPABASE_URL`, `SUPABASE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPADATA_API_KEY`, `OPENROUTER_API_KEY`), each read from `process.env`. Values must be read at module scope, matching how `astro:env/server` behaves in production.

#### 2. Runner projects

**File**: `vitest.config.ts`

**Intent**: Keep `npm test` meaning exactly what it means today while adding a second project that may reach a database.

**Contract**: Convert to `projects`. The `unit` project keeps the current `include: ["src/**/*.test.ts"]` minus the integration pattern; the `integration` project takes the new pattern and the `globalSetup`. Both inherit the `@` alias and the new `astro:env/server` alias — declare them once at the top level, since test-plan §6.6 records that a diverging alias fails at import time with an error that reads nothing like an assertion failure.

#### 3. The guard

**File**: `src/test/integration-setup.ts` (new)

**Intent**: Make the two irreversible mistakes impossible rather than discouraged.

**Contract**: A Vitest `globalSetup` that (a) aborts unless `SUPABASE_URL` resolves to loopback, and (b) aborts if any synthetic `youtube_id` the suite reserves is already present in `transcript_cache` or `metadata_cache`. Both failures must name what to do, not just fail.

#### 4. Scripts and mutation scope

**File**: `package.json`, `stryker.config.json`

**Intent**: Give the new layer its own entry point and keep Stryker off it — mutation testing is scoped to unit-layer risk modules and is explicitly not a CI gate.

**Contract**: Add `test:integration`. Confirm Stryker's `vitest.configFile` still resolves to the unit project only; pin the project explicitly if `projects` changes its resolution.

#### 5. Smoke test

**File**: `src/test/harness.int.test.ts` (new)

**Intent**: Prove the harness before anything depends on it.

**Contract**: Assert the endpoint module imports and exports `POST`, and that the guard rejects a non-loopback `SUPABASE_URL`.

### Success Criteria:

#### Automated Verification:

- Unit project unchanged in scope and still green: `npm test`
- Integration project runs and the smoke test passes: `npm run test:integration`
- Guard fires: running the integration project with a non-loopback `SUPABASE_URL` aborts with the named error
- Types and lint pass: `npm run typecheck` and `npm run lint`

#### Manual Verification:

- `npm test` runtime has not visibly regressed
- Stryker still runs against a unit module without picking up integration files

---

## Phase 3: Vendor fixtures and the `llm.ts` unit test

### Overview

Build the fake vendor surface, and close the coverage gap that mocking `llm.ts` creates.

### Changes Required:

#### 1. Supadata response builders

**File**: `src/lib/services/__fixtures__/supadata-responses.ts` (new)

**Intent**: Represent every vendor response shape the code branches on, including the failure shapes that were actually measured, so tests never hand-roll a `Response`.

**Contract**: Factories returning `Response` objects, following `supabase-stub.ts`'s factory convention. Required shapes: 200 native transcript with `x-billable-requests: 1`; **206 `transcript-unavailable` with no header at all** (measured three times, still billed 1 credit); 524 with no body and no header; a 2xx with a non-JSON content-type; a header that is absent, and one that is malformed (`"1oops"`, `"1.5"`, out of int4 range); 200 metadata; and `GET /v1/me` both well-formed and with unusable figures. Each factory carries a comment citing the measured value and its date from `supadata-billable-requests.md` — the fixture's authority is the measurement, not the code.

#### 2. `summarize` contract test

**File**: `src/lib/services/llm.test.ts` (new)

**Intent**: Because the integration layers mock `llm.ts` wholesale, `summarize`'s own rules are otherwise exercised nowhere — and `usage.cost` is the figure risk #2 reconciles.

**Contract**: Mock `generateText` from the `ai` package. Cover: empty or whitespace-only `text` rejected; `usage` figures read defensively when partially absent; `modelId` surfaced. Do not assert log copy.

### Success Criteria:

#### Automated Verification:

- `npm test` green including the new `llm.test.ts`
- Every fixture factory is referenced by at least one test by the end of Phase 4 (checked then, not here)
- Lint and types pass

#### Manual Verification:

- Each fixture's comment lets a reader re-derive the shape from the vendor doc without reading the code

---

## Phase 4: Stub layer — exits, refusals, breaker, reconciliation

### Overview

Everything provable without a real balance. Fake `fetch` for Supadata, `vi.mock` for `llm.ts` and the two client constructors.

### Changes Required:

#### 1. Trust boundary and preflight exits

**File**: `src/pages/api/summaries/generate.int.test.ts` (new)

**Intent**: Prove the server refuses what the UI would never send (risk #5), and that the preflight ordering is what it is.

**Contract**: Cover the two 503s distinctly (they differ by message and by which key is missing), the 401, and schema rejections: missing/malformed `requestId`, a `character` outside the enum, a non-web URL scheme. Assert `allowLong: true` sent unprompted is pre-authorization — it skips the 409 confirmation but the debit still uses the real cost.

#### 2. Refusal exits and the charged signals

**File**: same

**Intent**: Prove each refusal exit reports its charge honestly — the regression that `ambiguousCharge` was introduced to fix.

**Contract**: All four charging 422 exits (cached `unavailable`, cached `empty`, fresh `unavailable`, whitespace) and the one non-charging transient exit. Assert `charged: true`, `charged: false`, and the ambiguous shape **by its own fields** — `ambiguousCharge: true` with `charged` absent, never as `charged !== true`. Assert `REFUSAL_COPY` selection differs between `unavailable` and the generic reasons.

#### 3. Budget breaker

**File**: `src/lib/services/supadata-budget.int.test.ts` (new)

**Intent**: Risk #3, including the branch the test plan warns is the one that breaks the product.

**Contract**: Force `refused` at the transcript checkpoint (503) and at the metadata checkpoint (must **not** abort — sets `skipped_budget` and persists nulls). Then every fail-open path: RPC error, `uninitialized`, a `/v1/me` that fails, times out, returns non-JSON, or returns unusable figures. Each must proceed with no reservation. Pin `BUDGET_STOP_RESERVE` separately from any assertion that uses it, so a silent retune goes red.

#### 4. Spend reconciliation

**File**: `src/lib/services/supadata-ledger.int.test.ts` (new)

**Intent**: Risk #2, at the only layer that can hold it under the fixtures-only decision.

**Contract**: Drive a mixed batch of outcomes through the endpoint and assert the exact payload handed to `record_supadata_calls`, then sum `billable_credits` from it. The billable 206 must appear as `null`, not `0` — that distinction is what makes a reconciliation gap diagnosable. Head the file with the trade-off: this proves mapping, not agreement with the vendor.

### Success Criteria:

#### Automated Verification:

- `npm run test:integration` green
- No test in this phase opens a database connection
- Every fixture factory from Phase 3 is now referenced
- Lint and types pass

#### Manual Verification:

- Each `describe` block names its oracle source, per §6.1
- Deliberately breaking one refusal exit's `charged` value turns exactly one test red, not a cascade

---

## Phase 5: Real-database layer — balance invariants

### Overview

The claims that only a real balance can settle: after a failed generation, the user is whole.

### Changes Required:

#### 1. Synthetic account harness

**File**: `src/test/synthetic-account.ts` (new)

**Intent**: Create, authenticate, and dispose of a synthetic account so each test starts from a known balance.

**Contract**: Create the user with the admin client (the seed trigger supplies 5 credits — do not set the balance manually, or the test stops proving the documented starting value), sign in to obtain tokens, and expose them as a `Cookie` header string for the request. Disposal deletes `supadata_calls` rows **by synthetic `youtube_id` first**, then deletes the account and lets the cascade do the rest. Every identifier is synthetic; no real address or id is ever written to a file (per `lessons.md`).

#### 2. Charge-versus-delivery invariants

**File**: `src/pages/api/summaries/generate.db.int.test.ts` (new)

**Intent**: Risk #1's core — the balance, read before and after, is the assertion.

**Contract**: Seed `transcript_cache` for the synthetic video so the breaker is bypassed and no fresh fetch occurs. Cover: success debits exactly the documented cost and settles; an LLM failure debits then **restores the balance**; a persistence failure likewise; `insufficient` when the balance is below cost, including the 1-credit-against-a-long-video case the prose omits; replay on the same `requestId` returns the original result and does **not** debit again; a charged refusal replays as `charged: true` without a second charge.

#### 3. Exit #34's three branches, pinned separately

**File**: same

**Intent**: `persistSummaryAndSettle` resolving `ok:false` is a fork, not one outcome. The endpoint returns 500 and leaves the balance alone in all three cases, but what that costs the user differs completely. Pinning them as one assertion would hide exactly the difference worth knowing.

**Contract**: Resolve the reservation out of band mid-flight, three ways, and assert each by its own outcome — never one as the negation of another:

| Branch | Force it by | Assert |
| --- | --- | --- |
| Sweep refunded | `reconcile_reservation` on a row with no linked summary | 500, and the balance is **back at its starting value** — the user is whole |
| Operator settled | `settle_reservation()` by hand | 500, and the balance stays **down** — the genuine charge-without-delivery |
| `already_persisted` | a summary already citing the reservation | 500 **while the work succeeded** — a false failure report, not a lost credit |

Head the test with a note that this **describes** current behaviour rather than endorsing it, and that an unconditional refund here would double-refund the first branch — which is why any fix must branch on `persisted.reason` and is a product decision, not a patch.

### Success Criteria:

#### Automated Verification:

- `npm run test:integration` green against a running local stack
- Row counts in `transcript_cache`, `metadata_cache`, `supadata_calls`, and `supadata_budget` are **identical before and after** a full run
- Lint and types pass

#### Manual Verification:

- A deliberately interrupted run leaves no synthetic account or cache row behind
- The 13 paid transcript rows and the 100/18 budget row are untouched, verified by direct query

---

## Phase 6: CI wiring and the cookbook

### Overview

Make the layer run where it cannot be forgotten, and record what the phase decided.

### Changes Required:

#### 1. The integration job

**File**: `.github/workflows/ci.yml`

**Intent**: Run the new layer in parallel so the PR's wall clock is the max of the two jobs rather than their sum, and make it actually gate deployment.

**Contract**: A new `integration` job on `ubuntu-latest`: checkout, Node 22, `npm ci`, `astro sync`, `supabase/setup-cli`, `supabase start` with non-essential services excluded (only `db`, `auth`, `rest` are needed), then `npm run test:integration`. Env is set **inline** — the local stack's demo keys are fixed and public, and the vendor keys are literal placeholders because `fetch` is stubbed. Change `deploy` to `needs: [ci, integration]`. Do **not** reference `secrets.SUPABASE_URL` in this job.

#### 2. Cookbook and status

**File**: `context/foundation/test-plan.md`

**Intent**: Fill in what the phase learned so the next contributor does not rediscover it.

**Contract**: Write §6.2 (how to add an integration test: which layer, the fixture factories, the oracle rule, the cleanup contract). Add to §7 the fixtures-only trade — reconciliation proves mapping, not vendor agreement, and cannot detect a pricing change or a dropped header. Add a §6.6 note correcting the `astro:env` claim. Move §3 Phase 2 to `complete` and update the freshness ledger.

#### 3. Linear

**Intent**: `lessons.md` requires the board to move in the same session as the status change.

**Contract**: MAR-20 to the matching state with a comment summarizing what landed.

### Success Criteria:

#### Automated Verification:

- A PR against `master` runs both jobs and both pass
- `deploy` does not start when `integration` fails
- `supabase start` succeeds on a clean runner and migrations apply

#### Manual Verification:

- Wall-clock time for a PR has not meaningfully increased
- §6.2 read cold is enough to add a new integration test without re-reading this plan

---

## Testing Strategy

### Unit tests

- `llm.test.ts` — `summarize`'s own contract, the gap created by mocking it elsewhere.

### Integration tests

- **Stub layer**: trust boundary, all refusal exits and their charged signals, breaker trip and every fail-open branch, reconciliation over the ledger payload.
- **Real-database layer**: balance before/after across success, LLM failure, persistence failure, insufficient balance, replay, and exit #34's three branches.

### Manual testing steps

1. Record row counts in the five shared tables, run the full integration suite, re-record — they must match.
2. Point `SUPABASE_URL` at a non-loopback host and confirm the guard aborts.
3. Interrupt a run mid-suite and confirm no synthetic account or cache row survives.

## Performance Considerations

The integration job runs in parallel with `ci`, so it adds to wall clock only if it exceeds the existing job. `supabase start` excludes every service the tests do not use. If startup proves to dominate, the fallback is to cache Docker images in the runner — not to move the layer out of CI.

## Migration Notes

One new migration, comment-only. It changes no structure and touches no data, so it is safe to apply to a database holding the paid local dataset.

## References

- Research: `context/changes/testing-phase-2-paid-path/research.md`
- Test plan: `context/foundation/test-plan.md` §3 Phase 2, §4, §5, §6.1, §7
- Fixture precedent: `src/lib/services/__fixtures__/supabase-stub.ts`
- Oracle-comment precedent: `src/lib/services/credits.test.ts`
- Vendor measurements: `context/changes/persist-time-and-cost/docs/supadata-billable-requests.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Oracle correction

#### Automated

- [x] 1.1 Migration applies cleanly via `npx supabase migration up` — 0607f68
- [x] 1.2 Formatting passes: `npm run format` — 0607f68
- [x] 1.3 Existing suite still green: `npm test` — 0607f68

#### Manual

- [x] 1.4 README's credit section leads to the correct invariant when read cold — 0607f68
- [x] 1.5 D14 and S-05 read as superseded, not as rewritten history — 0607f68

### Phase 2: Runner split and guards

#### Automated

- [x] 2.1 Unit project unchanged in scope and green: `npm test` — 6b1d374
- [x] 2.2 Integration project runs, smoke test passes: `npm run test:integration` — 6b1d374
- [x] 2.3 Guard aborts on a non-loopback `SUPABASE_URL` — 6b1d374
- [x] 2.4 Types and lint pass — 6b1d374

#### Manual

- [x] 2.5 `npm test` runtime has not visibly regressed — 6b1d374
- [x] 2.6 Stryker runs against a unit module without picking up integration files — 6b1d374

### Phase 3: Vendor fixtures and the `llm.ts` unit test

#### Automated

- [x] 3.1 `npm test` green including `llm.test.ts` — 4842ca6
- [x] 3.2 Lint and types pass — 4842ca6

#### Manual

- [x] 3.3 Each fixture's comment lets a reader re-derive the shape from the vendor doc — 4842ca6

### Phase 4: Stub layer — exits, refusals, breaker, reconciliation

#### Automated

- [x] 4.1 `npm run test:integration` green — 5a4884a
- [x] 4.2 No test in this phase opens a database connection — 5a4884a
- [x] 4.3 Every Phase 3 fixture factory is referenced — 5a4884a
- [x] 4.4 Lint and types pass — 5a4884a

#### Manual

- [x] 4.5 Each `describe` block names its oracle source — 7c0357f
- [x] 4.6 Breaking one refusal exit's `charged` value turns exactly one test red — 7c0357f

### Phase 5: Real-database layer — balance invariants

#### Automated

- [x] 5.1 `npm run test:integration` green against a running local stack — d8f37f1
- [x] 5.2 Row counts in the five shared tables identical before and after a full run — d8f37f1
- [x] 5.3 Lint and types pass — d8f37f1

#### Manual

- [x] 5.4 An interrupted run leaves no synthetic account or cache row behind — d8f37f1
- [x] 5.5 The 13 paid transcript rows and the 100/18 budget row verified untouched — d8f37f1

### Phase 6: CI wiring and the cookbook

#### Automated

- [x] 6.1 A PR against `master` runs both jobs and both pass — 7c0357f
- [x] 6.2 `deploy` does not start when `integration` fails — 7c0357f
- [x] 6.3 `supabase start` succeeds on a clean runner and migrations apply — 7c0357f

#### Manual

- [x] 6.4 PR wall-clock time has not meaningfully increased — 7c0357f
- [x] 6.5 §6.2 read cold is enough to add a new integration test — 7c0357f
