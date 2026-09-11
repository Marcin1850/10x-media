---
date: 2026-09-07T16:09:47+02:00
researcher: Marcin Drobiecki
git_commit: c62d044cee1a3960c061c6604ecba4f74d4bd4bb
branch: testing-phase-4-critical-flow-e2e
repository: 10xMedia
topic: "Test rollout Phase 4 — critical-flow e2e"
tags: [research, codebase, e2e, playwright, test-plan, risk-6, generate-flow, credits]
status: complete
last_updated: 2026-09-07
last_updated_by: Marcin Drobiecki
---

# Research: Test rollout Phase 4 — critical-flow e2e

**Date**: 2026-09-07T16:09:47+02:00
**Researcher**: Marcin Drobiecki
**Git Commit**: c62d044cee1a3960c061c6604ecba4f74d4bd4bb
**Branch**: testing-phase-4-critical-flow-e2e
**Repository**: 10xMedia

## Research Question

Ground rollout Phase 4 of `context/foundation/test-plan.md` — "Critical-flow e2e" — before planning. Phase 4 covers risk #6 ("a UI refactor silently misreports paid work — a card that does not match what was actually charged or saved") plus cross-cutting flow coverage. Its gate half (typecheck in CI, husky hooks) shipped early on 2026-09-04; **what remains is the e2e half only** (`test-plan.md:69`).

Scope decisions taken into this research (user, at scoping):

- **Layer scope**: deferred to research — decide whether this change is e2e only, or also opens the Astro component-rendering layer that risk #6's response guidance implies ("Component / integration, plus one e2e on the happy flow", `test-plan.md:45`).
- **Flows**: all four — generate→see summary, auth + credit balance, long-video confirmation, charged refusal exits.
- **Vendor faking**: proceed on the assumption that §6.2's cache pre-seeding works, and research the remaining LLM gap. *(The assumption was verified rather than taken on faith — see Finding 2. It holds.)*

## Summary

**Phase 4 is greenfield.** Playwright is absent entirely — not in `package.json`, not in `node_modules`, no `playwright.config.*`, no `*.spec.ts`, no `tests/` directory. `test-plan.md` §6.4 is still `- TBD — see §3 Phase 4.` Every prior phase's plan states "No e2e, no Playwright — that is Phase 4" (`testing-phase-2-paid-path/plan.md:43`, `testing-phase-3-data-boundary/plan.md:176`).

Six findings shape the plan:

1. **Recommended scope: e2e only. Do not open the component layer.** The `getViteConfig()`/Cloudflare-adapter conflict that `test-plan.md:284` handed forward to Phase 4 is **still live, verified in the installed packages** — and it is a blocker only for *in-process Astro rendering*, which Playwright never needs. Opening the component layer would mean either fighting the adapter or adopting a still-experimental API, for a layer the plan itself steers away from. See Finding 1.

2. **The vendor problem splits, and only half of it is open.** Supadata is already solvable with zero code change (cache pre-seed through the real RPCs). The LLM has **no seam at all** — `summarize()` calls `generateText` unconditionally — and both `astro dev` and `astro preview` run on **workerd**, not Node, so every process-level interception trick is physically unavailable. A seam must be built. See Finding 2.

3. **The seam choice is a production-safety decision, not a convenience one.** A runtime env flag that short-circuits the paid call is hazardous in exactly the shape of risk #1. A build-time Vite alias cannot exist in a Worker built without it. This repo has already shipped-and-reverted one test-convenience backdoor into production. See Finding 2c.

4. **The existing harness hands over more than expected.** `synthetic-account.ts`, `db-owner.ts`, `synthetic-fixtures.ts` and `integration-setup.ts`'s guards are all plain TypeScript with **zero Vitest and zero `astro:env/server` coupling** — importable from a Playwright setup as-is. Only `fetch-firewall.ts` is unusable. See Finding 3.

5. **One open product question, inside risk #6's own territory: the `ambiguousCharge` signal is dropped between endpoint and card.** The endpoint deliberately sends it; the client never reads it; the card renders nothing; the README says the UI shows it. Needs a ruling before a test encodes either behaviour as the oracle. (A second suspected finding — English refusal copy — was investigated and **dismissed**: it is intentional and documented. See Finding 5c.)

6. **`/10x-e2e` will refuse to run today.** It discovers Playwright, never scaffolds it, and hard-stops when no config and no specs exist (`SKILL.md:112-122`). Setup is this plan's job; the per-risk loop is the skill's. See Finding 8.

## Detailed Findings

### Finding 1 — Layer scope: e2e only (the deferred scope decision)

`test-plan.md:284` handed Phase 4 an explicit inheritance: *"Phase 4 (component rendering, e2e) will need `getViteConfig()` or an environment split, and will have to solve the adapter conflict rather than inherit this shortcut."*

**The conflict is unchanged in the installed tree.** Installed: `astro@6.3.1`, `@astrojs/cloudflare@13.5.0`, `@cloudflare/vite-plugin@1.36.3`. The throw is present verbatim in `node_modules/@cloudflare/vite-plugin/dist/index.mjs:48499-48513` (`validateWorkerEnvironmentOptions`), raised when `resolve.external` is truthy for any environment the plugin maps to a Worker — which is what Vitest sets for its `ssr` environment. `getViteConfig()` loads `astro.config.mjs`, which loads the adapter (`astro.config.mjs:58`), so it still hits the throw.

**The Container API is still experimental.** The export is literally named `experimental_AstroContainer` (`node_modules/astro/dist/container/index.d.ts:149`); no stable alias exists in `astro@6.3.1`. `test-plan.md:82` already steers away: *"Treat as unstable; prefer testing behaviour through the request boundary where possible."*

**The decisive point: Playwright does not care.** The adapter conflict is a *Vitest-environment* problem. Playwright runs its own process and drives a real HTTP server; it never asks Vite to build an SSR environment for the test runner. So the blocker `test-plan.md` feared would gate Phase 4 does not gate the e2e half at all — it gates only the component half.

**Recommendation: take `test-plan.md:69` literally — e2e only.** Opening the component layer buys a cheaper layer for risk #6 at the cost of either an upstream adapter fight or a dependency on an unstable API, and the request-boundary integration layer (Phase 2) already covers most of what a component test would assert. If the plan wants a cheaper-than-e2e layer for risk #6, the honest option is *more request-boundary integration coverage*, not component rendering.

### Finding 2 — The paid-vendor seam

§7 is a hard rule: no test may spend real transcript-provider or LLM credits. The integration suite honours it with Vitest-process tricks (`vi.stubGlobal("fetch")`, `vi.mock("llm.ts")`, `fetch-firewall.ts`). **None of those reach a Playwright run**, where the app is a separate server process. `/10x-e2e` independently states the same constraint: *"for an API the app calls server-side, browser-level `page.route()` won't intercept it — mock it where the server actually calls out."* (`SKILL.md:246`).

#### 2a. The endpoint's vendor checkpoints

`POST /api/summaries/generate` (`generate.ts:110` → `runGeneration` at `generate.ts:410`), in execution order:

| # | Gate | Vendor reached? |
|---|---|---|
| 1 | Config gate — missing `SUPADATA_API_KEY`/`OPENROUTER_API_KEY` → 503 (`generate.ts:111-113`) | no |
| 2 | Admin-client gate → 503 (`generate.ts:119-122`) | no |
| 3 | Idempotency replay probe (`generate.ts:433-447`) | no |
| 4 | Credit gate, balance ≤ 0 → 402 (`generate.ts:454-468`) | no |
| 5 | Transcript: quote cache → transcript cache → **real Supadata fetch** (`generate.ts:493-714`, fetch at `:629`) | **only on double miss** |
| 6 | Metadata: `getCachedMetadata` (`generate.ts:511`) → **real Supadata fetch** (`generate.ts:878`) | **only on miss** |
| 7 | Long-video gate, `cost > 1 && !allowLong` → 409 (`generate.ts:753-773`) | no |
| 8 | Atomic debit (`generate.ts:792`) | no |
| 9 | **`summarize(...)` → OpenRouter (`generate.ts:822`)** | **always, unconditionally** |

Two Supadata checkpoints, each defeatable by a cache hit. Exactly one OpenRouter checkpoint, with no cache, flag, or bypass in front of it.

#### 2b. Supadata — solved today, zero code change (assumption verified)

- `getCachedTranscript` (`transcript-cache.ts:92-141`) calls RPC `get_transcript_cache(p_youtube_id, p_max_age_seconds, p_unavailable_max_age_seconds)`, keyed on **`youtube_id` alone**. `TRANSCRIPT_REQUESTED_LANG` is stored as a diagnostic column on write and **never checked on read** — so there is no language-match condition that could defeat a seed.
- TTLs are plain time-since-`fetched_at` windows: `TRANSCRIPT_CACHE_MAX_AGE_SECONDS = 2_592_000` (30d, `ok`/`empty`), `TRANSCRIPT_CACHE_UNAVAILABLE_MAX_AGE_SECONDS = 7_200` (2h, `unavailable`).
- `getCachedMetadata` (`metadata-cache.ts:53-97`) — same shape, single 30-day window, no negative caching.
- Writes go through `save_transcript_cache` / `save_metadata_cache` (`transcript-cache.ts:186-225`, `metadata-cache.ts:113-137`) — **the same RPCs the endpoint itself calls** (`generate.ts:379-404`, `generate.ts:903`).

These are ordinary Postgres RPCs reached through the service-role client. Nothing about them is Vitest-specific. **A Playwright setup step can pre-seed both caches against the local stack over real HTTP, exactly as `generate.db.int.test.ts:60-99` already does, and the endpoint will take the cache-hit branch for both Supadata checkpoints.** The assumption carried into this research holds.

#### 2c. OpenRouter — the open problem, and the safety argument

`summarize()` (`llm.ts:136-167`) always calls `generateText`. The key arrives as a plain function argument (`llm.ts:15`), passed down from `astro:env/server` by the endpoint (`generate.ts:3,184,822`). Model pinned at `SUMMARY_MODEL_SLUG = "anthropic/claude-sonnet-5"` (`llm.ts:5`).

**Runtime constraint.** `npm run dev` is `astro dev` with `adapter: cloudflare()` — the config's own comments confirm dev runs on the **workerd** module runner (`astro.config.mjs:43-56`, where `cross-fetch` is aliased because "the workerd dev module runner can't evaluate" its CommonJS export). `npm run preview` serves through wrangler with `main: "@astrojs/cloudflare/entrypoints/server"` (`wrangler.jsonc`). **Neither is plain Node.** No `nock`, no `http` patching, no process-level interception. Only in-app seams are physically possible.

Candidate seams:

| Seam | Viable? | Cost | Production risk |
|---|---|---|---|
| **Runtime env flag inside `llm.ts`** | yes | lowest — one optional field in `astro.config.mjs`'s `env.schema` (all five secrets already `optional: true`, `:59-67`) + a branch in `summarize()` | **high — see below** |
| **Build-time Vite alias swap** | yes | low — `astro.config.mjs:39-57` already does exactly this for `cross-fetch`; the config is plain Node, so it can read `process.env` directly | **none at runtime** |
| Custom `fetch` option on `createOpenRouter` | yes | medium — real option (`node_modules/@openrouter/ai-sdk-provider/dist/index.d.ts:802-806`, documented "for e.g. testing"), but the fake must reproduce OpenRouter's usage envelope that `readUsage` reads (`llm.ts:119-134`) | moderate |
| `baseURL` → local stub server | yes | highest — real option (`index.d.ts:779-826`) but needs a second process, full wire fidelity, **and** workerd's outbound-loopback policy is unverified | moderate |
| Existing test-mode flag | **no** | — | — (grep for `MOCK|E2E|TEST_MODE|FAKE_LLM|PLAYWRIGHT` across `src/` finds only Vitest module mocks) |

**The safety argument, which should govern the choice.** A *runtime* flag is a switch that exists in the deployed Worker. If it were ever set in production — a mistyped `wrangler secret put`, a copied env block — users would receive **canned summaries and be charged real credits for them**. That is risk #1's failure scenario ("credits are spent and no summary comes back") manufactured by the test harness.

This repo has already run this exact experiment. `20260904130000_test_support_grants.sql` widened `service_role` purely for harness convenience, **shipped to production**, and was **reverted by human review, not by a test** (`d8f37f1` → `e0fdb0d`; impl-review F2). The fix was a table-owner connection (`db-owner.ts`) that reaches around the boundary instead of widening it. `test-plan.md` §6.3 records the resulting rule: *"Apply no privilege pressure of your own… If an assertion seems to need a grant, reach around the boundary instead of widening it."*

A **build-time alias** is the direct analogue of that fix: a Worker built without the flag cannot contain the fake, because the module was never bundled. The cost difference between the two seams is small; the risk difference is not. **Recommend the alias; if the plan prefers the runtime flag, it must argue against this precedent explicitly rather than by omission.**

**The fixture half is free either way.** `defaultSummarizeResult()` (`generation-harness.ts:286-300`) already returns the exact `SummarizeResult` shape (`{text, model, costUsd, promptTokens, completionTokens}`). There is no OpenRouter fixture file; `supadata-responses.ts`'s factories return in-process `Response` objects and are **not** reusable against a real server without adaptation.

#### 2d. Config gating does not save us

`config-status.ts:17-35` checks **presence/truthiness only**, never validity. Any non-empty placeholder for `SUPADATA_API_KEY`/`OPENROUTER_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY` leaves `configured === true` and the app proceeds into the real flow. So an e2e environment with placeholder keys is **not** steered into the "generation disabled" notice — it will attempt the real call. This is what makes the LLM problem real rather than moot.

### Finding 3 — Harness reuse inventory

| File | Vitest coupling | `astro:env/server` | Verdict |
|---|---|---|---|
| `src/test/synthetic-account.ts` | **none** | **none** | **Reuse as-is.** Imports only `@supabase/ssr`, `@supabase/supabase-js` types, and `./db-owner` (`:1-3`). Reads `process.env.SUPABASE_URL`/`SUPABASE_KEY` directly (`:57-58`). |
| `src/test/db-owner.ts` | none | none | **Reuse as-is.** Loopback-guarded `postgres` client (`:18`, `:32-37`). |
| `src/test/integration-setup.ts` | none (despite being Vitest's `globalSetup`) | none | **Reuse its guards as-is** — `isLoopbackHostname` (`:24-26`), `assertLoopbackSupabaseUrl` (`:34-61`). |
| `src/test/synthetic-fixtures.ts` | none | none | **Reuse as-is** — pure data (`:19-32`). |
| `src/test/fetch-firewall.ts` | **yes** (`vi.stubGlobal`, `beforeEach`/`afterEach`, `:1`) | none | **Cannot reuse.** Stubs `fetch` inside the *Vitest* process; the vendor calls happen in a different process entirely. Build-new. |
| `src/test/astro-env-server-stub.ts` | n/a | it *is* the stub | **Not applicable.** Only exists so Vitest can resolve the virtual specifier (`vitest.config.ts:37`). A real running server resolves `astro:env/server` natively. |

**Two guards the e2e layer must not defeat.** `integration-setup.ts` sweeps for stale synthetic accounts by `SYNTHETIC_ACCOUNT_EMAIL_PREFIX = "synthetic-db-int-"` (`synthetic-account.ts:26`, sweep at `integration-setup.ts:107-133`) and stale cache rows by `RESERVED_YOUTUBE_IDS` (`:73-94`). An e2e layer that seeds accounts or cache rows outside those registries produces leaks **invisible to both suites**. It must either share the registries or extend the sweep. Ideally the Playwright `globalSetup` calls this file's `setup()` rather than reimplementing the loopback check, so the two suites cannot diverge on what "safe to run against" means.

### Finding 4 — Auth and credit seeding for a browser

**Account creation is free.** `createSyntheticAccount(admin)` (`synthetic-account.ts:56`) creates the user with `email_confirm: true` (`:69-73`) — no confirmation flow — then signs in through the same `createServerClient` the app uses, against an in-memory cookie jar (`:79-92`), and joins it to a `Cookie:` header (`:102`). `dispose(youtubeIds?)` (`:107-125`) deletes `supadata_calls` by youtube id through the owner connection **first**, then the `auth.users` row (cascade), and **throws** on any failure.

**Credits.** A new account starts at **5** via trigger `on_auth_user_credits_created` → `handle_new_user_credits()` (`20260712175240_user_credits.sql:5-7`, renamed `20260714113000_rename_credits_signup_trigger.sql:29-32`). To set an *exact* balance (0 or 1, needed for the refusal and long-video cases), the established pattern is a direct service-role write, as at `generate.db.int.test.ts:314-318`:

```ts
await admin.from("user_credits").update({ balance: 1 }).eq("user_id", account.userId);
```

**The cookie shape — and a real gotcha.** `src/lib/supabase.ts:1-24` passes no `cookieOptions`, so `@supabase/ssr@0.10.3` defaults apply:

- **Name derives from the *Supabase* URL hostname**, not the app's: `` `sb-${hostname.split(".")[0]}-auth-token` `` (`@supabase/supabase-js/dist/index.cjs:369`). For local Supabase at `http://127.0.0.1:54321`, `"127.0.0.1".split(".")[0]` is `"127"` → the cookie is named **`sb-127-auth-token`**, not the intuitive `sb-<ref>-auth-token`. Hosted would be `sb-<ref>-auth-token`.
- **Chunked above 3180 chars** into `.0`, `.1`, … (`@supabase/ssr/dist/main/utils/chunker.js:8,23-28,63`). Every chunk must be added.
- **Attributes** (`constants.js:4-11`): `path: "/"`, `sameSite: "lax"`, `httpOnly: false`, `maxAge` 400 days, **no `domain`** — so the cookie is scoped to the host the browser navigates (`localhost`/`127.0.0.1`), which is a *different* host from the Supabase URL the name came from. Both facts must be right simultaneously.
- **Value is base64url-encoded JSON** (`createServerClient.js:16`, `cookies.js:9-12`).

Playwright's own idiom fits this cleanly: `base.extend({ storageState: async ({}, use) => { … } })` — override the `storageState` fixture with cookies obtained programmatically (Context7, `/microsoft/playwright`). `synthetic-account.ts` exposes only the joined header string, so a fixture must re-split on `"; "` then the first `"="` — or the plan can add a jar accessor. Either way this **skips the sign-in UI**, which the `/10x-e2e` quality rules require: *"Use storageState for authentication — never log in through UI in individual tests."*

Note the consequence for flow 2: if auth is injected, the *sign-in form itself* is no longer exercised by the other specs, so it needs its own dedicated spec if it is to be covered at all.

### Finding 5 — The four flows: routes, locators, oracles

**Routes** (`src/pages/`): `/`, `/summaries` (protected), `/account` (protected), `/auth/signin`, `/auth/signup`, `/auth/confirm-email`, `/auth/callback`. `PROTECTED_ROUTES = ["/summaries", "/account"]` (`middleware.ts:5`), redirecting to `/auth/signin` (`:38-41`).

**The route is `/summaries`, not `/dashboard`** — renamed by S-06. There is **no summary-detail route**; a saved summary expands in place inside its card (`SummaryCard.tsx:300-302`).

**There is no `data-testid` anywhere in `src/`.** Every locator must go through role/label/text today.

#### 5a. Generate → see summary (oracle: PRD US-01, `prd.md:41-45`)

Island `SummariesSurface` (`DashboardSummaries.tsx:46`) owns the whole surface.

| Element | Locator | Source |
|---|---|---|
| URL input | `getByLabel("Adres URL z YouTube")` | `pl.ts:164`, `GenerateSummaryForm.tsx:100-109` |
| Character radios | `getByRole("radio", { name: /Informacyjny\|Edukacyjny/ })` in `role="radiogroup"` `aria-label="Charakter kanału"` | `pl.ts:168-171`, `:114` |
| Long-video checkbox | `getByRole("checkbox", { name: "Zezwól na długie filmy (może kosztować 2 kredyty)" })` | `pl.ts:172`, `:166-174` |
| Submit (idle) | `getByRole("button", { name: "Generuj podsumowanie" })` | `pl.ts:173`, `:145-162` |
| Submit (loading) | `"Generowanie…"` | `pl.ts:174` |
| Submit (confirm) | `` `Generuj mimo to (${cost} kr.)` `` | `pl.ts:175` |
| Pending card | `role="status" aria-live="polite"`, `"Generowanie podsumowania…"` | `PendingSummaryCard.tsx:130-135`, `pl.ts:188` |
| Saved-awaiting-list | `"Podsumowanie zapisane — dodawanie do listy…"` | `pl.ts:189` |
| Card expand toggle | `getByRole("button", { name: /Rozwiń podsumowanie/ })` (`aria-expanded`/`aria-controls`) | `pl.ts:146-148`, `SummaryCard.tsx:271-282` |

Empty state: `"Nie masz jeszcze żadnych podsumowań."` (`pl.ts:139`).

#### 5b. Auth + credit balance

Sign-in (`SignInForm.tsx`, ground-truthed against `.playwright-cli/page-2026-09-07T12-36-03-218Z.yml:15-27`): heading `"Zaloguj się"`, `getByLabel("Email")` (placeholder `ty@przyklad.pl`), `getByLabel("Hasło")`, toggle `"Pokaż hasło"`/`"Ukryj hasło"`, submit `"Zaloguj się"` → `"Logowanie…"`.

**Balance** (`Topbar.astro:28-40`): a `<span>Kredyty</span>` label followed by a sibling numeric `<span>` **with no accessible name of its own**; when `credits === null`, a skeleton plus `sr-only` `"saldo niedostępne"`. Also on `/account` under `"Kredyty"` (`account.astro:19-32`, `pl.ts:202`).

**This is the single most important gap.** The credit delta is the oracle for half these flows (it is what the manual passes actually watched — see Historical Context), and it is reachable today only by walking from the "Kredyty" label to a sibling. **The plan should add one `data-testid` to the balance number.** That is a legitimate use of `getByTestId` under both CLAUDE.md and the skill's rules ("only when accessibility attributes are ambiguous") — and arguably the number should carry a real accessible name regardless, which would be the better fix.

**The header balance is stale after every refusal — a trap for exactly the assertion this phase wants to write.** `setCredits` is called only on the success path, from `payload.creditsRemaining` (`useGenerateSummary.ts:274`); no 422 branch updates it, charged or not. `Topbar.astro` is static Astro rendered per page load, so nothing re-renders it client-side either. Consequence: after a **charged** refusal the header still shows the pre-attempt number until a reload, even though the card correctly says a credit was taken.

**A spec that asserts the header balance after a refusal without reloading is therefore reading a stale value, and would stay green against a real charge regression.** Any balance-delta assertion on a refusal path must force a navigation/reload first (or read the balance from the server, not the header). This is a concrete instance of the "hallucinated assertion" anti-pattern the `/10x-e2e` skill names — syntactically valid, semantically empty. On the *success* path the number does update in place, so the happy-path assertion is safe as-is.

**Why it is stale is a half-finished decision, not an oversight — and that matters for how to fix it.** Roadmap D14 consequence (2) originally read: *"the charge **ships silently** — copy and 422 body unchanged, the user's explicit call"*. That consequence was **superseded 2026-09-04** by S-06 Phase 9, which added `charged`/`ambiguousCharge` to the 422 bodies so *"the charge is now shown on screen rather than shipping silently"*. The supersession delivered the **qualitative** signal (was I charged?) and never the **quantitative** one (what is my balance now?) — so the body still carries no balance field, and `refuseAndCharge`'s own doc comment still cites the pre-supersession D14 as the reason (`generate.ts:258-259`, *"never the status, the error copy, or a balance field"*).

**The value already exists and is discarded.** `chargeFailedTranscript` returns `{ outcome, balance: row.new_balance ?? 0 }` for `charged`, `replay` and `insufficient` (`credits.ts:305-310`); `refuseAndCharge` collapses it to a boolean and drops the balance (`generate.ts:293-294`). Mirroring the success path's `creditsRemaining` (`useGenerateSummary.ts:274`) would make the header self-update with no new query. For the `ambiguous` outcome there is deliberately no balance, and none should be invented — consistent with the ruling above.

**Decided 2026-09-07 (user): fix it as Phase 0 of this change** — a bug found by the research that precedes the tests it would otherwise distort. Research had recommended a separate change to keep Phase 4 scoped to e2e; the user's call is to keep it in one place, since the defect was surfaced by this phase and exists to be fixed *before* a spec normalises it. The plan must therefore open with a non-e2e phase, and the two consequences to carry into it:

- **It changes a paid-path response body**, so it is covered at the layers that already assert those bodies — unit (`credits.ts` outcome mapping) and integration (the 422 exits' shape) — not at the e2e layer. §1's cost×signal rule decides where each assertion lives, not the phase it happens to sit in.
- **Only then** may the refusal spec assert the header balance directly, with no reload workaround.

Shape of the fix: pass `chargeFailedTranscript`'s existing `balance` through `refuseAndCharge` into the 422 body as `creditsRemaining` (mirroring the success path), and have the hook `setCredits` from it. Nothing for the `ambiguous` outcome, which carries no balance by design. Include the README:261 narrowing in the same phase.

#### 5c. Charged refusal exits — and two latent product findings

Server exits (`generate.ts`): `unavailable` (`:546-547`, `:671`), `empty` (`:550`), `whitespace` (`:731-732`), replayed refusal (`:349`, always `charged: true`); the transient `failed`/`timeout` exit (`:678`) is **exempt** and hardcodes `charged: false`. `refusalResponse` (`:232-238`) omits `charged` and sends `{ error, ambiguousCharge: true }` when the ledger outcome is `"ambiguous"`.

UI rendering, all inside one `role="alert"` (`PendingSummaryCard.tsx:187-219`):

- `charged === true` → `"Za tę operację pobrano kredyt."` (`pl.ts:196`, `:204-205`)
- `charged === false` → `"Nie pobrano kredytu za tę operację."` (`pl.ts:197`, `:206-207`)
- `charged === null` → **nothing rendered** (`:204-208`)

**The refusal text is English by design — ruled 2026-09-07, not a finding.** An earlier draft of this document flagged this as a latent bug and called the Polish fallback dead code. Both claims were wrong, and the code says so explicitly:

- `messageForStatus` is documented as *"Maps a generate-endpoint HTTP status to a user-facing **English** message"* (`useGenerateSummary.ts:102-105`).
- The 422 branch states the reason the server string wins: *"Prefer the server's so a video that will NEVER be summarizable doesn't misreport as a retryable hiccup"* (`:116-120`).
- `copy.errors.noTranscript` (`pl.ts:252`) is a deliberate defensive fallback, documented as covering *"a non-JSON 422"* — reachable, not dead.
- Phase 1 recorded the same decision at roadmap S-06 level: API responses deliberately English, UI Polish.

**Consequence for the plan (unchanged):** an e2e assertion on refusal text must expect the **English server string** (e.g. `"This video has no captions, so there is nothing to summarize…"`), never the Polish `errors.*` table.

**Latent finding — the `ambiguousCharge` signal is dropped between the endpoint and the card.**

`chargeFailedTranscript` returns `outcome: "ambiguous"` in three situations (`credits.ts:296-321`), all meaning *the debit may have committed and cannot be proven either way*: the RPC promise rejected (`:317-321`, transport died possibly after Postgres committed); the RPC resolved with zero rows (`:298-301`, the statement executed without raising); an unrecognised `outcome` value (`:313-316`). The endpoint then deliberately omits `charged` and sends `{ error, ambiguousCharge: true }` (`generate.ts:232-238`) — *"asserting `false` there would be a false statement about the user's money"* — and the flag exists to tell the client this 422 is safe to retry **on the same idempotency key**.

**The client never reads it.** `useGenerateSummary.ts:332` maps only `typeof payload.charged === "boolean" ? payload.charged : null`; `ambiguousCharge` appears nowhere on the client. `PendingSummaryCard.tsx:204-208` then renders neither charge line for `null`, and its comment justifies that branch as *"a non-422 status, or a malformed body"* — **the ambiguous case is not mentioned**, suggesting it was swept into the branch rather than designed for it. `pl.ts` has no copy string for an ambiguous state (only `charged`/`notCharged`), which is further evidence it was never given a UI.

So the user is told **nothing about their credit in exactly the case where the app itself does not know**, while README:261 states the response reports `ambiguousCharge: true` *"and the UI shows it — the charge is never silent."*

**Ruled 2026-09-07 (user): the silence is intentional.** Showing nothing about the credit when the app cannot prove what happened is the desired behaviour; the `charged`-only mapping in the hook stands. **Consequence for the spec:** the refusal-path assertion for an ambiguous outcome is *presence of the error text and dismiss control, plus absence of both charge lines* — never a positive charge message. **Residual doc fix:** README:261 still claims *"the UI shows it — the charge is never silent"*, which is now known to be inaccurate for this one case; the README sentence should be narrowed to the `charged: true`/`false` cases.

**What the user actually sees.** In all three cases the failure card renders in full — thumbnail (when `youtubeId` parsed), the pasted URL, the character badge, and a `role="alert"` carrying the server's error text plus a dismiss button (`PendingSummaryCard.tsx:103-120,187-217`). Only the second line inside that alert differs: `"Za tę operację pobrano kredyt."` / `"Nie pobrano kredytu za tę operację."` / **nothing**. So the user is told the attempt failed and why; they are told nothing about their money, in the one case where the app does not know it either.

**Likelihood is not uniform across the three producers**, which matters for how much UI this deserves:

- **rejected RPC promise** (`credits.ts:317-321`) — a genuine transient (network/Supabase died, possibly after the commit). The only one expected at runtime.
- **zero rows** (`:298-301`) and **unknown `outcome`** (`:313-316`) — both mean the RPC contract and the code disagree, i.e. a deploy/migration skew rather than a runtime event.

**Observability today: logged, searchable, not alerting — ruled acceptable 2026-09-07 (user).** All three branches `console.error` with the dedicated marker `REFUSAL_CHARGE_AMBIGUOUS` (`credits.ts:243`, deliberately distinct from `REFUSAL_NOT_CHARGED`), carrying `refusalReason`, `userId`, `requestId` and the cause. **There is no Sentry** — no dependency, no code. `wrangler.jsonc` sets `"observability": { "enabled": true }`, so these reach **Cloudflare Workers Logs** (dashboard + `wrangler tail`) where the marker is greppable. Nothing *notifies*, so the case is discoverable only if someone looks, within Workers Logs' short retention — **and that is the intended state for now**; wiring an alert (Sentry, or Cloudflare log push) is deferred, not overlooked. Note §6.1 forbids asserting these marker strings in tests — *"log copy, not a contract any consumer reads."*

#### 5d. Long-video confirmation

Server: `cost > 1 && !allowLong` → **409** `{ requiresConfirmation: true, cost, transcriptLength }` (`generate.ts:753`). Client sets `confirm` state on 409 (`useGenerateSummary.ts:309-319`).

Rendered **only** in `PendingSummaryCard.tsx:167-184` (amber `status: "needs-confirmation"`) — **there is no dialog**:

- `` `Generowanie wstrzymane — to długi film. Koszt: ${cost} kr. Saldo po potwierdzeniu: ${resultingBalance} kr.` `` (`pl.ts:180-183`)
- too-low balance: `` `Za mało kredytów — potrzebujesz ${cost}, masz ${credits}.` `` (`pl.ts:185`, also under the capture bar at `GenerateSummaryForm.tsx:187-191`)
- gate button `"Przejdź do paska generowania, aby potwierdzić"` (`pl.ts:184`) — which **only focuses the URL input** (`DashboardSummaries.tsx:365-367`)

The actual confirm is the capture bar's submit, relabelled `` `Generuj mimo to (${cost} kr.)` ``, replaying the frozen `confirm.url`/`confirm.character` (`GenerateSummaryForm.tsx:82-88,151-155`). **There is no Cancel control** — editing the URL or character clears `confirm` via `inputsChanged()` (`DashboardSummaries.tsx:336-351`, `useGenerateSummary.ts:350-359`). A test asserting a "cancel button" would be asserting a control that does not exist.

### Finding 6 — Runner placement, naming, and config

**Naming matters for a concrete reason.** `vitest.config.ts:61-82` — the `unit` project includes `src/**/*.test.ts`, excluding only `*.int.test.ts`. A Playwright file at `src/e2e/generate-flow.test.ts` **would be collected and run by Vitest**, and fail. Playwright's default `*.spec.ts` matches neither project's glob. **Use `*.spec.ts`, outside `src/`** (the colocation rule in §6.1 exists because a test sits next to the module it covers; an e2e spec covers a flow, not a module). `tests/e2e/<feature>.spec.ts` is the `/10x-e2e` default (`SKILL.md:385-387`). **No change to `vitest.config.ts` is required.**

**Config shape** (Context7, `/microsoft/playwright` + `/withastro/docs`):

- `webServer: { command, url: "http://localhost:4321/", reuseExistingServer: !process.env.CI }`. `reuseExistingServer` is the codified form of `lessons.md`'s dev-server rule — worth calling out, since that lesson was learned by losing time to a stale server on :4321.
- Astro's documented command is `npm run preview`, **but** with the Cloudflare adapter `astro preview` is wrangler-backed. The plan must pick `dev` vs `preview` deliberately: `preview` is closer to production (and is where a build-time alias would have to be applied at build time), `dev` is faster to iterate.
- Auth via a **setup project** with `dependencies: ['setup']`, or the `storageState` fixture override (Finding 4).
- **`prd.md:72-73` names Chrome *and* Firefox** as supported browsers — so projects should not be Chromium-only if the config is to match the stated NFR.

### Finding 7 — CI

`.github/workflows/ci.yml`: `ci` (`:10-36`, lint → lint:tokens → typecheck → typecheck:astro → `npm test` → build, needs `secrets.SUPABASE_URL`/`SUPABASE_KEY`) and `integration` (`:45-71`), which starts a throwaway stack with

```
npx supabase start -x edge-runtime,imgproxy,logflare,mailpit,postgres-meta,realtime,storage-api,studio,supavisor,vector
```

and sets all five env keys inline (`:67-71`) — the CLI's fixed local demo JWTs plus literal placeholder vendor keys. `deploy` is `needs: [ci, integration]` (`:73-93`). No job durations are recorded anywhere.

A third `e2e` job needs: the same Supabase stack setup, a served app (Playwright `webServer` can own this), `npx playwright install --with-deps`, the chosen vendor seam configured, and `deploy`'s `needs` extended to `[ci, integration, e2e]`. It is effectively `integration`'s setup plus `ci`'s build. §5 lists the gate as **"required after §3 Phase 4"** (`test-plan.md:110`), so wiring it is in scope, not optional.

### Finding 8 — The `/10x-e2e` contract and the prerequisite backlog

The skill drives `PLAN → GENERATE → REVIEW → VERIFY` per risk (`SKILL.md:28-53, 82-136`) and **discovers** infrastructure — it explicitly does not install Playwright, scaffold config, or wire CI, and **hard-stops when no config and no specs exist** (`SKILL.md:112-122`). It also refuses when the feature under test is not built (`:161-177`) — not an issue here; S-01/S-02/S-03/S-06/S-09 are all done.

On the first phase it creates two one-time levers if missing (`SKILL.md:124-127`): `seed.spec.ts` (from `references/seed-test-pattern.md`) and an E2E rules block (from `references/e2e-quality-rules.md`). Its rules match CLAUDE.md's existing Lesson-4 section nearly verbatim — no drift to reconcile.

Its five anti-patterns: hallucinated assertion (*"would this assertion fail if the risk materialized?"*), brittle selector, shared state between tests, `waitForTimeout` instead of waiting for state, no cleanup. Its healing boundary: selector/timing drift may be healed through PR review; a changed **business behaviour** must never be healed, and `test.skip()`/`test.fixme()` is never "done".

`references/browser-driven-generation.md` prefers the **Playwright CLI** over the MCP server on token cost (~27K vs ~114K per scenario) and insists on working from the accessibility tree rather than screenshots — consistent with the `.playwright-cli/*.yml` snapshots already captured in this repo.

**Prerequisite backlog (all must be built by this plan, before `/10x-e2e` can run):**

1. `@playwright/test` installed; browser binaries.
2. `playwright.config.ts` — `webServer`, `baseURL`, projects (Chromium + Firefox per NFR), setup-project dependency.
3. `tests/e2e/` directory; `*.spec.ts` naming.
4. An auth fixture / `storageState` path built on `synthetic-account.ts`.
5. **The LLM seam** (Finding 2c) — the one genuinely novel piece.
6. A cache-seeding + cleanup helper reachable from Playwright, wired into `RESERVED_YOUTUBE_IDS`.
7. A `data-testid` (or accessible name) on the credit balance.
8. The CI job, and `deploy`'s `needs`.
9. `seed.spec.ts` + rules file — or let `/10x-e2e` create them on the first phase, which is its documented behaviour.
10. `test-plan.md` §6.4, written as the phase closes.

## Code References

- `src/pages/api/summaries/generate.ts:110,410,433-468,493-714,753-773,792,822,878` — gate order and the two vendor checkpoints
- `src/pages/api/summaries/generate.ts:67-69,232-238,349,546-550,671,678,731-732` — refusal exits and the `charged`/`ambiguousCharge` contract
- `src/lib/services/llm.ts:5,15-17,119-134,136-167` — the unconditional OpenRouter call and the usage envelope
- `src/lib/services/transcript-cache.ts:92-141,186-225` / `metadata-cache.ts:53-97,113-137` — cache lookup/seed RPCs, key shape, TTLs
- `src/lib/config-status.ts:17-35` — presence-only key checks
- `src/components/summaries/PendingSummaryCard.tsx:130-135,167-184,187-219` — pending, confirmation gate, and the charge signal
- `src/components/summaries/GenerateSummaryForm.tsx:82-88,100-109,114,145-174,187-191` — capture bar
- `src/components/summaries/SummaryCard.tsx:150-156,257-282,300-302` — card controls
- `src/components/hooks/useGenerateSummary.ts:106,116-120,262-264,309-319,332,350-359` — status mapping, 409 confirm state, ambiguous replay
- `src/lib/copy/pl.ts:132-202,243-252` — the Polish copy table
- `src/components/Topbar.astro:28-40` / `src/pages/account.astro:19-32` — balance rendering
- `src/middleware.ts:5,38-41` — `PROTECTED_ROUTES`
- `src/test/synthetic-account.ts:1-3,26,56-102,107-125` — account lifecycle, cookie jar, disposal
- `src/test/integration-setup.ts:24-26,34-61,73-94,107-133` — loopback guard and the two stale-row sweeps
- `src/test/db-owner.ts:18,32-37`, `src/test/synthetic-fixtures.ts:19-32`, `src/test/fetch-firewall.ts:1`
- `vitest.config.ts:35-38,44,61-82` — aliases and the two project globs
- `astro.config.mjs:39-57,58,59-67` — the `cross-fetch` alias precedent, the adapter, the env schema
- `.github/workflows/ci.yml:10-36,45-71,73-93`
- `supabase/migrations/20260712175240_user_credits.sql:5-7`, `20260714094500_grant_credits_rpc.sql:12-43`, `20260714113000_rename_credits_signup_trigger.sql:29-32`
- `src/pages/api/summaries/generate.db.int.test.ts:60-99,199,314-318` — the cache-seed and exact-balance patterns to port
- `node_modules/@cloudflare/vite-plugin/dist/index.mjs:48499-48513` — the adapter throw, still present
- `node_modules/astro/dist/container/index.d.ts:149` — `experimental_AstroContainer`, still experimental
- `node_modules/@openrouter/ai-sdk-provider/dist/index.d.ts:779-826` — `baseURL` and `fetch` provider options
- `node_modules/@supabase/supabase-js/dist/index.cjs:369` — the `sb-127-auth-token` name derivation

## Architecture Insights

- **The vendor boundary has two different shapes, and only one of them is a network boundary.** Supadata is reached through a *cache-fronted* path, so it can be defeated with data. OpenRouter is reached directly, so it can only be defeated with code. That asymmetry is why half this problem is free and half needs a design decision.
- **Process boundaries invalidate the entire existing faking strategy.** Everything in `test-plan.md` §6.2 assumes the test and the code share a process. Phase 4 is the first layer where they do not, and that single fact — not Playwright, not locators — is what makes it a design phase rather than a wiring phase.
- **workerd removes an escape hatch other projects rely on.** Because dev and preview are both workerd, there is no Node layer to monkeypatch. The codebase has already met this constraint once (`astro.config.mjs:43-56`, the `cross-fetch` alias), and that precedent is the most idiomatic answer available.
- **The recurring failure mode in this repo is test convenience deforming production.** It has happened once already (the reverted grants migration) and was caught by a human, not a test. The LLM seam is the same fork. `db-owner.ts` is the pattern to copy: reach *around* the boundary, don't widen it.
- **Two safety guards are registry-based, therefore silently defeatable.** The stale-account sweep keys on an email prefix and the stale-cache sweep on `RESERVED_YOUTUBE_IDS`. A new suite that seeds outside those registries leaks invisibly. Registration is not overhead — it is what makes the guard true.
- **RLS is not the e2e layer's business.** Phase 3 owns the data boundary through two purpose-built layers. The one prior browser-level cross-account check disclaims itself (`browse-summary-list/reviews/manual-verification-phase-1.md:67-75`) because it drove an endpoint that applies its own `.eq("user_id", …)`. Phase 4 should not re-add it.

## Historical Context (from prior changes)

- `context/foundation/test-plan.md:69` — Phase 4's gate half shipped early (2026-09-04); **only the e2e half remains**.
- `context/foundation/test-plan.md:284` — Phase 1 handed the `getViteConfig()` conflict forward to Phase 4. Finding 1 resolves it: still live, but not a blocker for e2e.
- `context/changes/testing-phase-2-paid-path/plan.md:43`, `testing-phase-3-data-boundary/plan.md:176` — both state "No e2e, no Playwright — that is Phase 4". Nothing browser-level has ever been attempted in the rollout.
- **impl-review F2 (Phase 2)** — `20260904130000_test_support_grants.sql` widened `service_role` for harness convenience, shipped, and was reverted by human review (`d8f37f1` → `e0fdb0d`). The governing precedent for Finding 2c.
- **impl-review F1 (Phase 2)** — a real YouTube id (`dQw4w9WgXcQ`) in a draft harness was replaced with a synthetic one because it "increased the consequence of an escaped request". Phase 4's fixtures should stay synthetic for the same reason.
- **`app-design-system/reviews/impl-review-phase-9.md` F1/F2/F3** — the origin of the `ambiguousCharge` contract. F1 was a *false statement about the user's money* (every non-`charged` outcome mapped to `charged: false`); the fix introduced the explicit `"ambiguous"` outcome, made the endpoint omit `charged`, and kept the `requestId` alive so a retry replays. F3 moved the charge line inside `role="alert"`. This is exactly what risk #6 exists to protect.
- **The manual ritual Phase 4 automates.** S-02 (`roadmap.md:133`): *"a prod smoke test — generate one short video, confirm the card and the credit delta — is what actually closes that gap."* S-03 (`roadmap.md:146`): all 8 manual rows verified 2026-09-07, *"the balance invariant was observed, not just asserted: 4 summaries deleted and the balance moved 5 → 4 against exactly one `settled` reservation."* That is the shape of the happy-path assertion.
- **A stale-doc trap already sprung once.** `roadmap.md` S-09 D14's "ships silently by design" was true before S-06 Phase 9 and false after; `test-plan.md:27` quoted it verbatim until Phase 2 corrected it. A Phase 4 plan must not cite the pre-S-06 framing.
- `src/test/synthetic-fixtures.ts:19-32` — ten synthetic ids `sdbtest0001`…`sdbtest0010`, each bound to a Phase 2/3 scenario. Phase 4 needs its own family plus registry entries, not reuse of these.
- `context/changes/generate-and-save-summary/reviews/manual-e2e-2026-07-23.md` — the original by-hand e2e pass; the closest thing to a written spec for what to automate.

## Related Research

- `context/changes/testing-phase-1-bootstrap/research.md` — runner bootstrap, the `astro:env/server` reachability constraint
- `context/changes/testing-phase-2-paid-path/research.md` — the 35-exit map of `generate.ts`, the `charged`/`ambiguousCharge` response contract
- `context/changes/testing-phase-3-data-boundary/research.md` — catalog vs behavioural layering; why service functions are not the trust boundary

## Open Questions

1. **Which LLM seam?** Build-time Vite alias (recommended, Finding 2c) vs runtime env flag. A plan choosing the flag must argue against the reverted-grants precedent explicitly.
2. **`dev` or `preview` for `webServer`?** Interacts with (1): a build-time alias must be applied at build time, which makes `preview` the natural pairing but slows the loop.
3. ~~Is the English refusal copy a bug?~~ **Closed 2026-09-07 — intentional by design** (`useGenerateSummary.ts:102-105,116-120`; roadmap S-06). E2E asserts the English server string. The Polish `errors.noTranscript` stays as the documented non-JSON fallback.
4. ~~Should the UI say something for `ambiguousCharge`?~~ **Closed 2026-09-07 — the silence is intentional.** The refusal spec asserts error text + dismiss control and the *absence* of both charge lines. Follow-up: narrow README:261's "the UI shows it — the charge is never silent" so it no longer claims the ambiguous case. Logging-without-alerting also ruled acceptable for now (no Sentry; Cloudflare Workers Logs only).
9. ~~Sequencing of the stale-header fix.~~ **Closed 2026-09-07 — it becomes Phase 0 of this change** (Finding 5b). The plan opens with a non-e2e phase: pass the already-computed balance through the charged-refusal 422 body as `creditsRemaining`, update the hook, narrow README:261. Covered by unit + integration, not e2e. Every later phase's balance assertion depends on it, so nothing e2e may start before it lands.
5. **How is a *long* video faked?** The 409 gate keys on transcript length (`generate.ts:753`, `transcriptLength`), which comes from the seeded cache row — so it is probably free, but the exact threshold and its documented source need pinning against `test-plan.md`'s oracle rule rather than read off the constant.
6. **Does the ambiguous path have a browser-reachable trigger at all?** It requires a rejected-promise ledger outcome. If it cannot be forced from outside, it stays an integration-layer concern and Phase 4 should say so rather than fake it.
7. **Which flows actually earn an e2e test?** All four were scoped in, but §1's cost×signal principle and `test-plan.md:85` ("one or two critical flows, not a page sweep") pull the other way. Recommend the plan justify each spec against a risk, and demote any that a request-boundary integration test already covers.
8. **`.playwright-cli/` is untracked and not gitignored** — it would be committed as-is. Add to `.gitignore` or remove.
