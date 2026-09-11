---
date: 2026-09-04T14:20:00+02:00
researcher: Marcin Drobiecki
git_commit: 57aa875836b6902eda1043635cafb3ece89aa7ad
branch: testing-phase-2-paid-path
repository: 10x-media
topic: "Paid-path integration tests — charge-versus-delivery and spend reconciliation (test-plan §3 Phase 2)"
tags: [research, codebase, testing, credits, supadata, budget-breaker, vitest]
status: complete
last_updated: 2026-09-04
last_updated_by: Marcin Drobiecki
---

# Research: Paid-path integration tests (test-plan §3 Phase 2)

**Date**: 2026-09-04T14:20:00+02:00
**Researcher**: Marcin Drobiecki
**Git Commit**: `57aa875836b6902eda1043635cafb3ece89aa7ad`
**Branch**: `testing-phase-2-paid-path`
**Repository**: 10x-media

## Research Question

Prove the charge-versus-delivery contract on every terminating exit of the generation endpoint, and that locally-derived spend reconciles against the vendor's counter. Covers test-plan risks #1, #2, #3, #5.

Scope decisions taken before research (user, this session):

- **Risk #2** — recorded fixtures in CI only, no live vendor contact. The independent-oracle property is knowingly given up; see §8.
- **Depth** — research plus a live spike against the real runner, not code reading alone.
- **Isolation** — pursue an injectable seam in code, not a second database.

## Summary

Five findings, in order of how much they change the plan.

1. **The endpoint is already reachable from Vitest. No production refactor is needed, and no database.** The recorded assumption that `generate.ts` is untestable because it imports `astro:env/server` is **false as stated** — it is untestable _under the current config_, which is a different claim with a one-line fix. A `resolve.alias` mapping `astro:env/server` to a stub module makes the endpoint import cleanly under the existing plain `vitest/config` setup. `getViteConfig()` is not needed and the Cloudflare adapter conflict never arises. Verified empirically, §2.
2. **`vi.mock` on the two client-constructor modules reaches deep into the request path.** With `@/lib/supabase` and `@/lib/supabase-admin` mocked, a synthetic `APIContext` drove the handler to exit #8 (429, lease held) and the stub recorded the RPC it received. Every RPC-driven exit is therefore scriptable by sequencing `rpc` return values. **This dissolves the §3 Phase 2 open constraint** — the shared caches and the singleton budget row are never touched, so there is nothing to clean up between runs. §2.4.
3. **The open constraint was real but is now moot, and the chosen remedy is no longer the cheapest one.** The decision taken this session was "injectable seam in code". The spike shows a third option neither of the two considered: **no production change at all**. This is a decision to re-take with the evidence, not for research to take unilaterally — see Open Questions.
4. **35 terminating exits, and exit #34 is a three-way fork, not one outcome.** `persistSummaryAndSettle` resolves `ok:false` (`generate.ts:972`) whenever the reservation was no longer `reserved` by the time `persist_summary` locked it, and the endpoint then does nothing in every case. What that costs the user depends entirely on *how* the row was resolved — see §3. Worth testing precisely because the three branches diverge and the code cannot tell them apart.
5. **Four doc-vs-code conflicts, one of which poisons the oracle.** README documents the credit system without ever mentioning that a _refused_ submission can charge a credit. A test written from README alone would assert "credits are only spent on delivered summaries" — which is false of the shipped product. §7.

**A methodological note that earned its keep.** The prompt sent to the ledger sub-agent asserted a stop threshold "around 40000", taken from `test-plan.md` §6.1. That is wrong, and the agent refused it against the sources: `40_000` is `LONG_TRANSCRIPT_CHARS`, the 1→2 app-credit pricing boundary. The vendor breaker's threshold is `BUDGET_STOP_RESERVE = 3` Supadata credits. Two independent budgets, two unrelated numbers. Conflating them in a test would have produced a green suite asserting nothing.

## Detailed Findings

### 1. The oracle sources, and where they fail

| Source                                  | Covers                                            | Trustworthy for Phase 2?                                                                                                                    |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md` §Summary credits            | 5 starting credits, 1/2 per summary, blocked at 0 | **Partially** — silent on refusal charges, imprecise on the gate (§7.3, §7.4)                                                                |
| `context/foundation/prd.md`             | FR-003, Open Question 3 (URL rules)               | Yes for risk #5. **Contains no credit rules at all** — grep for `credit\|balance\|refund` returns nothing. The PRD is not a credit oracle    |
| `roadmap.md` S-09 D14                   | which 422 exits charge                            | Yes for _which_, **stale for the user-visibility claim** (§7.1)                                                                             |
| `roadmap.md` S-05                       | original enforcement model                        | **Stale** — describes spend-on-success with no refund, superseded by S-01/S-09 (§7.2)                                                        |
| `supadata-billable-requests.md`         | `readBillableCredits` parsing contract            | Yes — corrected this session in `5c20bbe`                                                                                                   |
| Code comments in `generate.ts:560-617`  | ordering of reserve / rate-limit / fetch          | Load-bearing sequencing; treat as contract                                                                                                  |

### 2. The spike — what was actually run

Method: temporary files under `src/__spike__/` plus a `vitest.spike.config.ts`, all deleted afterwards; the tree is back to `57aa875`.

**2.1 Baseline — reproduce the recorded failure.** Importing the endpoint under the current config fails exactly as documented:

```
Error: Cannot find package 'astro:env/server' imported from .../src/pages/api/summaries/generate.ts
 ❯ src/pages/api/summaries/generate.ts:3:1
```

**2.2 One alias fixes it.** A stub module re-exporting the five schema keys from `process.env`, plus:

```ts
"astro:env/server": fileURLToPath(new URL("./src/test/astro-env-server-stub.ts", import.meta.url)),
```

→ the endpoint imports, `typeof POST === "function"`, `prerender === false`. Load time ~3.5s cold. **No Cloudflare adapter involvement whatsoever** — the adapter enters only through `astro.config.mjs`, which a plain `vitest/config` never loads. The Phase 1 finding stands as written for `getViteConfig()`; it simply does not apply to this problem.

**2.3 The handler is invocable with a synthetic context.** `POST` touches exactly three things on `APIContext` — `context.locals.user`, `context.request`, `context.cookies` (`generate.ts:123,127,138`). A hand-built object satisfies it. Confirmed reachable with zero infrastructure:

| Exit    | Setup                                                  | Observed                                                    |
| ------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| #1 503  | no keys                                                | `{"error":"Transcript/LLM services are not configured"}`    |
| #2 503  | vendor keys set, no `SUPABASE_SERVICE_ROLE_KEY`        | `{"error":"Summary generation is not configured"}`          |
| #3 401  | all five keys, `locals.user = null`                    | `{"error":"Unauthorized"}`                                  |
| #4 400  | all five keys, malformed body                          | zod-prettified message naming `url`, `character`, `requestId` |

**Ordering finding, not previously recorded:** both 503 preflights run **before** the 401 auth check (`generate.ts:110-125`). An unauthenticated caller can therefore distinguish "service unconfigured" from "unauthorized". Minor as an information leak; significant for tests, because with keys unset **every** exit collapses to 503 and a suite would silently assert nothing. Setting all five keys is a precondition of the whole phase.

**2.4 `vi.mock` reaches the RPC layer.** Mocking the two constructor modules:

```ts
vi.mock("@/lib/supabase-admin", () => ({ createAdminClient: () => fakeClient }));
vi.mock("@/lib/supabase", () => ({ createClient: () => fakeClient }));
```

with `fakeClient = { rpc, from }` drove a well-formed authenticated request to:

```
DEEP status: 429 body: {"error":"A summary is already being generated. ..."}
RPCs CALLED: ["acquire_generation_lease"]
```

That is exit #8, past the four preflights, into `src/lib/services/generation-lock.ts`. The stub observed the RPC name, so **assertions on what reached the ledger work the same way `credits.test.ts` already does them** — the established `__fixtures__/supabase-stub.ts` factories (`stubReturning` / `stubFailing` / `stubRejecting`) apply unchanged; they need per-call sequencing instead of a single return.

### 3. The exit map — 35 terminating exits

Full table produced during research; the rows that matter for risk #1 are the ones where charge and delivery diverge.

**Exits that charge:**

| #      | Status  | Trigger                                    | Credit effect                                            | file:line              |
| ------ | ------- | ------------------------------------------ | -------------------------------------------------------- | ---------------------- |
| 17     | 422     | cached `unavailable`                       | 1 credit via `refuseAndCharge`                            | `generate.ts:546`      |
| 18     | 422     | cached `empty`                             | 1 credit                                                  | `generate.ts:549`      |
| 23     | 422     | fresh fetch `unavailable`                  | 1 credit — "the 206 we just paid a Supadata credit for"   | `generate.ts:670`      |
| 26     | 422     | whitespace-only transcript                 | 1 credit, reason `whitespace`                             | `generate.ts:731`      |
| 35     | 200     | success                                    | charged and settled                                       | `generate.ts:989`      |

**The exit that does none of the above:**

| #      | Status  | Trigger                                    | Credit effect                                             | file:line              |
| ------ | ------- | ------------------------------------------ | --------------------------------------------------------- | ---------------------- |
| **34** | **500** | **`persistSummaryAndSettle` → `ok:false`** | **depends on how the row was resolved — see the fork below** | **`generate.ts:972`**  |

**Exits that charge then refund:** #32 (502, `summarize()` threw) and #33 (500, `persistSummaryAndSettle` threw) both call `refundReservation` before responding.

**The one 422 that does not charge:** #24, fresh fetch with reason `failed`/`timeout` (`generate.ts:677`) — hardcoded `charged: false`, never calls `chargeFailedTranscript`. D14's stated reason: an outage plus a null header means the cost is unknown, "so charging would resolve our own ambiguity against the user."

**Exit #34, correctly stated.** An earlier draft of this document described it as "charged, no summary, no refund attempted". That is wrong for the main branch, and the correction matters because it changes what a test must assert.

`persistSummaryAndSettle` resolves `ok:false` when the reservation was no longer `reserved` at lock time. The endpoint logs and returns 500 without touching the balance, in every case. Three ways the row can get there, with three different outcomes:

| How the row was resolved | Balance | What the user gets |
| --- | --- | --- |
| Reconciliation sweep, no linked summary | **restored** — `reconcile_reservation` refunds (`20260722120000:81-88`) | 500, but whole. Correct behaviour |
| Operator ran `settle_reservation()` by hand | **not restored** | 500 and a lost credit — the genuine charge-without-delivery |
| `already_persisted` — a summary already cites this reservation | charged, and rightly so | 500 reporting failure while the work **succeeded** — a false negative, not a lost credit |

The code's own comment (`generate.ts:965-969`) is accurate for the first row and says so explicitly: *"the debit is reversed and nothing was written… refundReservation would be a no-op."* It simply does not distinguish the other two.

This is therefore **not a single bug with an obvious fix**. Adding an unconditional refund here would pay a credit back twice on the first row. Any fix would have to branch on `persisted.reason`, which is a product decision, not a patch. The test's job is to pin all three branches separately so the fork stops being invisible.

### 4. The refusal machinery

- `REFUSAL_COPY` (`generate.ts:83-87`) — `unavailable` → caption-specific copy; `empty` and `whitespace` → the same generic string.
- `refusalResponse(reason, charged)` (`generate.ts:231-237`) — `{error, charged}` normally; when `charged === "ambiguous"` it emits `{error, ambiguousCharge: true}` and **omits `charged` entirely** rather than setting it false. Assert that shape by its own fields, never as `charged !== true`.
- `refuseAndCharge` (`generate.ts:274-294`) — four call sites (546, 549, 670, 731). Maps `chargeFailedTranscript` outcomes: `ambiguous` → `"ambiguous"`; `charged`/`replay` → `true`; `insufficient`/`notCharged` → `false`.
- Client consumption: `useGenerateSummary.ts:254-266` **reuses the same `requestId`** on `ambiguousCharge: true` so a retry cannot double-charge; `PendingSummaryCard.tsx:204-206` renders the credit line. Both are risk #6 surface that this phase's response-body assertions protect from below.

### 5. Credit ledger — the RPC contracts

| Function                                | RPC                        | Args                                                            | Outcomes                                                                     |
| --------------------------------------- | -------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `beginGeneration` (`credits.ts:102`)    | `begin_generation`         | `target_user`, `request`, `amount`                              | `reserved`, `fresh`, `replay`, `inProgress`, `unavailable`, `insufficient`    |
| `chargeFailedTranscript` (`credits.ts:265`) | `charge_failed_transcript` | `p_user_id`, `p_request_id`, `p_amount`, `p_refusal_reason`     | `charged`, `replay`, `insufficient`, `notCharged`, `ambiguous`                |
| `lookupRefusalReplay` (`credits.ts:343`) | `get_refusal_replay`       | `p_user_id`, `p_request_id`                                     | `unavailable`/`empty`/`whitespace`/`null`                                    |
| `refundReservation` (`credits.ts:391`)  | `refund_reservation`       | `target_user`, `reservation`                                    | boolean, never throws                                                        |
| settle                                  | `persist_summary`          | 24 positional args                                              | `persisted`, `not_reserved`, `already_persisted`                             |

`amount: null` on `beginGeneration` is a **probe** — identity question without a debit (`generate.ts:432-446`). The same function is called again with the real amount at `generate.ts:791-808`; that second call re-asks identity atomically inside the RPC transaction, which is what makes concurrent duplicates safe.

`charge_failed_transcript` reserves and settles in **one statement**, so it can never strand a row. `begin_generation` can: a crash between reservation and settle/refund leaves `status='reserved'`, recovered only by an **operator-run** reconciliation — there is no in-request sweep. Partial index `credit_reservations_unresolved_idx` backs that query.

### 6. The vendor budget breaker

- Threshold: `BUDGET_STOP_RESERVE` (`supadata-budget.ts:73`) = `TRANSCRIPT_BUDGET_CREDITS + METADATA_BUDGET_CREDITS` = **3** Supadata credits. Not 40000 — see the note in the Summary.
- Two check points: before the transcript fetch (`generate.ts:574`, refusal → 503) and before the metadata fetch (`generate.ts:865`, refusal → **does not abort**, sets `metadataVia = "skipped_budget"` and persists nulls, because the user is already debited and the LLM already paid).
- A cache hit on either bypasses the breaker entirely — D5, "gates spend, not the request".
- **Fail-open**: every `untracked` path in `reserveBudget` (`supadata-budget.ts:436-510`) — RPC error, `uninitialized`, a failed/timed-out/unusable `GET /v1/me`, a lost refresh claim, a non-terminating second pass. All proceed **with no reservation and nothing to settle**. `readVendorBudget` returns `null` on any transport error, non-2xx, non-JSON, or non-nonnegative-integer figure, and never throws. The test-plan's anti-pattern warning applies exactly here: testing only the trip and never the fail-open tests the wrong branch.
- Storage: `supadata_budget` is a genuine singleton (`singleton boolean primary key default true check (singleton)`). Per _database_, not per environment — local and production hold separate rows. RLS enabled with **zero policies** plus `revoke all from public, anon, authenticated`, so it is reachable only through `SECURITY DEFINER` RPCs granted to `service_role`. Same for `supadata_reservations`, `transcript_cache`, `metadata_cache` — all keyed without an owner column, all confirmed user-agnostic in the migrations' own comments.

### 7. Doc-vs-code conflicts found

**7.1 — D14's "ships silently" is stale, and the test plan inherits it.** `roadmap.md:294` still reads "the charge ships silently — copy and 422 body unchanged … so a user can lose several credits with no on-screen acknowledgement." S-06 Phase 9 subsequently added `charged`/`ambiguousCharge` to those bodies and rendered them (`PendingSummaryCard.tsx:204-206`). `roadmap.md:384` records the supersession, but D14's own bullet was never edited — and `test-plan.md:27` quotes D14 **verbatim** as risk #1's evidence. A test written from D14's literal words would assert superseded behaviour.

**7.2 — S-05's enforcement model is stale.** `roadmap.md:173` documents "spend-on-success + up-front read gate … no refund". The shipped mechanism is debit-before-work plus refund-on-failure plus a charge-on-refusal path with no summary at all. Never updated after S-01/S-09 replaced it.

**7.3 — "blocked at 0 credits" is underspecified.** README:256 and roadmap S-05 both say generation is blocked at 0. The real gate is the conditional decrement `balance >= amount` inside `begin_generation` (`20260723130000:177-180`), so a user with **1 credit and a long (2-credit) video** is also blocked. A test asserting "blocked exactly at balance = 0" would miss a real path.

**7.4 — README never documents the refusal charge. This is the oracle hazard.** Nowhere in README or the PRD is it stated that a submission producing no summary can still cost a credit. The rule lives only in D14. A contributor deriving the oracle from README — which is what the test-plan's own §6.1 tells them to do — would write the invariant "credits are only spent on delivered summaries" and assert the opposite of shipped behaviour.

**7.5 — `@supadata/js` is now a types-only dependency.** `supadata-billable-requests.md` §"The in-repo precedent" describes `metadata.ts` as the sole SDK bypass. Since S-07, `transcript.ts:139-227` and `supadata-budget.ts:353` also call `fetch` directly; no code path instantiates a `Supadata` client. The doc's framing is outdated, and the consequence is favourable — see §8.

### 8. The vendor boundary and what a fake must cover

**All four Supadata calls now go through the global `fetch`**, so a single interception point covers them:

| Call       | Site                        | URL                                                        | Timeout                                          |
| ---------- | --------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| transcript | `transcript.ts:139-227`     | `GET /v1/transcript?url=…&text=true&mode=native&lang=en`   | 90s                                              |
| job poll   | `transcript.ts:319-334`     | `GET /v1/transcript/{jobId}`                                | 10s — **dead code** under `TRANSCRIPT_MODE = "native"` |
| metadata   | `metadata.ts:70-73`         | `GET /v1/metadata?url=…`                                    | 10s, one retry after 1200ms                      |
| budget     | `supadata-budget.ts:353`    | `GET /v1/me`                                                | 2s                                               |

**OpenRouter needs a different seam.** `summarize` (`llm.ts:139-165`) goes through `generateText` from the `ai` package over a model built by `createOpenRouter`. Whether that provider honours a global `fetch` swap is unverified — and `@supadata/js`'s module-init `fetch` capture is the cautionary precedent. Mock at the module boundary (`vi.mock("ai")` or `llm.ts`) rather than assuming interception reaches it.

**Fixtures must include the failure shapes, with the measured values:**

- 200 native transcript, `x-billable-requests: 1`, body `{content, lang, availableLangs}`.
- **206 `transcript-unavailable` with NO header, still billed 1 credit** — measured three times across two videos, a stable property. This is the shape that makes `null` ≠ `0` load-bearing.
- 524 gateway timeout, no body, no header — cost **unknown, not zero**; the vendor bills timed-out requests.
- Non-JSON 2xx → synthesized `internal-error`.
- `x-billable-requests` absent, and malformed (`"1oops"`, `"1.5"`, out of int4 range) → all `null` per the contract corrected in `5c20bbe`.
- `GET /v1/me` → `{organizationId, plan, maxCredits, usedCredits}`, plus malformed/negative/fractional variants to exercise the fail-open.

**Nothing is installed for HTTP faking** — no msw, nock, or undici as a direct dependency. Vitest's own `vi.stubGlobal("fetch", …)` covers all Supadata traffic without adding one.

**The cost of the fixtures-only decision, stated plainly.** With no live `GET /v1/me`, risk #2's test proves that the code correctly reads and sums _recorded_ responses. It cannot detect that the vendor changed its pricing, stopped sending the header, or altered the `/v1/me` shape — the failure modes reconciliation existed to catch. This is a knowing trade, and it belongs in the test file's header comment and in `test-plan.md` §7, not in a footnote.

## Code References

- `src/pages/api/summaries/generate.ts:110-125` — the two 503 preflights, both before the 401
- `src/pages/api/summaries/generate.ts:231-237` — `refusalResponse`, the `ambiguousCharge` shape
- `src/pages/api/summaries/generate.ts:274-294` — `refuseAndCharge` outcome mapping
- `src/pages/api/summaries/generate.ts:965-972` — exit #34, the three-way fork; the comment is accurate for the sweep branch only
- `supabase/migrations/20260722120000_link_summary_to_reservation.sql:81-88` — `reconcile_reservation` refunds a row with no linked summary, which is why the sweep branch leaves the user whole
- `src/lib/services/credits.ts:102,265,343,391` — the four injected-client ledger functions
- `src/lib/services/supadata-budget.ts:73` — `BUDGET_STOP_RESERVE = 3`
- `src/lib/services/supadata-budget.ts:436-510` — every fail-open `untracked` exit
- `src/lib/services/supadata-ledger.ts:198-224` — `readBillableCredits`, JSDoc corrected in `5c20bbe`
- `supabase/migrations/20260723130000_idempotent_generation.sql:130,177-180` — the `for update` lock and the conditional decrement
- `supabase/migrations/20260731110000_charge_failed_transcript.sql:85-201` — reserve+settle in one statement
- `supabase/migrations/20260731150000_supadata_budget.sql:52-59` — the singleton row

## Architecture Insights

- **The DI convention is already universal below the endpoint.** Every DB-touching service takes its client as a parameter; nothing in `src/lib/services/` constructs one. The two constructions happen once each, at `generate.ts:118` and `generate.ts:138`. That is why mocking two modules reaches everything.
- **`astro:env/server` is confined to four modules** — `supabase.ts`, `supabase-admin.ts`, `config-status.ts`, `generate.ts`. All top-level imports, none behind a function. Aliasing the virtual module is a narrower intervention than moving code out from under it.
- **Two independent budgets guard two independent things**: app credits (user-facing, 5/1/2, gate `balance >= cost`) and Supadata vendor credits (operator-facing, stop reserve 3, fail-open). They share no code and no numbers.

## Historical Context (from prior changes)

- `context/foundation/test-plan.md:195-201` — Phase 1's recorded findings; §6.6's `astro:env` claim is the one this research narrows (see §2.2).
- `context/changes/persist-time-and-cost/docs/supadata-billable-requests.md` — measured vendor shapes; §Parsing contract corrected this session.
- `context/changes/app-design-system/reviews/impl-review-phase-9.md:23-40` — finding F1, the origin of `ambiguousCharge`.
- `roadmap.md:297` — S-09 finding F1 made `requestId` required, closing a free-paid-path hole; `generate-summary.test.ts` already pins it.

## Related Research

- `context/changes/testing-phase-1-bootstrap/` — the unit layer this phase builds on.

## Open Questions

1. **Does the chosen "injectable seam" decision still stand?** The spike shows the phase needs no production change. Re-decide with the evidence before planning.
2. **Does `@openrouter/ai-sdk-provider` honour a global `fetch` swap,** or must the fake sit at the `ai` module boundary? Unverified; cheap to settle with a second spike.
3. **Should the four stale documents be corrected before or alongside the tests?** §7.4 in particular changes what a correct test asserts.
4. **Does exit #34's operator-settle branch deserve a fix?** Only that branch loses the user a credit; the sweep branch is already correct and the `already_persisted` branch misreports success as failure instead. A fix would have to branch on `persisted.reason` — a product decision, not a patch, and out of scope for a test phase.
