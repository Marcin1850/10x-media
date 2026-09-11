# Test Rollout Phase 1: Bootstrap + Cost/Credit Rules — Plan Brief

> Full plan: `context/changes/testing-phase-1-bootstrap/plan.md`
> Research: `context/changes/testing-phase-1-bootstrap/research.md`

## What & Why

Stand up this project's first test runner and use it to pin the rules that decide **what a generation costs**, **what the server refuses**, and **whether the response tells the truth about a user's money**. This is Phase 1 of `test-plan.md` §3, covering risk #1 (credits spent with no summary, or a refusal that charges silently) and risk #5 (a crafted request drives the paid pipeline for free, or past a guard the UI enforces but the server does not).

The oracle for every assertion comes from the PRD, the README's credit rules, and recorded roadmap decisions — never from reading the implementation. A test that copies the code's output would pass against a bug.

## Starting Point

There is no test infrastructure whatsoever: zero test files, no Vitest, no `test` script, no CI test job. Research mapped the endpoint's 35 terminating exits and established that **nothing charges by accident** — the four charging 422s are S-09 D14 by design. The real risk-#1 surface is therefore not the exits but the five-way `charged` truth table in `credits.ts`, which is pure over an injected client. The real risk-#5 surface is `requestId` being required — a regression that already shipped once as S-09 phase 3 finding F1.

## Desired End State

`npm test` runs a green unit suite locally and in CI, asserting the cost rules, the trust-boundary schema, the shared URL rule, and the credit-ledger outcome contracts. A future contributor can add a unit test by following `test-plan.md` §6.1 without rediscovering the alias and stub-client details, and §3 Phase 1 reads `complete`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| `allowLong: true` unprompted | Intended pre-authorization | The 409 informs a client that does not know the price; one that already consents may say so up front — tests must **not** assert a refusal. | Research |
| Phase 1 test layers | Pure **and** hermetic stub-client | Pure functions alone leave risk #1 with almost no surface; both are zero-infrastructure. | Research |
| Schema reachability | Extract `generateSchema` to `src/lib/schemas/` | It is module-private inside an endpoint that imports `astro:env/server`, so a test cannot reach it. | Research |
| `z.uuid()` semantics | Assert missing/non-UUID rejected, valid UUID accepted | Zod 4 accepts any RFC UUID version — a "rejects non-v4" test would fail, contradicting a loose roadmap phrasing. | Research |
| Test file layout | Colocated `*.test.ts` | The test moves with the module it protects, and `tsconfig`/ESLint already cover `src/**`. | Plan |
| Optional targets | `beginGeneration` + `lookupRefusalReplay` in; `billedSince` / `readBillableCredits` out | The first two are risk #1 on the same stub; the latter two are risk #2 (Phase 2), and one is blocked by a doc-vs-code conflict. | Plan |
| `refuseAndCharge` extraction | Leave it; state the gap | Phase 2's request-boundary tests cover the body shape and copy without refactoring a 1000-line endpoint on the paid path. | Plan |
| Gate wiring | CI job now; pre-commit stays lint-only | Matches how `lint:tokens` and `build` are already gated, and never blocks a local commit. | Plan |
| Quality tooling | Coverage reporter (no threshold) **and** Stryker | User's call; more toolchain than a four-file suite strictly justifies, so Stryker stays a narrow ad-hoc check, never a CI gate. | Plan |

## Scope

**In scope:** Vitest + coverage config and scripts · the `generateSchema` extraction · unit tests for `summaryCost`, `extractYoutubeId`, the schema, `chargeFailedTranscript`, `beginGeneration`, `lookupRefusalReplay` · a shared stub-client fixture · the CI unit gate · a narrow Stryker run over `credits.ts` · cookbook §6.1 and status sync.

**Out of scope:** extracting `refuseAndCharge` · `billedSince` and `readBillableCredits` (risk #2, Phase 2) · integration, RLS, component and e2e tests · the typecheck gate (Phase 4) · pre-commit test runs · coverage thresholds · unreachable inputs to `summaryCost`.

## Architecture / Approach

Two zero-infrastructure layers. **Pure** functions (`summaryCost`, `extractYoutubeId`, the extracted schema) are called directly. **Hermetic** functions (`chargeFailedTranscript`, `beginGeneration`, `lookupRefusalReplay`) are pure with respect to an injected Supabase client, so a shared fixture supplies a stub exposing only `rpc` — able to resolve data, resolve a structured error, **or reject**, since that third case is the entire reason the `ambiguous` outcome exists. The seam is the injected client, not the paid vendor HTTP boundary, so test-plan §4's "API mocking — see Phase 2" still holds.

Phases 2 and 3 are `/10x-tdd`-eligible (a first red test is nameable in one sentence); phases 1, 4 and 5 are environment, gates and documentation — `/10x-implement`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Runner bootstrap | Vitest + coverage, scripts, and the `summaryCost` suite as proof the path works | `getViteConfig()` does not carry the `@/*` alias — imports fail at resolution, not assertion; a `vitest/config` fallback is defined |
| 2. Trust boundary (#5) | `generateSchema` extracted and asserted; `extractYoutubeId` properties | The obvious test here is wrong — `allowLong: true` unprompted must be asserted as **accepted** |
| 3. Ledger truth table (#1) | Stub fixture; the five-way charge table, `beginGeneration` throws, `lookupRefusalReplay` direction | Collapsing `ambiguous` into "not `notCharged`" — the exact mistake the rule exists to prevent |
| 4. Gates + mutation | `npm test` in CI; Stryker over `credits.ts`, survivors resolved | Chasing the score — an assertion that pins implementation detail is itself a vibe test |
| 5. Cookbook + sync | §6.1 written, §3/§4/§5 updated, `change.md` and MAR-19 moved | Derived docs drifting from the plan; Linear freezing at "started" |

**Prerequisites:** none — research is complete, the branch `testing-phase-1-bootstrap` exists, and no phase needs Docker, a paid key, or a running database.
**Estimated effort:** ~2–3 sessions across 5 phases; phase 3 is the largest and highest-value.

## Open Risks & Assumptions

- **The unswept reservation is real and not closable by a test.** `reconcile_reservation` is operator-run with no scheduler, so a Worker killed between the debit and the persist leaves a debited balance until someone runs the query by hand. It belongs in the risk record and at Phase 2 planning.
- **"Ships silently by design" is half of risk #1 and no test can close it** — the D14 refusal charge is a product decision, not a defect.
- **The `REFUSAL_COPY` lookup and the `ambiguousCharge: true` body shape stay untested until Phase 2**, the accepted cost of not extracting `refuseAndCharge`.
- ~~**`getViteConfig()` loads the full Astro config** (Cloudflare adapter, two Google font families). If that needs network or dominates run time, the plain `vitest/config` fallback applies and gets recorded in §6.6.~~ **RESOLVED in Phase 1 — the fallback was needed.** `getViteConfig()` pulls in `@astrojs/cloudflare`, whose Vite plugin refuses the environment Vitest sets up (`"ssr" environment: resolve.external is incompatible with the Cloudflare Vite plugin`). That is the documented adapter-failure trigger, so `vitest.config.ts` is a plain `vitest/config` `defineConfig` with the explicit `@` alias. Revisit at **rollout Phase 4** (`test-plan.md` §3 — component/e2e), NOT this plan's Phase 4 (gates + mutation): rendering an Astro component is what makes `getViteConfig()` (or an environment split) non-negotiable. Recorded in test-plan §4 and §6.6 at Phase 5.
- ~~**Stryker's `related: true` default may fail to match tests to mutants**; the documented workaround is `"vitest": { "related": false }`.~~ **RESOLVED in Phase 4 — not hit.** The Vitest runner matched tests to mutants on the default settings, so `related` was left alone and `mutate` stayed at the default glob. Recorded in test-plan §6.6.

## Success Criteria (Summary)

- Breaking `summaryCost`'s boundary to `>=`, making `requestId` optional, or returning `notCharged` on a rejected promise each turns the suite red — verified by hand as each test lands.
- A CI run fails on a broken unit test, without CI ever holding a paid vendor key.
- A contributor starting Phase 2 can add a hermetic test from §6.1 alone.
