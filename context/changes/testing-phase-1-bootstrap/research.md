---
date: 2026-08-22T17:24:03+02:00
researcher: Marcin Drobiecki
git_commit: c14fa1fab07234aa61678c80cfc3acb8cf461d70
branch: testing-phase-1-bootstrap
repository: 10xMedia
topic: "Rollout Phase 1 — oracle for risks #1 (credits spent, no summary) and #5 (crafted request drives the paid pipeline)"
tags: [research, testing, credits, trust-boundary, risk-1, risk-5, vitest]
status: complete
last_updated: 2026-08-22
last_updated_by: Marcin Drobiecki
---

# Research: Test rollout Phase 1 — the oracle for risks #1 and #5

**Date**: 2026-08-22T17:24:03+02:00
**Researcher**: Marcin Drobiecki
**Git Commit**: `c14fa1fab07234aa61678c80cfc3acb8cf461d70`
**Branch**: `testing-phase-1-bootstrap`
**Repository**: 10xMedia

## Research Question

Ground the oracle for `test-plan.md` §2 risks **#1** (credits are spent and no summary comes back; or a refusal charges the user and nothing on screen says so) and **#5** (a crafted request drives the paid pipeline for free, or past a guard the UI enforces but the server does not), for the phase whose scope is **pure decision rules plus standing up the runner** — no integration, no database, no e2e.

Specifically:

- **#1** — where the charge decision is made, where the reservation is settled vs refunded, and how that relates to the response body. Which exits charge **by design** and which charge **by accident**. Challenge: that a refund after a failed generation leaves the user whole — a settled reservation without a summary *is* a charge.
- **#5** — the validation schema at the trust boundary; which fields are optional and what "optional" means on a paid path. Challenge: that client-side validation implies server-side validation.

The oracle must come from sources (PRD, documented credit rules, tech-stack), never from the shape of the implementation.

## Summary

**Five findings decide what Phase 1 should assert.**

1. **The charge decision is not in one place — it is in three, and only one of them is pure.** The *price* of delivered work is `summaryCost()` (pure, `summaries.ts:153`). The *price of a refusal* is a flat constant `REFUSAL_CHARGE = 1` (`generate.ts:93`). Whether the response **tells the truth about the money** is decided by a mapping from an RPC outcome to a `charged` field (`generate.ts:287-307` over `credits.ts:265-323`). That third one is where risk #1 actually lives, and it is testable hermetically with a stub client — no database.

2. **The endpoint has 35 terminating exits. Four charge without delivering a summary, and all four are documented (S-09 D14).** A fifth 422 — the transient `failed`/`timeout` one — deliberately does not charge. The dangerous-looking exits (`persist !ok`, the 409 "already processed") are *not* silent charges: `reconcile_reservation` refunds any reservation with no linked summary (`20260722120000_link_summary_to_reservation.sql:81-88`). **But that sweep is operator-run, not scheduled** — there is no cron anywhere in the repo. That is the one real residual under risk #1, and it is operational, not a Phase 1 test target.

3. **`charged` on the response body is the risk-#1 signal, and it has a five-way truth table that no other layer can check.** `charged`/`replay` → `true`; `insufficient`/`notCharged` → `false`; **`ambiguous` → the field is omitted entirely** and `ambiguousCharge: true` is sent instead, because asserting `false` there would be a false statement about the user's money. This mapping is pure over an injected client and is the single highest-signal unit test in the phase.

4. **For risk #5, "client-side validation implies server-side validation" is *literally true* for the URL and *entirely false* for everything else.** `GenerateSummaryForm.tsx:67` and the server's zod refine call **the same** `extractYoutubeId` (`summaries.ts:161`), so URL shape cannot drift. But `requestId`, `character` and `allowLong` get **no client-side validation at all** — the form always sends well-formed values — so the schema is the only guard, and it has already failed once in exactly that way (S-09 Phase 3 F1: an optional `requestId` let any authenticated caller drive the paid `unavailable` path for free).

5. **The schema is unreachable from a test today.** `generateSchema` is a module-private `const` inside `src/pages/api/summaries/generate.ts:108-120`. Per the scoping decision below it moves to `src/lib/schemas/`.

**Scope decisions taken with the user during this research** (they change what Phase 1 delivers, so they are recorded here rather than left to the plan):

- **`allowLong: true` sent on a first, unprompted request is BY DESIGN** — pre-authorization, not a bypass. The 409 exists to inform a client that does not yet know the price; a client that already consents may say so up front. Tests pin this as intended behaviour. **No code change, and #5 must not assert a refusal here.**
- **Phase 1 covers pure functions *and* hermetic stub-client tests**, including `chargeFailedTranscript` and `beginGeneration`. Zero infrastructure either way.
- **`generateSchema` is extracted to `src/lib/schemas/`** and imported by the endpoint, rather than exported in place.

## Detailed Findings

### A. Where the money decision is made (risk #1)

Three distinct decisions, deliberately separate. Conflating them is the main modelling error a test could make.

| Decision | Owner | Purity | Oracle source |
|---|---|---|---|
| What **delivered** work costs | `summaryCost(len)` — `summaries.ts:153` | pure | README §Summary credits; roadmap S-01 (">40k transcript chars ⇒ 2 credits") |
| What a **refused** submission costs | `REFUSAL_CHARGE = 1` — `generate.ts:93` | pure constant | roadmap S-09 **D14** |
| Whether the response **states** the charge truthfully | `refuseAndCharge` → `refusalResponse` — `generate.ts:244-307` | pure over an injected client | roadmap S-09 phase 9 **D1**; `credits.ts:210-215` contract |

`summaryCost` is explicitly commented as *pricing only* — it does not enforce the hard cap (`summaries.ts:145-155`). The cap is a separate gate at two call sites (`generate.ts:699` on the fetch path, `generate.ts:756` on the cache/quote path).

**The load-bearing edge case the code itself flags: `summaryCost(0) === 1`.** `generate.ts:732-737` states that an empty transcript reaching the main path would clear the 413 and the 409, **debit a credit, and send nothing to the LLM**. The actual protection is the whitespace guard at `generate.ts:743`, not the pricing function. A test on `summaryCost(0)` documents the hazard; it does not protect against it.

### B. Full exit map — which exits charge, and why

Every terminating path of `POST /api/summaries/generate`, with what it does to the balance. This is the "every terminating path either delivers a summary or leaves the balance where it found it" claim from §2, checked exhaustively.

**Never touch the balance** (no debit was ever opened):

| Status | Site | Cause |
|---|---|---|
| 503 | `generate.ts:124` | provider keys unset |
| 503 | `:133` | no service-role client — refuses *before* any debit precisely so the refund path is never needed and missing |
| 401 | `:137` | unauthenticated |
| 400 | `:143` | schema rejection |
| 503 | `:153` | Supabase unconfigured |
| 500 | `:172` | lease acquisition threw |
| 429 | `:176` | per-user generation lease held |
| 500 | `:454` | idempotency probe threw — **fails closed** |
| 429 | `:341` | another attempt on this key in progress |
| 500 | `:476` | balance read threw |
| 402 | `:479` | balance null or ≤ 0 — the up-front read gate |
| 413 | `:553`, `:708`, `:757` | transcript over `HARD_MAX_TRANSCRIPT_CHARS` (cached verdict, fresh, quote path) |
| 503 | `:589` | budget breaker tripped at the transcript check point |
| 500 | `:621` | rate-limit RPC threw — **fails closed**, budget reservation released |
| 429 | `:625` | transcript rate cap — budget reservation released |
| 502 | `:645` | transcript fetch threw |
| **422** | **`:690`** | **fresh `failed`/`timeout` — the ONE exempt 422**, sends `charged: false` |
| 409 | `:776` | long-video confirmation required — returns **before** the debit |
| 402 | `:810` | atomic debit found insufficient credits |
| 500 | `:825` | `begin_generation` threw or returned a non-debiting outcome |

**Charge without delivering a summary — all four documented under D14:**

| Status | Site | Reason stored | Operator actually paid? |
|---|---|---|---|
| 422 | `:559` | `unavailable` (negative-cache hit) | **no** — deliberate, see below |
| 422 | `:562` | `empty` (cache hit) | **no** — deliberate |
| 422 | `:683` | `unavailable` (fresh 206) | yes, 1 Supadata credit |
| 422 | `:744` | `whitespace` | depends on source |

The cache-hit pair is the only place in the codebase where a credit is taken having paid nothing. `generate.ts:261-264` records why: the alternative — free inside D4's 2 h window, charged outside it — makes one action cost differently depending on state the user cannot see, and rewards rapid resubmission of exactly the videos that window exists to re-check. **This is the "charges by design" answer to the research question.** Nothing charges by accident.

**Debited then compensated:**

| Status | Site | Compensation |
|---|---|---|
| 502 | `:839` | `refundReservation` after a failed LLM call |
| 500 | `:975` | `refundReservation` after a failed persist |
| 500 | `:985` | **no refund** — `persist_summary` reported the reservation was already resolved |

**`:985` is the exit that most looks like a silent charge and is not.** The only thing that resolves a reservation out from under a running request is `reconcile_reservation`, and it refunds any reservation with **no linked summary** (`20260722120000_link_summary_to_reservation.sql:68-88`). So by the time this branch is reached the balance has already been restored. The code's own comment says exactly this (`generate.ts:978-981`).

**The genuine residual, and it is not a test target.** `reconcile_reservation` is a **manual operator tool** — `20260720160000_credit_reservations.sql:36-48` documents it as a query the operator runs, and there is no scheduler, no cron and no Worker `scheduled` handler in the repo. A request killed between the debit (`:804`) and the persist (`:945`) therefore leaves a `reserved` row and a debited balance **until someone runs the sweep by hand**. That is "credits spent and no summary comes back", with a manual counterweight. It cannot be closed by a test; it belongs in the risk record and, if anywhere, in Phase 2's integration coverage of the ledger.

**Delivers a summary:** `:329` (idempotent replay — the original attempt paid, this retry does not pay again) and `:1002` (success).

### C. The `charged` truth table — the highest-signal unit test in this phase

`refuseAndCharge` (`generate.ts:287-307`) reads the *ledger outcome*, never a hardcoded value. The mapping:

| `chargeFailedTranscript` outcome | Response body | Meaning |
|---|---|---|
| `charged` | `{ error, charged: true }` | one credit taken now |
| `replay` | `{ error, charged: true }` | a credit was taken **by the original attempt on this key**, not by this retry |
| `insufficient` | `{ error, charged: false }` | balance moved mid-request; nothing taken |
| `notCharged` | `{ error, charged: false }` | structured PostgREST error ⇒ the statement rolled back — the **one** failure mode that proves nothing was charged |
| `ambiguous` | `{ error, ambiguousCharge: true }` — **`charged` omitted** | cannot be proven either way; asserting `false` would be a false statement about the user's money |
| `requestId === null` | `{ error, charged: false }` | charge skipped rather than keyed on an invented id (unreachable from the endpoint since the schema requires the field) |

And the source side (`credits.ts:265-323`) decides `notCharged` vs `ambiguous` on a distinction that is easy to get wrong and impossible to see from the outside:

- structured `error` from PostgREST → `notCharged` (the RPC's single reserve-and-settle statement raised inside its own transaction and rolled back atomically);
- **rejected promise** → `ambiguous` (a transport failure can happen after Postgres commits);
- **`data` empty or an unrecognised `outcome` with no `error`** → `ambiguous` (no error means the statement executed; the debit may well have landed).

`REFUSAL_COPY` (`generate.ts:82-86`) is a map keyed on the same `RefusalReason` the ledger stores, so an original refusal and its replay reconstruct **identical copy** — `generate.ts:70-80` names this as the one failure the replay contract exists to prevent and one that no balance assertion would catch.

The client half consumes it correctly: `useGenerateSummary.ts:332` narrows a non-boolean `charged` to `null` — "silence about money rather than a guessed `false`" — and `:262` keeps the idempotency key alive **only** for a 422 carrying `ambiguousCharge: true`.

### D. The trust boundary (risk #5)

`generateSchema`, `generate.ts:108-120`:

```ts
url:       z.string().refine((url) => extractYoutubeId(url) !== null, …)
character: z.enum(["informational", "educational"])
allowLong: z.boolean().optional().default(false)
requestId: z.uuid()
```

**What "optional" means on this paid path, field by field:**

- **`allowLong` — optional, defaults to `false`, and the default direction is the safe one.** Omitting it means the long-video 409 gate applies. Sending `true` up front skips the gate and debits 2 credits — **by design** (user decision, this research): the 409 informs a client that does not yet know the price, and a client that already consents may pre-authorize. There is no free ride in either case: the atomic debit at `:804` is the authoritative gate, so a 1-credit user submitting a long video with `allowLong: true` gets 402 `insufficient` (`:810`), not a generation.
- **`requestId` — required, and that is the whole of S-09 Phase 3 finding F1.** `refuseAndCharge` skips the D14 fee when it has no key (`generate.ts:293-295`), so an optional field would have let any caller opt out of the charge by omitting it — "an optional key let any authenticated caller drive the paid `unavailable` path for free" (roadmap S-09 status). The comment at `:114-118` records the accepted cost: a cached pre-F22 client gets a 400 until it reloads. **This is the single most valuable assertion in the phase — it pins a regression that already happened once.**
- **`character` — a closed enum.** A third value would reach `summarize()` and the prompt selection in `llm.ts` after the debit.
- **`url` — validated by `extractYoutubeId`, not by a URL regex.** The whole host allow-list lives in that function.

**Does client-side validation imply server-side validation here?** Two different answers, and both matter:

- **For the URL: yes, literally.** `GenerateSummaryForm.tsx:11,67` imports the **same** `extractYoutubeId` the server's refine uses. They cannot drift, because there is one implementation. Worth stating explicitly so nobody "hardens" one side and creates the drift that does not exist today.
- **For everything else: no, and there is nothing to imply from.** The form validates only the URL (`urlIsValid` → `submitDisabled`, `GenerateSummaryForm.tsx:67-76`). `requestId` is minted by `crypto.randomUUID()` (`useGenerateSummary.ts:217`), `character` comes from a radio group, `allowLong` from a checkbox — none is *validated*, all are simply well-formed by construction. The schema is the only guard, and F1 proves the gap is real rather than theoretical.

**`extractYoutubeId` (`summaries.ts:161-185`) — what it actually accepts**, since it is the URL rule for both sides:

- host must be exactly `youtu.be` or one of `youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com` (`:158`);
- `/watch` reads `?v=`; `/shorts/…`, `/embed/…`, `/live/…` read the first path segment; `youtu.be` reads the first non-empty path segment;
- the extracted id must match `/^[a-zA-Z0-9_-]{11}$/` (`:157`);
- anything `new URL()` cannot parse → `null`.

Consequences worth asserting, derived from the rule rather than from the code shape: a look-alike host (`youtube.com.example.test`) is rejected because the check is set membership, not a suffix match; a credentials-in-URL form (`https://www.youtube.com@example.test/watch?v=…`) is rejected because `URL.hostname` resolves to the real host; a bare 11-character id with no URL around it is rejected; `http://` is accepted equally with `https://`; and the *submitted* URL is persisted verbatim (`generate.ts:945` → `p_url`), never a normalized form.

**`z.uuid()` semantics — verified against the library, not assumed.** Zod 4's `z.uuid()` is RFC 9562/4122-compliant and accepts **any** version v1–v8; `z.guid()` is the permissive 8-4-4-4-12 hex form, and `z.uuidv4()` is the version-pinned one (Context7 `/websites/zod_dev`, checked 2026-08-22). The roadmap's phrasing — "`z.uuid()` rejects a hand-typed non-v4 key" (S-09 status) — is loose: what it rejects is a non-RFC-compliant string, not a valid v1 UUID. **A test asserting that a valid v1 UUID is rejected would fail.** The field's contract is *stable idempotency identity*, which any RFC UUID satisfies, so the correct assertions are: missing → 400, non-UUID string → 400, valid UUID → accepted.

### E. Oracle table — expected behaviour and where it comes from

Every row's expected value is derived from a document, never from reading the function. Rows with no source are marked and are not assertable in this phase.

| Rule | Expected | Source (not the implementation) |
|---|---|---|
| A delivered summary costs 1 credit | `summaryCost(len) === 1` for `len ≤ 40 000` | README §Summary credits; roadmap S-01 |
| A long video costs 2 credits | `summaryCost(len) === 2` for `len > 40 000` | roadmap S-01 (">40k transcript chars ⇒ 2 credits") — the boundary is strict `>`, so exactly 40 000 is 1 |
| Zero-length prices as 1, not 0 | `summaryCost(0) === 1` | derived: the rule is "long ⇒ 2, else 1"; there is no zero tier. Documented as a hazard at `generate.ts:732-737` |
| A refusal costs a flat 1 credit, never `summaryCost` | 1 | roadmap S-09 **D14** ("a long video that turns out to have no captions is refused just as cheaply as a short one") |
| Four of five 422 exits charge; the transient one does not | see §B | roadmap S-09 **D14** verbatim |
| An `ambiguous` charge outcome must not report `charged: false` | field omitted, `ambiguousCharge: true` | roadmap S-09 phase 9 **D1**; `credits.ts:206-208` |
| `replay` means a credit **was** taken (by the original attempt) | `charged: true` | `credits.ts:196-199`; `generate.ts:278-281` |
| A structured PostgREST error is the only proof of no charge | `notCharged` | `credits.ts:200-203`, reasoning stated as a contract |
| `requestId` is required at the boundary | missing ⇒ 400 | roadmap S-09 status, finding **F1** |
| Only `informational` / `educational` are accepted | any other value ⇒ 400 | PRD **FR-004**; Non-Goals ("Channel character definitions other than informational and educational") |
| A non-YouTube URL is rejected server-side | 400 | PRD **FR-003** + Open Question 3 (validation rules are owned by implementation, so the rule *is* `extractYoutubeId`'s documented contract) |
| Generation is blocked server-side at 0 credits | 402 before any paid call | README §Summary credits ("blocked server-side at 0 credits before any paid call is made") |
| `allowLong: true` unprompted is accepted pre-authorization | 2-credit generation, no 409 | **user decision, 2026-08-22** (recorded in §Summary) |
| `billedSince` — one unknown makes the window unknown | `null`, never a sum treating null as 0 | `supadata-billable-requests.md` §Measured: a 206 is billed 1 credit and sends **no** header |
| `readBillableCredits` rejects a partially-numeric header | `null` for `"1.5"`, `"1oops"` | **conflicted — see Open Questions** |

### F. Test-surface classification — what Phase 1 can actually reach

| Target | Layer | Risk | Notes |
|---|---|---|---|
| `summaryCost` — `summaries.ts:153` | pure | #1 | Boundary at exactly 40 000; `0`; negative/NaN are unreachable from the endpoint (`content.length`) and should not be invented as cases |
| `extractYoutubeId` — `summaries.ts:161` | pure | #5 | The shared client/server rule. One `it.each` per property, not six near-identical happy paths |
| `generateSchema` — moving to `src/lib/schemas/` | pure | #5 | `requestId` required (F1); `character` enum closed; `allowLong` default `false`; `url` refine |
| `createSupadataMeter().billedSince` — `supadata-ledger.ts:122` | pure | #1/#2 | Null contagion + the `operation` filter. Adjacent to #2, cheap, and the oracle is documented |
| `readBillableCredits` — `supadata-ledger.ts:198` | pure | #2 | See the doc-vs-code conflict in Open Questions before asserting |
| `chargeFailedTranscript` — `credits.ts:265` | hermetic (stub `{ rpc }`) | **#1** | The five-way outcome table of §C. **Highest signal in the phase** |
| `beginGeneration` — `credits.ts:102` | hermetic | #1 | Outcome narrowing; the two contract-violation throws (`reserved` without an id, `replay` without a summary) |
| `refuseAndCharge` / `refusalResponse` — `generate.ts:244-307` | hermetic, **not reachable today** | #1 | Module-private inside the endpoint. Reaching it means extracting it, which is a bigger move than the schema extraction and is **not** proposed for this phase — the mapping is asserted one level down, at `chargeFailedTranscript` |
| `lookupRefusalReplay` — `credits.ts:343` | hermetic | #1 | Narrowing + the deliberate fail-toward-`null` direction |
| the budget breaker's stop/warn decision | **not TS** | #3 | Lives in `reserve_supadata_credits` SQL. Phase 2 |
| RLS, cascades, unique indexes | integration | #4 | Phase 3 |

### G. Standing up the runner

Nothing exists: **zero test files, no `vitest.config`, no `playwright.config`, no `test` script in `package.json`, and no test job in CI.** Vitest is not in `devDependencies`.

The stack decision is already made and dated in `test-plan.md` §4 (verified via Context7 on 2026-08-18, four days ago — well inside the three-month freshness rule, so **no re-verification is needed**): Vitest, configured through `getViteConfig()` from `astro/config`, with **`environment: 'node'`** — Astro 6 disallowed the client environments for tests that render Astro components.

Two project constraints the runner config has to respect, neither of which is in the test plan:

1. **The `@/*` path alias.** `tsconfig.json` maps it, and every service under test imports through it (`credits.ts:2`, `generate.ts:4-39`). `getViteConfig()` inherits `astro.config.mjs`, which does **not** declare that alias — Astro resolves it from `tsconfig` at build time. Verify the alias resolves under Vitest before assuming it does.
2. **`astro.config.mjs` carries workerd-specific machinery** — the `cross-fetch` → ESM shim alias and the `@supadata/js` `optimizeDeps.exclude`. None of the Phase 1 targets import `@supadata/js`: `credits.ts`, `summaries.ts` and `supadata-ledger.ts` pull in only `zod` and `@supabase/supabase-js` types. `supadata-budget.ts` transitively imports `metadata.ts` (for `RETRY_DELAY_MS`), which calls `fetch` directly rather than through the SDK. So the SDK never needs to load in a Phase 1 test — worth knowing, because it is the one dependency documented as incompatible with a non-workerd runtime.

`astro:env/server` is imported by `generate.ts:3` and `supabase.ts` — another reason the endpoint module itself is awkward to load in a unit test, and another argument for the schema living in `src/lib/schemas/` rather than being exported in place.

New gate to wire per `test-plan.md` §5: **unit — required after Phase 1**, local + CI.

## Code References

- `src/pages/api/summaries/generate.ts:108-120` — the trust-boundary schema; `requestId: z.uuid()` and the F1 rationale
- `src/pages/api/summaries/generate.ts:82-93` — `REFUSAL_COPY` and `REFUSAL_CHARGE = 1`
- `src/pages/api/summaries/generate.ts:244-307` — `refusalResponse` / `refuseAndCharge`; the `charged` reporting contract
- `src/pages/api/summaries/generate.ts:321-369` — `respondToRepeatedRequest`; the refusal-replay branch
- `src/pages/api/summaries/generate.ts:478-480` — the up-front 402 read gate
- `src/pages/api/summaries/generate.ts:552-563` — cached `too_long` (413, no charge) vs cached `unavailable`/`empty` (422, charge)
- `src/pages/api/summaries/generate.ts:683-690` — the fresh `unavailable` charge and the one exempt 422
- `src/pages/api/summaries/generate.ts:743-748` — the whitespace guard and `summaryCost` call
- `src/pages/api/summaries/generate.ts:765-785` — the long-video 409, returned before any debit
- `src/pages/api/summaries/generate.ts:804-826` — the atomic debit; the authoritative cost gate
- `src/pages/api/summaries/generate.ts:978-986` — the `persist !ok` fail-closed branch
- `src/lib/services/summaries.ts:149-155` — `LONG_TRANSCRIPT_CHARS`, `HARD_MAX_TRANSCRIPT_CHARS`, `summaryCost`
- `src/lib/services/summaries.ts:157-185` — `extractYoutubeId`, the host allow-list and the id pattern
- `src/lib/services/credits.ts:190-215` — `RefusalReason` and the `ChargeFailedTranscriptResult` contract
- `src/lib/services/credits.ts:265-323` — `chargeFailedTranscript`; `notCharged` vs `ambiguous`
- `src/lib/services/credits.ts:343-371` — `lookupRefusalReplay`; the deliberate fail-toward-`null`
- `src/lib/services/supadata-ledger.ts:122-137` — `billedSince`; null contagion and the `operation` filter
- `src/lib/services/supadata-ledger.ts:198-213` — `readBillableCredits`; the deliberate rejection of `Number.parseInt`
- `src/components/summaries/GenerateSummaryForm.tsx:11,67-76` — the client reusing `extractYoutubeId`; `submitDisabled`
- `src/components/hooks/useGenerateSummary.ts:262-264,332` — the ambiguous-charge key lifetime; `charged` narrowed to `null`
- `supabase/migrations/20260722120000_link_summary_to_reservation.sql:47-88` — `reconcile_reservation`: settle if a linked summary exists, refund otherwise
- `supabase/migrations/20260720160000_credit_reservations.sql:36-48` — the reconciliation query, documented as an operator step

## Architecture Insights

- **The endpoint reports the charge, it does not decide it.** Every `charged` value is read back from a ledger outcome. That inversion is what makes risk #1 unit-testable at all: the truth table lives in a service, not in HTTP handling.
- **"Unknown" is a first-class value in three separate places** — `billedSince` returns `null` rather than summing nulls as 0; `readBillableCredits` returns `null` rather than parsing a prefix; `chargeFailedTranscript` returns `ambiguous` rather than guessing `notCharged`. All three collapse to a plausible-looking wrong number under the obvious implementation. **Each is a test that a coverage-driven suite would never write, and each protects a real user-money claim.**
- **Fail direction is chosen per guard and is never uniform.** The idempotency probe fails **closed** (500) because proceeding on unknown state is the double charge it exists to prevent; the rate limiter fails **closed** because it guards unbounded spend; the budget breaker fails **open** because a free bookkeeping endpoint must not take down a working product; `lookupRefusalReplay` fails toward the *existing* 409 because its only job is to improve a reply that already works. A test that assumes one convention will assert the wrong direction somewhere.
- **The generation lease is per-user and cannot coordinate two users on one video** (`generate.ts:377-381`) — concurrent cold misses are measured, not prevented. Relevant to Phase 2, not here.

## Historical Context (from prior changes)

- `context/foundation/roadmap.md` §S-09 **D14** — the origin of the refusal charge, its four-of-five split, and the three consequences recorded up front: the cache-hit case charges although the operator paid nothing; the charge **ships silently** (copy and 422 body unchanged, the user's explicit call); a revert stops future charges but returns nothing already taken. **"Ships silently by design" is precisely the second half of risk #1** — and no test can close it, because it is a product decision, not a defect.
- `context/foundation/roadmap.md` §S-09 status — Phase 3 impl-review finding **F1**, which made `requestId` required. The regression that risk #5 is written about.
- `context/foundation/roadmap.md` §S-01 — the credit flow reworked to **debit-before-LLM + refund-on-failure** during plan review, to close a concurrency budget bypass. The reason a bare `balance + amount` refund was rejected is stated in `credits.ts:4-23`.
- `context/changes/persist-time-and-cost/docs/supadata-billable-requests.md` §Measured — a `206` is billed 1 credit and carries **no** `x-billable-requests` header. The independent oracle behind `billedSince`'s null contagion.
- `context/foundation/roadmap.md` §S-06 — API responses stay English while the UI went Polish, deliberately deferred. Test copy assertions should therefore expect **English** server strings.

## Related Research

None — this is the first `research.md` in the test-rollout series. Phase 2's will inherit the exit map in §B and the unresolved rows in Open Questions.

## Open Questions

1. **`readBillableCredits` — the doc and the code disagree, and the code is stricter.** `supadata-billable-requests.md:163-171` prescribes `Number.parseInt`, which turns `"1.5"` into `1`; the implementation (`supadata-ledger.ts:206`) deliberately rejects anything not matching `/^\d+$/`, on the stated ground that a ledger claiming to be *measured* must not invent a precise-looking value. The implementation's reasoning is sound and the doc is older. **Do not assert `"1.5"` either way until the doc is corrected** — asserting the code's behaviour with the doc still saying otherwise is a mirror test. Belongs to Phase 2 (risk #2) regardless; noted here so it is not rediscovered.
2. **The unswept reservation.** `reconcile_reservation` is operator-run with no scheduler. A Worker killed between the debit and the persist leaves a debited balance and a `reserved` row until someone runs the query by hand. Not closable by a test; the question is whether it becomes a scheduled job (a roadmap slice) or stays a documented operational step. Raise at Phase 2 planning.
3. **Whether extracting `refuseAndCharge` from the endpoint is worth doing.** It is the function that assembles the response from the ledger outcome, and it is unreachable from a test today. Phase 1 asserts one level down (`chargeFailedTranscript`), which covers the outcome mapping but **not** the `REFUSAL_COPY` lookup or the `ambiguous` → `ambiguousCharge` body shape. Phase 2's request-boundary integration tests would cover both without any extraction, so the recommendation is to leave it — but the gap is real and should be stated in the plan rather than discovered.
4. **Whether `character` deserves an assertion beyond the enum.** The PRD's Non-Goals close the set, but nothing documents what should happen if a *future* character is added to the enum and not to the prompt selection in `llm.ts`. Out of scope for #1 and #5; noted only so it is not mistaken for a gap.
