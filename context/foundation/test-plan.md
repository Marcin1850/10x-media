# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-09-06

## 1. Strategy

Tests follow three non-negotiable principles for this project:

1. **Cost × signal.** The cheapest test that gives a real signal for the risk wins. Do not promote to e2e because e2e "feels safer." Do not put a vision model on top of a deterministic visual diff that already catches the regression.
2. **User concerns are first-class evidence.** Risks anchored in "the team is worried about X, and the failure would surface somewhere in `<area>`" carry the same weight as PRD lines or hot-spot data.
3. **Risks are scenarios, not code locations.** This plan documents *what could fail* and *why we believe it's likely* — drawn from documents, interview, and codebase *signal* (churn, structure, test base). It does NOT claim to know which line owns the failure. That knowledge is produced by `/10x-research` during each rollout phase. If the plan and research disagree about where the failure lives, research is the ground truth.

Hot-spot scope used for likelihood weighting: `src/`, `scripts/`, `supabase/` (excluding `context/`, `dist/`, `node_modules/`, `public/`).

## 2. Risk Map

The top failure scenarios this project must protect against, ordered by risk = impact × likelihood. Risks are failure scenarios in user / business terms, not test names. The Source column cites the *evidence that surfaced this risk* — never a specific file as "where the failure lives" (that is research's job, see §1 principle #3).

| # | Risk (failure scenario) | Impact | Likelihood | Source (evidence — not anchor) |
|---|---|---|---|---|
| 1 | A user's credits are spent and no summary comes back — or a refusal charges them and nothing on screen says so. | Medium | High | interview Q3; roadmap S-01 (plan review reworked the credit flow to close a concurrency budget bypass); roadmap S-09 D14 ("ships silently by design"; four of five refusal exits charge); hot-spot dir `src/pages/api/summaries/` |
| 2 | The app's own credit accounting drifts from what the vendor actually bills, so the budget breaker decides on wrong numbers — refusing while budget remains, or letting the month drain. | Medium | High | interview Q1, Q2; roadmap S-09 D13 (the "a 206 costs 1 credit" rule was *derived* from an internal outcome label, not observed); roadmap S-07 reconciliation practice; hot-spot dir `src/lib/services/` — 61 commits/30d |
| 3 | Budget exhaustion degrades into a broken product instead of a bounded, visible refusal — and an unreadable vendor counter takes generation down with it. | High | Medium | interview Q1 (verbatim); roadmap S-09 D5 (breaker fails open by design) and S-09 status note: the stop threshold and the fail-open paths are **unverified in production** |
| 4 | One account's summaries or video list become reachable by another — or a client reaches the user-agnostic shared caches at all, which would let it forge a transcript into someone else's summary. The PRD's only stated guardrail. | High | Medium | PRD *Success Criteria → Guardrails*, *Access Control*, *Non-Functional Requirements*; roadmap S-05 note (cloud default privileges grant `authenticated` CRUD on **new** tables; only the `anon` half was revoked schema-wide) while S-07 and S-09 both added user-agnostic shared tables; a migration widening a role's privileges on four of those shared tables shipped and was reverted by human review rather than by a test (2026-09-05) |
| 5 | A crafted request drives the paid pipeline for free, or past a guard the UI enforces but the server does not. | High | Medium | PRD FR-003 and Open Question 3 (URL validation rules undefined); roadmap S-09 Phase 3 impl-review finding F1 — an optional key let any authenticated caller drive the paid `unavailable` path for free; hot-spot dir `src/pages/api/` — 32 commits/30d |
| 6 | A UI refactor silently misreports paid work — a card that does not match what was actually charged or saved. | Medium | High | roadmap S-02 Phase 3 ("no behaviour change by design … where the whole slice's regression risk sits"); roadmap S-06 shipped a `charged` signal on three 422 bodies while scoped as presentational; hot-spot dir `src/components/summaries/` — 46 commits/30d |

**Impact calibration note (load-bearing, re-check on any PRD change).** Risks 1 and 2 are scored `Medium` impact because in the MVP the only user is the product creator, so "a user loses credits" is an operator loss, not customer harm. The PRD's *Access Control* section states the structure is prepared for opening registration; **the moment registration opens, risks 1 and 2 return to `High`** and this map must be refreshed. Risks 3, 4 and 5 are `High` independent of user count — 3 takes the product down for everyone, 4 breaks the PRD's only guardrail, 5 is reachable by any authenticated party.

No `High × High` row survives that calibration. Ordering below the top two therefore weighs the `High × Medium` rows (3, 4, 5) against the `Medium × High` rows (1, 2, 6); §3 sequences work so that the earliest phases still cover 3 and 5.

### Risk Response Guidance

| Risk | What would prove protection | Must challenge | Context `/10x-research` must ground | Likely cheapest layer | Anti-pattern to avoid |
|---|---|---|---|---|---|
| #1 | Every terminating path either delivers a summary or leaves the balance where it found it — and any deliberate charge-without-delivery is the documented one, not an accident. | That a refunded failure leaves the user whole. A reservation settled without a summary is a charge. | Where the debit, the reservation settle/refund, and the response body are decided; which exits charge by design and which do not. | Integration at the request boundary, paid vendors faked | Asserting the balance moved by whatever the code computes — the oracle must come from the documented credit rules, not the implementation |
| #2 | The locally-derived spend figure matches the vendor's own free counter across a mixed batch of outcomes. | That a call count is a cost, and that an internal outcome label proves a billing event. | How each outcome maps to billable credits; where a retry is separately billed; whether the vendor's own status is recorded. | Integration, plus reconciliation against the vendor's free counter as an **independent oracle** | Re-implementing the vendor's pricing table inside the test — that proves only that the test agrees with itself |
| #3 | At the stop threshold the refusal is clean: no charge, no partial write, no stranded reservation — and an unreadable vendor counter does **not** take generation down. | That "the breaker exists" means it has ever been tripped. It has not been, in production. | Both breaker check points; the fail-open branch; reservation cleanup on refusal. | Integration with budget state forced rather than earned | Testing only the trip and never the fail-open — the fail-open branch is the one that breaks the product |
| #4 | A request authenticated as one account cannot read another's rows, and a newly added table does not inherit blanket access. | That per-table tightening will be remembered on the next migration. It is a convention with no enforcement point — and the local stack's default privileges *hide* a forgotten revoke that production would expose, so a behavioural probe passes for the wrong reason. | Which policies exist per table and per role; what default privileges apply to newly created tables, and whether the local and cloud defaults agree. | A schema-invariant assertion over the catalog for the "new table" half; integration against the local Supabase stack with two seeded accounts for the "another's rows" half | Testing the service function instead of the policy — the service is not the trust boundary. Equally: proving the new-table property behaviourally, which the local defaults make impossible |
| #5 | The server refuses what the UI would never send: malformed URLs, missing or forged keys, guard-bypassing parameters. | That client-side validation implies server-side validation. | The schema at the trust boundary; which fields are optional, and what optional means on a paid path. | Unit on the schema, integration on the endpoint | Only testing inputs the form is capable of producing |
| #6 | What a card claims about charge and outcome matches what the request actually did. | That "no behaviour change by design" means no behaviour changed. | How the response maps to card state; the charged and refusal signals the UI consumes. | Component / integration, plus one e2e on the happy flow | Snapshot tests — they break on every design tweak and catch none of this |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder via `/10x-new`. Status moves left-to-right through the values below; the orchestrator updates Status as artifacts appear on disk.

| # | Phase name | Goal (one line) | Risks covered | Test types | Status | Change folder |
|---|---|---|---|---|---|---|
| 1 | Test bootstrap + cost/credit rules | Stand up the runner and pin the pure rules that decide what a generation costs and whether it is allowed | #1, #5 | unit | complete | `context/changes/testing-phase-1-bootstrap/` |
| 2 | Paid-path integration | Prove the charge-versus-delivery contract on every exit, and that derived spend reconciles against the vendor's counter | #1, #2, #3, #5 | integration | complete | `context/changes/testing-phase-2-paid-path/` |
| 3 | Data-boundary authorization | Prove one account cannot reach another's rows, including the user-agnostic shared caches | #4 | integration | complete | `context/changes/testing-phase-3-data-boundary/` |
| 4 | Critical-flow e2e | Prove the flow works end to end. The CI floor this phase was to lock is already in place — see the note below | #6, cross-cutting | e2e | researched | `context/changes/testing-phase-4-critical-flow-e2e/` |
| 5 | AI-native summary-quality golden set | Make the PRD's only success metric measurable on a schedule instead of by impression | PRD Open Question 2 | LLM-as-judge, scheduled | not started | — |

**Status vocabulary** (fixed — parser literals): `not started` → `change opened` → `researched` → `planned` → `implementing` → `complete`.

**Linear tracking** (project *10xMedia MVP*, label `test-rollout`): Phase 1 → MAR-19 · Phase 2 → MAR-20 · Phase 3 → MAR-21 · Phase 4 → MAR-22 · Phase 5 → MAR-23. Blocking chain 1 → 2 → 3 → 4, with Phase 5 blocked only by Phase 1 (it needs a runner, nothing else). Per `lessons.md`, a Status change here and the matching Linear state move in the same session.

**Phase 1's research (2026-08-22) settled its own scope, and "unit" above means two layers, not one.** Pure functions alone leave risk #1 with almost no surface — the rules that decide *who pays* (`chargeFailedTranscript`, `beginGeneration`) are pure only with respect to an injected Supabase client. Phase 1 therefore includes **hermetic stub-client tests** as well as pure ones; both are still zero-infrastructure, and §4's "API mocking — see Phase 2" still holds, because the seam here is the injected client, not the paid vendor HTTP boundary. Two other decisions are recorded in the change folder rather than here: `allowLong: true` sent unprompted is **pre-authorization by design**, not a guard bypass; and `generateSchema` moves to `src/lib/schemas/` so the trust boundary is reachable from a test at all.

**Phase 2 carries an open constraint that its research must settle.** Integration tests need clean state between runs. Per-user cleanup covers the per-account tables, but the transcript and metadata caches are user-agnostic (keyed by video id, no owner column), and the vendor budget state is a **singleton row** shared with the local development environment. Forcing the breaker into stop, stale-reading and unreadable-counter states therefore has no user to scope the cleanup to. Either that state is made injectable, or this group of tests needs its own database. `/10x-research` decides; the plan does not pre-empt it.

**Phase 4's gate half shipped early, out of phase order (2026-09-04).** The typecheck gate this phase was to wire is wired: `typecheck` (`tsc --noEmit`) and `typecheck:astro` (`astro check`) exist as npm scripts and both run in CI between `lint:tokens` and `npm test`. Two local layers now sit in front of CI — **pre-commit** runs lint-staged then `typecheck`, **pre-push** runs `typecheck:astro` (~20s, too slow to pay on every commit). Husky had been installed but never wired — no `prepare` script, no `.husky/_`, `core.hooksPath` unset — so `.husky/pre-commit` had never run despite existing; `"prepare": "husky"` fixes that, and a fresh `npm install` now installs the hooks. **What remains of Phase 4 is the e2e half only**, and the §4 note about `getViteConfig()` becoming non-negotiable still belongs to it. **Amended 2026-09-07:** Phase 4's research recommends resolving that §4 note by *deferring* it — the adapter conflict is still live in the installed packages, but it gates in-process Astro rendering only, which Playwright never needs; the phase is scoped to e2e alone. The phase also picked up a **Phase 0 bug fix** (user's call): the header credit balance goes stale after a charged 422 refusal, which a spec written on top of it would silently normalise — see `context/changes/testing-phase-4-critical-flow-e2e/research.md` Finding 5b.

The gap was real rather than theoretical. `astro build` does **not** typecheck — Vite strips types without checking them, verified by building with a deliberate error and getting exit 0 — and ESLint uses type information for its own rules but never reports a TS compile error. Two live type errors had therefore survived in the tree: `TS2344` in `summaries.ts`, where six table shapes declared as `interface` failed `GenericTable`'s `Record<string, unknown>` constraint (TypeScript gives an implicit index signature to a type alias but never to an interface) and collapsed the Supabase client's fourth generic to `never`; and `Banner.astro` passing `class` instead of `className` to a `lucide-react` component, which React drops, so the icon rendered without `banner__icon` and its `flex-shrink: 0` never applied. Both fixed in the same change (`4409f65`, `8e43746`).

**Phase 5 splits the model roles deliberately.** The summaries under judgement are generated by the **production model** — judging output from a cheaper model would measure that model's quality, not the product's, and would specifically fail to detect provider-side drift, which is the reason the phase is scheduled at all. The **judge** runs on a cheap model. Cost is contained through short transcripts and a small fixed golden set, not by substituting the generator. The golden set favours short inputs but keeps one or two long ones so the set still represents the long-video path.

## 4. Stack

The classic test base for this project. AI-native tools carry a `checked:` date so future readers can see which lines need re-verification.

| Layer | Tool | Version | Notes |
|---|---|---|---|
| unit + integration | Vitest (+ `@vitest/coverage-v8`) | 4.1.11 | Wired in Phase 1. `environment: 'node'`, colocated `src/**/*.test.ts`, globals off. **`getViteConfig()` was NOT used** — the recorded fallback (a plain `defineConfig` from `vitest/config`) applies, because the Cloudflare adapter's Vite plugin refuses the environment Vitest sets up; see §6.6. Its cost is the `@/*` alias, which the fallback must declare itself. Revisit at §3 Phase 4, where Astro component rendering makes `getViteConfig()` non-negotiable. |
| Astro component rendering | none yet — see §3 Phase 4 | — | Container API is still `experimental_AstroContainer`. Treat as unstable; prefer testing behaviour through the request boundary where possible. |
| API mocking | `vi.stubGlobal("fetch", …)` + `vi.mock` (Vitest built-ins, no library) | 4.1.11 | Landed in Phase 2. The seam is the **paid vendor HTTP boundary** (transcript provider, LLM gateway): Supadata is faked at `fetch` from the factories in `src/lib/services/__fixtures__/supadata-responses.ts`. Three modules are `vi.mock`ed rather than reached through HTTP because they have no measurable wire shape, only a return value to control: `llm.ts` (the LLM gateway — mocking it IS the paid-boundary fake, not an exception to it) and, in the stub layer only, the two Supabase client constructors. Nothing else internal is mocked. Backstopped by `src/test/fetch-firewall.ts` — see §6.2. |
| database | local Supabase stack (Docker) | CLI ^2.107.0 | Already available via `npx supabase start`. Real RLS, real credit RPCs. See the Phase 2 constraint in §3 and the cleanup exception in §7. |
| e2e | none yet — see §3 Phase 4 | — | Playwright is Astro's documented e2e path. Scope to one or two critical flows, not a page sweep. |
| accessibility | none yet | — | No rollout phase claims this. Listed as a known gap, not a plan. |
| mutation testing | Stryker (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`) | 10.0.0 | **Selective ad-hoc check, explicitly NOT a CI gate** (§5 lists no mutation row). Run narrowly after a risk phase — `npx stryker run --mutate "<file>"` — and resolve each survivor by asking whether the change would hurt a user or the business. No threshold is configured and none should be; a score is not a target. See §6.1. |
| (optional) AI-native quality | LLM-as-judge over a fixed golden set — checked: 2026-08-18 | n/a | **When NOT to use:** never as a merge gate, never in CI, and never before the judge has been calibrated once against the user's own ratings — an uncalibrated judge takes its oracle from a model rather than from the requirement, and then measures model-to-model agreement. |

**Stack grounding tools (current session):**

- Docs: Context7 — verified Astro's own testing guidance (Vitest via `getViteConfig()`, the v6 `environment: 'node'` requirement, `experimental_AstroContainer`, Playwright for e2e); checked: 2026-08-18
- Search: Exa.ai — available, not needed; the official Astro docs answered the stack questions directly; checked: 2026-08-18
- Runtime/browser: Chrome browser tools available; no Playwright MCP in this session. Browser tooling is a manual verification aid, not a test layer; checked: 2026-08-18
- Provider/platform: Cloudflare and Linear MCPs available; no Supabase MCP — the local Docker stack is the database seam. Cloudflare MCP is read-useful for deployed-Worker inspection, not wired into any gate; checked: 2026-08-18

## 5. Quality Gates

The full set of gates that must pass before a change reaches production. "Required after §3 Phase N" means the gate is enforced once that rollout phase lands; before that, the gate is planned.

| Gate | Where | Required? | Catches |
|---|---|---|---|
| lint | local (pre-commit) + CI | required — wired today | syntactic drift, rule violations |
| design-token lint | CI | required — wired today | token drift in the design system |
| build | CI | required — wired today | build-breaking errors |
| typecheck | local (pre-commit) + CI | required — wired today | type drift in `.ts`/`.tsx` (`tsc --noEmit`). Neither the build nor ESLint catches this class of error |
| typecheck (`.astro`) | local (pre-push) + CI | required — wired today | type drift in `.astro` files (`astro check`) — `tsc` cannot parse them, so nothing else covers this |
| unit | local (manual) + CI | required — wired today (`npm test`, in the `ci` job after the typecheck steps and before `build`) | cost and credit rule regressions |
| integration | local + CI | required — wired today (`npm run test:integration`, `integration` job in `.github/workflows/ci.yml`; `deploy` needs both `ci` and `integration`) | charge-versus-delivery regressions, breaker behaviour, and the data-access boundary — cross-account isolation and the schema's grant/policy/RLS shape (§6.3) |
| e2e on critical flows | CI on PR | required after §3 Phase 4 | broken generate-and-see-it flow |
| summary-quality golden set | scheduled, outside CI | optional after §3 Phase 5 | prompt regressions and provider-side model drift |
| pre-prod smoke | between merge and prod | optional | environment-specific failures; already practised manually per slice |

## 6. Cookbook Patterns

How to add new tests in this project. Each sub-section is filled in once the relevant rollout phase ships; before that, the sub-section reads "TBD — see §3 Phase N."

### 6.1 Adding a unit test

**Where the file goes.** Colocated next to the module it covers, named `<module>.test.ts` — `src/lib/services/summaries.test.ts` covers `src/lib/services/summaries.ts`. No separate `tests/` tree: `tsconfig.json` and `eslint.config.js` already apply to `src/**`, so a colocated test is type-checked-linted under `strictTypeChecked` the moment it lands, and the build ignores it (Astro only pulls what pages import). The runner picks it up through `include: ["src/**/*.test.ts"]` in `vitest.config.ts`.

**Imports are explicit — globals are off.** Start every file with `import { describe, expect, it } from "vitest";` (add `vi`, `beforeEach`, `afterEach` as needed). Enabling `globals: true` would require a `types` entry in `tsconfig.json`, which is shared with the app build; explicit imports keep the runner out of the application's type configuration. Import the module under test through the `@/` alias (`@/lib/services/summaries`). Its canonical mapping lives in `tsconfig.json` (`paths`), which is what type-checks the import; `vitest.config.ts` must mirror it as a `resolve.alias` because the plain `vitest/config` setup used here does not inherit `tsconfig` paths. Both copies have to agree, so exercising the alias is part of what the suite proves.

**Two layers. Pick the cheaper one that still gives a signal.**

| Layer | What it covers | How |
|---|---|---|
| Pure | Functions with no dependencies — `summaryCost`, `extractYoutubeId`, `generateSchema`. | Call directly, assert the return value. |
| Hermetic | Functions pure *with respect to an injected client* — `beginGeneration`, `chargeFailedTranscript`, `lookupRefusalReplay`. | Pass a stub client from `src/lib/services/__fixtures__/supabase-stub.ts`. |

The hermetic seam is the **injected client**, not the paid vendor HTTP boundary — nothing here mocks `fetch` or Supabase's transport. API mocking is still Phase 2's (§6.2).

**Reaching a hermetic function.** `__fixtures__/supabase-stub.ts` builds a bare object exposing only `rpc`, cast to `SupabaseClient` at the boundary (production signatures take supabase-js's untyped default client, so no production type changes for a test). Three factories, because the ledger distinguishes three failure worlds and conflating them is the bug these tests exist to catch:

```ts
import { stubReturning, stubFailing, stubRejecting } from "@/lib/services/__fixtures__/supabase-stub";

// PostgREST answered: { data, error: null }
const ok = stubReturning([{ outcome: "charged", new_balance: 4 }]);
const result = await chargeFailedTranscript(ok.client, PARAMS);
expect(result).toEqual({ outcome: "charged", balance: 4 });
expect(ok.rpc).toHaveBeenCalledWith("charge_failed_transcript", { /* … */ }); // assert what reached the ledger

// Structured error: the statement rolled back — the one shape that PROVES nothing was written.
await expect(chargeFailedTranscript(stubFailing().client, PARAMS)).resolves.toEqual({ outcome: "notCharged" });

// Rejected promise: transport died, possibly AFTER Postgres committed — proves nothing either way.
await expect(chargeFailedTranscript(stubRejecting().client, PARAMS)).resolves.toEqual({ outcome: "ambiguous" });
```

Assert each outcome **by its own shape**, never as the negation of another (`ambiguous` is not "not `notCharged`") — collapsing the two is precisely the regression being guarded. Services that `console.error` an operator marker on a failure branch: silence the console with `vi.spyOn(console, "error")` in `beforeEach` so a green run stays readable, but **do not assert the marker strings** — they are log copy, not a contract any consumer reads.

**The oracle rule — non-negotiable.** What the code *should* do comes from the PRD, the README's credit rules, roadmap decisions, or a function's own documented contract. It never comes from reading the implementation. A test that recomputes the expected value the way the code does passes against the bug. In practice: write the threshold as the literal `40_000` the documents state, and pin the exported constant separately, so a silent retune goes red. Where the sources do not resolve a value unambiguously, **stop and ask** — do not assert it. Head each `describe` block with a comment naming the source (`Oracle: README §Summary credits and roadmap S-01`), so a future reader can re-derive the assertion without re-reading the code.

**One `it.each` per property, not six near-identical cases.** Each row is a table entry with a third column saying what that row proves; each row must catch a different regression. Include at least one edge case per risk — the boundary value, `null`/empty, a dependency error, an invalid input — and do **not** invent inputs the caller cannot produce (`summaryCost` receives `content.length`, so negative and `NaN` are unreachable and untested).

**Running it.**

```
npm test            # single run — the CI entry point
npm run test:watch  # while writing
npm run test:coverage  # v8 report into coverage/, no thresholds by design
```

**Mutation check — narrow and deliberate, never a CI gate.** After a risk phase's tests are green, ask the question coverage cannot: would a test fail if this rule were broken?

```
npx stryker run --mutate "src/lib/services/credits.ts"
```

Scope it to the module you just covered (the default `mutate` glob already excludes `*.test.ts`). Open `reports/mutation/mutation.html` and put every survivor to one question: **would this change hurt a user or the business?** Yes ⇒ add the assertion that kills it. No (equivalent or cosmetic) ⇒ ignore it consciously and write the reason down in the test file's header comment. Do not chase a score — a test that pins an implementation detail purely to kill a cosmetic mutant is itself a vibe test.

### 6.2 Adding an integration test

**Two projects, one runner.** `vitest.config.ts` defines `unit` (`npm test`, colocated `*.test.ts`) and `integration` (`npm run test:integration`, colocated `*.int.test.ts`). Both inherit the same `@/*` and `astro:env/server` aliases from the root config; only the integration project carries the two safety hooks — `globalSetup: ["./src/test/integration-setup.ts"]` (once per run: the loopback guard and the stale-row sweep) and `setupFiles: ["./src/test/fetch-firewall.ts"]` (once per test *file*: the paid-vendor `fetch` firewall and placeholder vendor keys). Neither is inherited under `extends: true`, which is deliberate — the unit project must never pay for them. Name a new integration file `<module>.int.test.ts` next to what it covers, same colocation rule as §6.1.

**Which layer, decided by one question: does the assertion need a real balance?**

| Layer | Answers | Fakes | Cleanup |
|---|---|---|---|
| Stub | Refusal exits and their `charged` signal, the budget breaker's trip and every fail-open branch, ledger-payload reconciliation, trust-boundary/schema rejections. | `vi.stubGlobal("fetch", …)` for Supadata (factories in `src/lib/services/__fixtures__/supadata-responses.ts`), `vi.mock` for `llm.ts` and the two Supabase client constructors. | None — no database connection opens. |
| Real database | Anything where the assertion IS a balance read before/after: success debits the documented cost, a failure refunds, `insufficient` at the threshold, replay-on-`requestId`, exit #34's branches. | **`llm.ts` only.** Supadata is not faked at `fetch` here — it is never called: each scenario pre-seeds `transcript_cache` **and** `metadata_cache` so both Supadata checkpoints are cache HITS, and a cache hit bypasses the budget breaker by construction. `@/lib/supabase` and `@/lib/supabase-admin` stay REAL (that is the point of the layer); exactly one test swaps in a proxy that fails one named RPC. | **Two steps, both required** — see the cleanup recipe below. |

**How the real-DB layer avoids Supadata — read this before copying the stub layer's approach.** It does *not* stub `fetch`. It calls the same `save_transcript_cache` / `save_metadata_cache` RPCs `generate.ts` itself uses, so the endpoint's own cache lookups hit. That is deliberate: seeding through the production write path means the test exercises the real cache-hit branch rather than a stand-in for it. It also means **`transcript_cache` and `metadata_cache` ARE written from this layer** — so the cleanup step below is not optional.

**The `fetch` firewall backstops all of the above (`src/test/fetch-firewall.ts`, a `setupFiles` entry on the integration project).** Every integration test starts with `fetch` replaced by a guard that permits loopback and `throw`s on anything else, so a regression in cache lookup, TTL, or language matching fails the test instead of billing a live vendor. It also overwrites `SUPADATA_API_KEY`/`OPENROUTER_API_KEY` with placeholders at module scope, before any test file's imports, so the real `.env` values `npm run test:integration` loads can never reach a vendor call. Two consequences when writing a test: a stub-layer test that wants scripted vendor responses stubs `fetch` itself as usual (`stubSupadataFetch`) and the `afterEach` re-installs the firewall — never the native `fetch`; and any *new* integration entry point must keep both `setupFiles` and `globalSetup`, or both guards are gone.

**Reaching cache and ledger tables: use the table-owner connection, not `service_role` (`src/test/db-owner.ts`).** `transcript_cache`, `metadata_cache`, `credit_reservations` and `supadata_calls` deliberately grant `service_role` no direct table privileges — the app reaches them only through `SECURITY DEFINER` RPCs, and widening the production request-path secret so a test harness could read them was rejected in review (impl-review.md F2). **That sentence was true of the local stack only until 2026-09-06.** Every internal table's migration revokes from `public, anon, authenticated` and stops there, which suffices against the local default of `Dxtm` but not against the cloud default of `arwdDxtm` — so on the cloud project `service_role` held full CRUD on all nine internal tables from the day each was created. `20260906120000_revoke_service_role_internal_tables.sql` closed it; a new internal table must now revoke from `public, anon, authenticated, service_role` (§6.3, §6.6 Phase 3). `getDbOwnerConnection()` returns a loopback-validated `postgres` client that reaches those rows without touching any application role. Use it for direct `select`/`delete` in setup, assertions, and cleanup; use `admin` (service-role) for RPCs, `auth.admin`, and the tables that do grant it access (`user_credits`, `summaries`).

Never add a second local database or a fresh-fetch path against the real one — no integration test may fetch a transcript or call the LLM for real (§7).

**Vendor fixtures.** Every Supadata response shape used anywhere in the suite lives in `src/lib/services/__fixtures__/supadata-responses.ts`, one factory per shape, each with a comment citing the measured value and its date in `context/changes/persist-time-and-cost/docs/supadata-billable-requests.md` (or, for a shape that exercises the code's own defensive contract rather than a vendor measurement, the source file that documents that contract instead). Add a new factory there — never inline a hand-built `Response` in a test — and cite your source the same way. `llm.ts` is `vi.mock`ed directly in every file that reaches it (both layers); the two Supabase client constructors are mocked in the stub layer only. There is no fixture file for either — no shape to measure, only a return value to control.

**Real-database cleanup — TWO steps, in this order. `dispose()` alone is not enough.** The caches are user-agnostic, so nothing about deleting the account touches them:

```ts
async function withAccount(youtubeId: string, run: (a: SyntheticAccount) => Promise<void>) {
  const account = await createSyntheticAccount(admin);
  try {
    await run(account);
  } finally {
    await cleanupCaches(youtubeId);      // 1. the rows YOU seeded — dispose() never touches these
    await account.dispose([youtubeId]);  // 2. supadata_calls by youtube_id, THEN the auth.users row
  }
}
```

1. **Delete the cache rows you seeded**, by `youtube_id`, through the owner connection. Skipping this leaves a `transcript_cache`/`metadata_cache` row that survives your run and makes the *next* run's global setup abort (see the stale-fixture guard below) — or, worse, silently satisfies a later test's cache-hit assumption for the wrong reason.
2. **Then `dispose([youtubeId])`.** Order matters inside it too: `supadata_calls` is `on delete set null`, so it survives account deletion and must go **first**, then the `auth.users` row, whose cascade removes everything else per-user (`user_credits`, `credit_reservations`, `videos`, `summaries`, locks/limits). It **throws** on any cleanup failure rather than returning quietly (impl-review.md F3) — a leak is reported against the test that caused it, not as an unrelated abort next run.

Register every fixture id in `src/test/synthetic-fixtures.ts` (`RESERVED_YOUTUBE_IDS`) so the stale-row guard knows to look for it, and keep ids synthetic — never a real YouTube id, and never a real address or user id anywhere in a test file (`lessons.md`).

**What survives a hard kill is detected, not cleaned.** `dispose()` runs in a `try/finally`, which covers a controlled failure (an assertion throws, an RPC errors) but not `SIGKILL`, which skips `finally` entirely. For that case `integration-setup.ts`'s `globalSetup` sweeps for leftover cache rows (by `RESERVED_YOUTUBE_IDS`) and synthetic accounts (by `SYNTHETIC_ACCOUNT_EMAIL_PREFIX`) and **aborts the next run with named repair instructions** rather than silently reusing stale state. If you hit that abort, delete the rows it names and re-run.

**The loopback guard is not optional context — it is why this layer is safe to run at all.** `assertLoopbackSupabaseUrl` in `integration-setup.ts` refuses to run unless `SUPABASE_URL` resolves to `localhost`/`127.0.0.1`/`::1`. Never bypass it, and never wire a new integration entry point that skips `globalSetup`.

**The oracle rule from §6.1 applies unchanged** — README credit rules, roadmap decisions, `supadata-billable-requests.md`'s measurements, never the implementation. Head each `describe` block with the source, same convention as a unit test.

**Running it.**

```
npx supabase start          # once, local stack up (requires Docker)
npm run test:integration    # single run against that stack
```

CI runs the same command in the `integration` job (`.github/workflows/ci.yml`), against a throwaway stack started with `supabase start -x <non-essential services>`, using the Supabase CLI's fixed local demo keys and literal placeholder vendor keys (safe — every paid vendor call is faked). `deploy` needs both `ci` and `integration` to pass.

### 6.3 Adding a test for a data-access policy

Risk #4 — "one account's summaries or video list become reachable by another, or a client reaches the user-agnostic shared caches at all" — is covered by **two layers that prove different things**. Decide which one a new assertion belongs in before writing it; putting it in the wrong layer is the main way this coverage goes quiet.

| Layer                                                                                                                                    | File                                                                                                                                            | Proves                                                                                                                                                                                                                                                                                                                                                                                                              | Cannot prove                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog invariant** — read `pg_catalog` through the owner connection, compare against a hand-written roster committed in the test file | `src/test/authorization-invariants.int.test.ts` (9 invariants)                                                                                  | The _shape_: every relation in `public` is classified; RLS is on; `anon` holds nothing at all; `authenticated` holds exactly the roster's verbs and no function EXECUTE; every granted verb has one matching policy whose `using` clause is still `auth.uid() = user_id`; `service_role` holds no privilege at all on the internal tables; the schema-wide `anon` default-privilege revoke is intact; `graphql_public` has zero relations and exactly the expected `graphql(...)` function. | That a policy which _exists_ actually filters a live request — and that application code does not reach rows **around** RLS, which the admin client does by design.                                                  |
| **Behavioural probe** — two real signed-in sessions, unfiltered reads                                                                    | `src/test/cross-account-policy.int.test.ts` (6 probes), plus the cross-account replay case in `src/pages/api/summaries/generate.db.int.test.ts` | That the policies _work_ end to end — cookie header → the app's own `parseCookieHeader` → JWT → `auth.uid()` → PostgREST — including the **second** policy evaluation an embedded table triggers, and that an id derived by application code is owner-scoped at the one place RLS is switched off.                                                                                                                  | The "a newly added table inherits blanket access" half — the local stack's default privileges hide it (see below). Also nothing about a role nobody signs in as: `service_role`, or `anon` beyond a signed-out read. |

**Rule of thumb for a new assertion.** _"A migration could get this wrong"_ → catalog. _"A request could get this wrong"_ → behavioural. A new client-readable table is both, and needs a roster entry **and** a probe row. A new `SECURITY DEFINER` RPC is catalog-only (invariants 3 and 5) — unless application code reads its result back without a `user_id` predicate, which makes it a replay-boundary case too.

**The two-account pattern.** Six rules; the first four are what make the probe mean anything.

1. **Seed through the table-owner connection** (`getDbOwnerConnection()`), not through an endpoint. `cross-account-policy.int.test.ts`'s `seed()` inserts one `videos` row and one `summaries` row directly — no generation, no transcript, no LLM, so §7's paid-vendor rule is satisfied by construction rather than by a mock.
2. **Assert through an RLS-scoped session client built from the account's cookie header** — `createClient(new Headers({ Cookie: account.cookieHeader }), …)`, the app's own factory from `@/lib/supabase`. That is what makes the session under test the one production builds; `synthetic-account.ts` needs no change for it. The local stack is loopback, so `fetch-firewall.ts` permits the calls.
3. **Never call `listSummaries` or `getBalance`, and never pass a `user_id` filter.** Both services apply `.eq("user_id", …)` on top of RLS (`summary-list.ts:58`, `credits.ts:31`). That is good defence in depth in production and a _mask_ over exactly the regression under test: broaden a policy to `using (true)` and a `userId`-filtered read still returns only the caller's rows, green. Every read in the probe is therefore unfiltered, or filtered only by the **other** account's row id. The one prior manual cross-account check in this repo disclaims itself for precisely this reason (`context/changes/browse-summary-list/reviews/manual-verification-phase-1.md:67-75`). Do not add a `user_id` filter to "make a test more precise" — it removes the test.
4. **Never assert what a user can see through an owner or `service_role` connection.** Both bypass RLS by definition and would go green against a broken policy. The owner connection appears only to _seed_, and to _read back_ what a denied `DELETE` must have left intact — "PostgREST reported no rows deleted" and "nothing was destroyed" are different claims, and only the second one is the user's data still existing.
5. **Dispose both accounts in nested `try/finally`.** `dispose()` throws by design (impl-review.md F3) and a leaked `auth.users` row aborts the _next_ run's stale-account guard, so a first disposal that throws must not swallow the second. See `withTwoSeededAccounts`.
6. **Per-user fixtures need no `RESERVED_YOUTUBE_IDS` entry.** That registry guards the _user-agnostic_ caches (§6.2); rows seeded into `videos`/`summaries` leave with `dispose()`'s `auth.users` cascade. Register an id there only if your test writes a cache row.

Cover the verbs `authenticated` actually holds, not the ones it might: `SELECT` on all three client-readable tables (unfiltered), `SELECT` by the other account's primary key (a policy can shape a _list_ and still hand over a row asked for by name — the guardrail is "not reachable", not "hard to guess"), `DELETE` on the two tables that grant it, the production embed shape (`summary-list.ts:46-48` — an embedded table is a second policy evaluation, so the production query must survive it intact; it is **not** a second oracle for a broadened `videos` policy, because the composite ownership foreign key means a visible summary can only reference its own account's video — the unfiltered `videos` probe is what catches that), and a signed-out session against each table.

**The catalog-invariant pattern, and the roster's maintenance contract.** The oracle is a **hand-written, default-deny roster** committed at the top of the test file, each entry citing the migration that justifies it — `CLIENT_READABLE` (table → the exact verbs `authenticated` holds) and `INTERNAL` (RLS on, zero policies, `revoke all` — denial at the privilege layer, strictly stronger than an owner-scoped policy). Anything in `public` on neither list fails invariant 1 by name.

- **A generated snapshot was rejected and must stay rejected.** Its oracle would be the current catalog, and the fix for a red run would be `--update` — the vibe-test failure mode §6.1 rules out.
- **Adding a table means classifying it here.** That edit is not overhead, it is the deliverable: the per-table tightening convention (`20260714140000:36-40`) had no enforcement point until this file existed, and the first thing the enforcement point found was an un-tightened role in production (§6.6, Phase 3).
- **Assert effective privileges, never ACL arrays.** Everything goes through `has_table_privilege` / `has_function_privilege`. A function created without an explicit `revoke` lands with `proacl = NULL`, which means EXECUTE **to `PUBLIC`** — and `aclexplode(proacl)` cannot see that, because `PUBLIC` is grantee oid 0 and joins to no row in `pg_roles`. An `aclexplode` version of invariant 5 would pass against a client-callable RPC.
- **Scope every function assertion to `nspname = 'public'`.** `graphql_public.graphql()` _is_ EXECUTE-able by `anon` and `authenticated` by design (`supabase/config.toml:13`); an unscoped query goes red for a reason that is not a finding. The residual worth pinning is that `graphql_public` holds zero relations and exactly that one function — invariant 9.
- **Apply no privilege pressure of your own.** `pg_catalog` reads need no grant, so this layer creates nothing, grants nothing, and needs no cleanup (`fetch-firewall.ts`'s `afterAll` closes the owner pool). If an assertion seems to need a grant, reach around the boundary with `getDbOwnerConnection()` instead of widening it — `20260904130000_test_support_grants.sql` widened `service_role` for a harness's convenience, shipped in `d8f37f1`, and was reverted in `e0fdb0d` by human review rather than by any test.

**Why the "new table" half cannot be proven behaviourally — and the rule that follows.** The two environments' default privileges disagree. Verified against the cloud project on 2026-09-06 (grantor `postgres`, schema `public`):

| New object created by a migration | cloud                                | local                                                                   |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| table                             | `authenticated=arwdDxtm` — full CRUD | `authenticated=Dxtm` — TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, **no DML** |
| function                          | `authenticated=X`                    | _(absent)_                                                              |
| sequence                          | `authenticated=rwU`                  | `authenticated=w`                                                       |

A test that creates a table and tries to read it as `authenticated` is therefore **denied locally for the wrong reason**, while the same forgotten revoke leaves that table wide open in production. The catalog is the only layer that can express the property, and it expresses it as shape rather than behaviour: a tightened table shows **no `authenticated` entry at all**, an untightened one shows a stray `Dxtm` — which on cloud means full CRUD. Invariant 4 goes red either way, which is what makes it environment-independent.

The general rule, learned twice in this phase (§6.6, Phase 3): **an invariant that holds because of a _default_ privilege pins only the environment it runs in.** Invariant 9 reads `pg_default_acl` and is local-only by nature; the guarantee has to be carried by the per-object assertions (1–8). When you add an assertion here, ask which of the two you have written.

### 6.4 Adding an e2e test

- TBD — see §3 Phase 4.

### 6.5 Adding a case to the summary-quality golden set

- TBD — see §3 Phase 5. Will cover where golden inputs live, how the judge is calibrated, and the run cadence.

### 6.6 Per-rollout-phase notes

(Filled in as phases land — anything surprising a phase taught that the next phase should not rediscover.)

**Phase 1 — Test bootstrap + cost/credit rules (2026-08-23, `testing-phase-1-bootstrap`).**

- **`getViteConfig()` does not work here, and the fallback was used.** Loading `astro.config.mjs` brings in `@astrojs/cloudflare`, whose Vite plugin rejects the environment Vitest sets up: *"The following environment options are incompatible with the Cloudflare Vite plugin: 'ssr' environment: `resolve.external`"*. That is the adapter-failure trigger the plan recorded, so `vitest.config.ts` is a plain `defineConfig` from `vitest/config`. Legitimate at this layer because no unit target imports `astro:env`, a `.astro` file, or `@supadata/js` — the three things the full Astro config exists to make resolvable. Phase 4 (component rendering, e2e) will need `getViteConfig()` or an environment split, and will have to solve the adapter conflict rather than inherit this shortcut.
- **The `@/*` alias is the fallback's price, and it is load-bearing.** `astro.config.mjs` never declares it either — Astro reads it from `tsconfig.json` during its own build. Vite alone does not. Without the explicit `resolve.alias` in `vitest.config.ts`, every test importing `@/lib/…` fails at *import* time with a resolution error, which reads nothing like an assertion failure. Any future config (including a `getViteConfig()` one) must carry it.
- **A module that imports `astro:env/server` is unreachable from a unit test.** That is why `generateSchema` moved out of `src/pages/api/summaries/generate.ts` into `src/lib/schemas/generate-summary.ts` — a pure move, same fields and defaults. Expect the same constraint on anything else worth testing that currently lives inside an endpoint; Phase 2's request-boundary tests need a different answer, since they exercise the endpoint itself.
- **Stryker's Vitest runner worked on the default settings.** The documented `"vitest": { "related": false }` contingency was **not** needed, and `mutate` was left at the default glob (which already excludes `*.test.ts`). Reports land in `reports/mutation/mutation.html`; `reports/` and `.stryker-tmp/` are gitignored. Note that `.gitignore` feeds ESLint via `includeIgnoreFile`, so anything ignored there is also unlinted — that is the reason `coverage/` had to be added there and not only to the runner config.
- **Zod 4's `z.uuid()` accepts any RFC 9562/4122 version, v1–v8** (verified via Context7, 2026-08-22). The roadmap's phrasing "rejects a hand-typed non-v4 key" is loose; a test asserting a valid v1 UUID is rejected would fail. The field's contract is stable idempotency identity, which any RFC UUID satisfies.
- **Known gap handed to Phase 2, deliberately.** `refuseAndCharge` / `refusalResponse` were not extracted from the endpoint, so the `REFUSAL_COPY` lookup and the `ambiguousCharge: true` body shape stay uncovered. The request-boundary integration tests cover both without any refactor. `readBillableCredits` was also handed over blocked on a doc-vs-code conflict (the doc prescribed `Number.parseInt`; the code rejects anything not `/^\d+$/`) — **unblocked 2026-09-04**: the doc's §Parsing contract now states the strict rule and says why prefix-parsing would fabricate a measurement, so the oracle is a source rather than a mirror. The same pass corrected the function's own JSDoc, which still called the header's unit open after the doc had settled it as credits on 2026-07-29.

**Phase 2 — Paid-path integration (2026-09-04, `testing-phase-2-paid-path`).**

- **Correction to Phase 1's claim above: "unreachable from a unit test" is narrower than it reads.** The constraint is real for the plain `unit` project (no test there imports `astro:env/server`, and none should), but the endpoint itself — `generate.ts`, `supabase.ts`, `supabase-admin.ts`, `config-status.ts` — is reachable from the **integration** project without any production refactor, by aliasing the virtual `astro:env/server` specifier to a plain module (`src/test/astro-env-server-stub.ts`) that re-exports the five schema keys off `process.env`, declared once at the config root and inherited by both projects (`extends: true`) so the two can never diverge (a divergent alias fails at import time with an error that reads nothing like an assertion failure — confirmed the hard way during this phase). `getViteConfig()` was still not needed; the adapter only enters through `astro.config.mjs`, which a plain `vitest/config` never loads.
- **A real Supabase session reaches a test handler as a `Cookie` header string, not an `AstroCookies` object.** `src/lib/supabase.ts`'s `createClient` reads the raw header. The real-database layer's `synthetic-account.ts` therefore signs in through the same `createServerClient` the app uses, against an in-memory cookie jar, and joins the jar into a `name=value; …` string for the request — this is what makes the layer prove the app's real cookie parsing, not a stand-in for it.
- **`transcript_cache` / `metadata_cache` are user-agnostic, and the vendor budget row is a shared singleton.** Neither carries an owner column, so per-account cleanup cannot reach them. The real-database layer avoids the hazard by construction — it only ever seeds a cache row to bypass the breaker, never forces a fresh fetch or a breaker trip — and `integration-setup.ts` sweeps for a stale cache row or a stale synthetic account left by a hard-killed prior run before any test in either layer starts.
- **`supadata_calls` survives account deletion (`on delete set null`) — cleanup order is load-bearing.** Delete by `youtube_id` **before** deleting the `auth.users` row; reversed, the rows silently orphan into the exact ledger risk #2 sums.
- **CI wiring needed no `secrets.SUPABASE_URL`.** The `integration` job (`.github/workflows/ci.yml`) sets all five env keys inline: the Supabase CLI's fixed, publicly documented local-dev demo keys for the three Supabase values, and literal placeholder strings for the two vendor keys — safe because `fetch` is stubbed and `llm.ts` is `vi.mock`ed, so nothing reaches a real vendor. `supabase start -x <services>` excludes everything the tests don't touch (analytics, edge-runtime, functions, imgproxy, inbucket, meta, realtime, storage, studio, vector); `auth` and `kong` cannot be excluded and were never meant to be — `kong` is the gateway `SUPABASE_URL` points at.

**Phase 3 — Data-boundary authorization (2026-09-06, `testing-phase-3-data-boundary`).**

- **The phase's stated premise was wrong, and the schema won the argument.** §2 risk #4 feared the user-agnostic shared caches S-07/S-09 added were an open door. They are not: all nine internal tables carry RLS on, **zero policies**, and `revoke all ... from public, anon, authenticated`, which denies a client at the _privilege_ layer — strictly stronger than an owner-scoped policy, because RLS is never even consulted. The real exposure was never the tables that exist; it is the next migration. That is what the catalog invariant covers, and it is why this phase's most valuable artifact is a roster rather than a probe.
- **`Dxtm` is signal, and it means different things per role.** `MAINTAIN,REFERENCES,TRIGGER,TRUNCATE` is what the local `postgres` default privileges hand out; it contains no DML. For `authenticated` on a table outside the allow-list its _presence_ is the forgotten-revoke signal and must fail (invariant 4). It is the same signal for `service_role` on the nine internal tables — but only since `20260906120000_revoke_service_role_internal_tables.sql` revoked those privileges outright, so invariant 8 asserts **zero** privileges rather than zero DML. Asserting only DML would leave a future internal table whose migration forgets `service_role` green locally on its inherited `Dxtm` while the cloud default (`arwdDxtm`) recreates the full-DML divergence this phase closed.
- **`pg_catalog` reads need no grant, which is why this phase applied no privilege pressure.** The whole layer runs through `getDbOwnerConnection()` and creates nothing. That matters because the failure it exists to catch is a test harness widening production privileges for its own convenience — `20260904130000_test_support_grants.sql`, shipped in `d8f37f1`, reverted in `e0fdb0d` by human review with no test involved.
- **A function with no explicit ACL is EXECUTE-able by `PUBLIC` — and an `aclexplode` query cannot see it.** Verified locally in a rolled-back transaction: a function created by `postgres` in `public` lands with `proacl = NULL`, and `has_function_privilege('anon', …, 'EXECUTE')` returns **true**. `PUBLIC` is grantee oid 0, which joins to no row in `pg_roles`, so the ACL-array form would have passed against a client-callable RPC. Every role assertion in the file therefore goes through `has_table_privilege` / `has_function_privilege`. Consequence for migrations: `revoke all on function … from public, anon, authenticated` — **`public` is the load-bearing word**, and without it the function is client-callable in both environments.
- **`graphql_public` was cheaper to pin than research feared.** Zero relations, exactly one function (`graphql(operationName text, query text, variables jsonb, extensions jsonb)`), and `pg_depend` shows it is **not** extension-owned, so a pg_graphql upgrade will not move it. No maintained exclusion list is needed — but every function assertion must be scoped to `nspname = 'public'`, because that one function _is_ EXECUTE-able by `anon`/`authenticated` by design.
- **The roster's maintenance cost is the deliverable, not a tax.** Adding a table to `public` now means classifying it in `src/test/authorization-invariants.int.test.ts` or invariant 1 fails naming it. A generated snapshot was rejected because its oracle would be the current catalog and its repair would be `--update`.
- **The cloud pass found a live production divergence, which is the enforcement point working as designed.** `service_role` held all four DML verbs on all nine internal tables on cloud and none locally, because every internal table's migration revokes from `public, anon, authenticated` and stops there — sufficient against the local default of `Dxtm`, useless against the cloud default of `arwdDxtm`. So the intent recorded in `db-owner.ts:6-11` and §6.2 had **only ever held locally**. Closed by `20260906120000_revoke_service_role_internal_tables.sql` (a cloud-only correction — locally a near-no-op). Not a breach of the PRD guardrail: `service_role` carries `rolbypassrls` and is a server-only secret. What was lost and restored is defence in depth. It also re-reads `d8f37f1` → `e0fdb0d`: reverting that migration was still right, but its stated rationale ("permanently widens what the production request-path secret can do") did not hold — on cloud those four tables already granted `service_role` everything. **A new internal table must revoke from `public, anon, authenticated, service_role`.**
- **The rule those two findings share: an invariant that holds because of a _default_ privilege pins only the environment it runs in.** Invariant 9 reads `pg_default_acl` and is local-only by nature; invariant 8 looked environment-independent and was not. The guarantee has to be carried by the per-object assertions, and the local/cloud divergence has to be re-verified by hand and dated — 2026-09-06, written up in `context/changes/testing-phase-3-data-boundary/plan.md`, "Cloud verification pass". CI must never hold production credentials, so no test can do this for us.
- **A service function's own `.eq("user_id", …)` masks the regression this phase tests.** `listSummaries` and `getBalance` both filter by `userId` on top of RLS; drive either one and a policy broadened to `using (true)` still passes. Every behavioural read goes through the app's `createClient` with the account's cookie header and carries **no** `user_id` filter. Same reason the one prior manual cross-account check disclaims itself (`browse-summary-list/reviews/manual-verification-phase-1.md:67-75`). The redundant service-layer filter stays — it is defence in depth; the point is to test around it.
- **`readStoredSummary` is the one place application code, not RLS, is the trust boundary** (`summaries.ts:387-404` — admin client, read by id, no `user_id` predicate). Safe because `begin_generation` derives that id double-scoped (`20260723130000:123-128,143-144`) and the partial unique index behind `requestId` is on `(user_id, request_id)`, not `request_id` alone (`20260723130000:48-50`). Two accounts posting the **same** client-supplied `requestId` each generate their own summary; that case now proves it instead of arguing it.

## 7. What We Deliberately Don't Test

Exclusions agreed during the rollout. Future contributors should respect these unless the underlying assumption changes.

- **Anything that spends real transcript-provider or LLM credits in CI** — hard rule; CI holds no such keys and must never need them. Re-evaluate only if a free sandbox tier appears. (Source: interview Q5.)
- **The Polish copy module as a string table** — a test would restate the strings. Re-evaluate if copy gains logic (pluralisation, interpolation branching).
- **Vendored `shadcn/ui` primitives** — upstream is the test. Re-evaluate for any component hand-modified after generation.
- **Snapshot tests on summary cards** — they break on every design tweak and catch none of the risks in §2. Re-evaluate never; use behavioural assertions instead.
- **Prompt injection through transcript content** — the guardrail does not exist yet (roadmap S-10 is `proposed`). Testing it now would mean building the safeguard first. S-10 brings its own test when it lands, following §6.
- **The Whisper job transcript path** — unreachable by construction under roadmap S-09 D1. Re-evaluate only if that decision is reversed.
- **Live vendor contact of any kind in the paid-path integration layer, including the free `GET /v1/me`** (§3 Phase 2, decided at plan time). Reconciliation (risk #2) runs entirely against recorded response fixtures (`supadata-responses.ts`), each pinned to a measured value and date. **What this buys**: the mapping from a vendor outcome to a ledger figure is proven — a `206` really does record `billable_credits: null`, not `0`. **What it cannot catch**: the vendor changing its own pricing, silently dropping the `x-billable-requests` header, or `/v1/me`'s figures drifting from actual billing — none of that reaches the suite until a fixture is re-measured by hand. Re-evaluate if a free-tier sandbox becomes safe to call from CI (same condition as the first bullet above), or if a production billing surprise traces back to a vendor-side change a fixture didn't reflect.

**Scoped exception to the "never wipe the local database" lesson.** `lessons.md` forbids destructive operations against the local database because its data was bought with real credits. Rollout phases may delete rows **scoped to synthetic test accounts and synthetic video identifiers only**. A full reset, a truncate, or any deletion that is not key-scoped remains forbidden and still requires explicit consent. The singleton budget row is not covered by this exception — see the §3 Phase 2 constraint.

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-09-04 (§5's typecheck row moved from *planned* to *wired*, and split in two once it was clear `tsc` and `astro check` cover disjoint file sets, see the Phase 4 note in §3; §5's integration row moved from *required after §3 Phase 2* to *wired*, and §3 Phase 2's Status moved to `complete`, once the `integration` CI job landed — see the Phase 2 note in §6.6)
- §2 risk #4 backported from Phase 3 research: 2026-09-05 (risk wording split the per-user rows from the shared caches, which hold no personal data and are reused cross-user by design under S-07; the Source cell dropped the `supabase/migrations/` churn figure — 4 commits in the trailing 30 days, not 28 — for the reverted `20260904130000_test_support_grants.sql`; the "must challenge" and "cheapest layer" cells were corrected once research showed the local stack's default privileges hide a forgotten revoke. See `context/changes/testing-phase-3-data-boundary/research.md` §5, §9)
- §6.3 written and §3 Phase 3 closed: 2026-09-06 (the phase shipped two integration layers — a nine-invariant catalog roster in `src/test/authorization-invariants.int.test.ts` and a two-account behavioural probe in `src/test/cross-account-policy.int.test.ts`, plus one cross-account replay case on `generate.db.int.test.ts`. §5's integration row dropped its "authorization is still §3 Phase 3" caveat. §6.2's claim that the internal tables grant `service_role` no direct table privileges was corrected — true locally since each table was created, true in production only from `20260906120000_revoke_service_role_internal_tables.sql`, a divergence found by a read-only cloud pass on 2026-09-06 and written up in `context/changes/testing-phase-3-data-boundary/plan.md`, "Cloud verification pass". See §6.6, Phase 3)
- Stack versions last verified: 2026-08-23 (Vitest 4.1.11 and Stryker 10.0.0 installed and running as of rollout Phase 1; the unwired rows are unchanged since 2026-08-18)
- AI-native tool references last verified: 2026-08-18

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes,
- **registration opens** — that flips risks 1 and 2 back to `High` impact (see the §2 calibration note).
