# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-08-18

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
| 4 | One account's summaries or transcripts become reachable by another — the PRD's only stated guardrail. | High | Medium | PRD *Success Criteria → Guardrails*, *Access Control*, *Non-Functional Requirements*; roadmap S-05 note (cloud default privileges grant `authenticated` CRUD on **new** tables; only the `anon` half was revoked schema-wide) while S-07 and S-09 both added user-agnostic shared tables; hot-spot dir `supabase/migrations/` — 28 commits/30d |
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
| #4 | A request authenticated as one account cannot read another's rows, and a newly added table does not inherit blanket access. | That per-user policies on the two original domain tables cover the user-agnostic shared tables added later. | Which policies exist per table and per role; what default privileges apply to newly created tables. | Integration against the local Supabase stack with two seeded accounts | Testing the service function instead of the policy — the service is not the trust boundary |
| #5 | The server refuses what the UI would never send: malformed URLs, missing or forged keys, guard-bypassing parameters. | That client-side validation implies server-side validation. | The schema at the trust boundary; which fields are optional, and what optional means on a paid path. | Unit on the schema, integration on the endpoint | Only testing inputs the form is capable of producing |
| #6 | What a card claims about charge and outcome matches what the request actually did. | That "no behaviour change by design" means no behaviour changed. | How the response maps to card state; the charged and refusal signals the UI consumes. | Component / integration, plus one e2e on the happy flow | Snapshot tests — they break on every design tweak and catch none of this |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder via `/10x-new`. Status moves left-to-right through the values below; the orchestrator updates Status as artifacts appear on disk.

| # | Phase name | Goal (one line) | Risks covered | Test types | Status | Change folder |
|---|---|---|---|---|---|---|
| 1 | Test bootstrap + cost/credit rules | Stand up the runner and pin the pure rules that decide what a generation costs and whether it is allowed | #1, #5 | unit | planned | `context/changes/testing-phase-1-bootstrap/` |
| 2 | Paid-path integration | Prove the charge-versus-delivery contract on every exit, and that derived spend reconciles against the vendor's counter | #1, #2, #3, #5 | integration | not started | — |
| 3 | Data-boundary authorization | Prove one account cannot reach another's rows, including the user-agnostic shared caches | #4 | integration | not started | — |
| 4 | Critical-flow e2e + gates wiring | Prove the flow works end to end and lock the floor in CI, including the missing typecheck gate | #6, cross-cutting | e2e, gates | not started | — |
| 5 | AI-native summary-quality golden set | Make the PRD's only success metric measurable on a schedule instead of by impression | PRD Open Question 2 | LLM-as-judge, scheduled | not started | — |

**Status vocabulary** (fixed — parser literals): `not started` → `change opened` → `researched` → `planned` → `implementing` → `complete`.

**Linear tracking** (project *10xMedia MVP*, label `test-rollout`): Phase 1 → MAR-19 · Phase 2 → MAR-20 · Phase 3 → MAR-21 · Phase 4 → MAR-22 · Phase 5 → MAR-23. Blocking chain 1 → 2 → 3 → 4, with Phase 5 blocked only by Phase 1 (it needs a runner, nothing else). Per `lessons.md`, a Status change here and the matching Linear state move in the same session.

**Phase 1's research (2026-08-22) settled its own scope, and "unit" above means two layers, not one.** Pure functions alone leave risk #1 with almost no surface — the rules that decide *who pays* (`chargeFailedTranscript`, `beginGeneration`) are pure only with respect to an injected Supabase client. Phase 1 therefore includes **hermetic stub-client tests** as well as pure ones; both are still zero-infrastructure, and §4's "API mocking — see Phase 2" still holds, because the seam here is the injected client, not the paid vendor HTTP boundary. Two other decisions are recorded in the change folder rather than here: `allowLong: true` sent unprompted is **pre-authorization by design**, not a guard bypass; and `generateSchema` moves to `src/lib/schemas/` so the trust boundary is reachable from a test at all.

**Phase 2 carries an open constraint that its research must settle.** Integration tests need clean state between runs. Per-user cleanup covers the per-account tables, but the transcript and metadata caches are user-agnostic (keyed by video id, no owner column), and the vendor budget state is a **singleton row** shared with the local development environment. Forcing the breaker into stop, stale-reading and unreadable-counter states therefore has no user to scope the cleanup to. Either that state is made injectable, or this group of tests needs its own database. `/10x-research` decides; the plan does not pre-empt it.

**Phase 5 splits the model roles deliberately.** The summaries under judgement are generated by the **production model** — judging output from a cheaper model would measure that model's quality, not the product's, and would specifically fail to detect provider-side drift, which is the reason the phase is scheduled at all. The **judge** runs on a cheap model. Cost is contained through short transcripts and a small fixed golden set, not by substituting the generator. The golden set favours short inputs but keeps one or two long ones so the set still represents the long-video path.

## 4. Stack

The classic test base for this project. AI-native tools carry a `checked:` date so future readers can see which lines need re-verification.

| Layer | Tool | Version | Notes |
|---|---|---|---|
| unit + integration | none yet — see §3 Phase 1 | — | Vitest is the fit: Astro ships `getViteConfig()` from `astro/config` for exactly this. **Astro 6 requires `environment: 'node'`** for tests that render Astro components; the client environments were disallowed in v6. |
| Astro component rendering | none yet — see §3 Phase 4 | — | Container API is still `experimental_AstroContainer`. Treat as unstable; prefer testing behaviour through the request boundary where possible. |
| API mocking | none yet — see §3 Phase 2 | — | The seam is the **paid vendor HTTP boundary only** (transcript provider, LLM gateway). Internal services are never mocked. |
| database | local Supabase stack (Docker) | CLI ^2.107.0 | Already available via `npx supabase start`. Real RLS, real credit RPCs. See the Phase 2 constraint in §3 and the cleanup exception in §7. |
| e2e | none yet — see §3 Phase 4 | — | Playwright is Astro's documented e2e path. Scope to one or two critical flows, not a page sweep. |
| accessibility | none yet | — | No rollout phase claims this. Listed as a known gap, not a plan. |
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
| typecheck | CI | required after §3 Phase 4 | type drift — `@astrojs/check` is installed but never invoked; Phase 4 wires it |
| unit | local + CI | required after §3 Phase 1 | cost and credit rule regressions |
| integration | local + CI | required after §3 Phase 2 | charge-versus-delivery regressions, breaker behaviour, authorization |
| e2e on critical flows | CI on PR | required after §3 Phase 4 | broken generate-and-see-it flow |
| summary-quality golden set | scheduled, outside CI | optional after §3 Phase 5 | prompt regressions and provider-side model drift |
| pre-prod smoke | between merge and prod | optional | environment-specific failures; already practised manually per slice |

## 6. Cookbook Patterns

How to add new tests in this project. Each sub-section is filled in once the relevant rollout phase ships; before that, the sub-section reads "TBD — see §3 Phase N."

### 6.1 Adding a unit test

- TBD — see §3 Phase 1. Will cover the cost and credit decision rules: given a transcript size and a request, what is owed and whether it is allowed.

### 6.2 Adding an integration test

- TBD — see §3 Phase 2. Will cover the charge-versus-delivery contract at the request boundary, with the paid vendor boundary faked and everything below it real.

### 6.3 Adding a test for a data-access policy

- TBD — see §3 Phase 3. Will cover the two-account ownership pattern and how a newly added table is checked for inherited access.

### 6.4 Adding an e2e test

- TBD — see §3 Phase 4.

### 6.5 Adding a case to the summary-quality golden set

- TBD — see §3 Phase 5. Will cover where golden inputs live, how the judge is calibrated, and the run cadence.

### 6.6 Per-rollout-phase notes

(Filled in as phases land — anything surprising a phase taught that the next phase should not rediscover.)

## 7. What We Deliberately Don't Test

Exclusions agreed during the rollout. Future contributors should respect these unless the underlying assumption changes.

- **Anything that spends real transcript-provider or LLM credits in CI** — hard rule; CI holds no such keys and must never need them. Re-evaluate only if a free sandbox tier appears. (Source: interview Q5.)
- **The Polish copy module as a string table** — a test would restate the strings. Re-evaluate if copy gains logic (pluralisation, interpolation branching).
- **Vendored `shadcn/ui` primitives** — upstream is the test. Re-evaluate for any component hand-modified after generation.
- **Snapshot tests on summary cards** — they break on every design tweak and catch none of the risks in §2. Re-evaluate never; use behavioural assertions instead.
- **Prompt injection through transcript content** — the guardrail does not exist yet (roadmap S-10 is `proposed`). Testing it now would mean building the safeguard first. S-10 brings its own test when it lands, following §6.
- **The Whisper job transcript path** — unreachable by construction under roadmap S-09 D1. Re-evaluate only if that decision is reversed.

**Scoped exception to the "never wipe the local database" lesson.** `lessons.md` forbids destructive operations against the local database because its data was bought with real credits. Rollout phases may delete rows **scoped to synthetic test accounts and synthetic video identifiers only**. A full reset, a truncate, or any deletion that is not key-scoped remains forbidden and still requires explicit consent. The singleton budget row is not covered by this exception — see the §3 Phase 2 constraint.

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-08-18
- Stack versions last verified: 2026-08-18
- AI-native tool references last verified: 2026-08-18

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes,
- **registration opens** — that flips risks 1 and 2 back to `High` impact (see the §2 calibration note).
