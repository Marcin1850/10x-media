# Critical-flow e2e (test-plan Phase 4) — Plan Brief

> Full plan: `context/changes/testing-phase-4-critical-flow-e2e/plan.md`
> Research: `context/changes/testing-phase-4-critical-flow-e2e/research.md`

## What & Why

Stand up the project's e2e layer from zero to cover risk #6 — *"a UI refactor silently misreports paid work — a card that does not match what was actually charged or saved."* Three flows get a spec, each comparing what the user sees against what the request actually did. The plan opens with a **non-e2e Phase 0** fixing a balance-reporting defect the specs would otherwise bake into the oracle.

## Starting Point

Playwright is absent entirely — no config, no specs, not in `package.json`. Phase 4's *gate* half (typecheck in CI, husky hooks) shipped early on 2026-09-04; only the e2e half remains. The blocker is not Playwright: this is the **first test layer where the test and the code do not share a process**, which invalidates every faking technique `test-plan.md` §6.2 relies on. Supadata is reachable behind a cache (defeatable with data, zero code change); OpenRouter is called unconditionally at `generate.ts:822` with no seam at all — and both `astro dev` and `astro preview` run on workerd, so no Node-level interception exists either.

## Desired End State

`npm run test:e2e` runs three specs against a real local Supabase stack and a real app server, with no paid vendor call anywhere. A card that lies about a charge fails the suite. A fourth CI job blocks `deploy`, and `test-plan.md` §6.4 tells the next contributor how to add a spec.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Layer scope | E2E only — no component layer | The Cloudflare-adapter conflict is still live but gates in-process Astro rendering only, which Playwright never needs. | Research |
| LLM seam | Config-load-time alias in `astro.config.mjs`, contributed by an `enforce: "post"` Vite plugin | A Worker built without the flag *cannot contain* the fake; a runtime flag would serve canned summaries while charging real credits if ever set in production. **A plain `vite.resolve.alias` entry does not work** — Astro's own `@/*` entry is merged ahead of it and matches first (corrected during implementation). | Plan, corrected in Phase 1 |
| Server mode | `dev` locally, built `preview` in CI | The alias applies at config load, so `astro dev` gets it too — one mechanism, fast loop locally and production fidelity in CI. | Plan |
| Browsers | Chromium only | No flow carries an engine-specific risk; the `prd.md` Firefox gap is documented in the config rather than silently left. | Plan |
| Spec scope | 3 specs — sign-in demoted | Auth is injected as cookies minted server-side, never through the form; sign-in has no risk-map row and every other spec proves the cookie path by using it. | Plan |
| Auth injection | A per-test account fixture — no `setup` project, no `storageState` | The dimension the specs vary is the credit BALANCE, which the specs themselves spend, so a shared session stops being deterministic the moment a second spec or a second `--repeat-each` iteration debits it. | User, 2026-09-08 |
| Balance locator | A real accessible name, no `data-testid` | Fixes a genuine a11y defect (a screen reader reads a naked number) instead of adding the codebase's first test-only hook. | Plan |
| Oracle | The card's claim **and** the real ledger | Risk #6 is a mismatch between the two; asserting only the UI proves self-consistency, which is what a refactor keeps true while breaking the truth. | Plan |
| Phase 0 contract | `creditsRemaining` on every outcome that has a balance | One rule — report the balance whenever the server knows it — rather than a per-outcome club a future reader has to memorise. | Plan |
| Long-video depth | Drive through to a saved summary, plus a second case on quote transferability | Only confirming proves the 2-credit cost. The frozen-input replay was the planned risk surface, but it turned out **not browser-observable** — every input edit drops the quote, so live and frozen inputs are equal in every reachable state (measured: the substitution stays green). The reachable half is that the quote is withdrawn when the video changes, which is where the money risk actually lives. | Plan; amended during implementation, 2026-09-09 |
| Fixture registries | Separate ids, prefix and sweep from the integration suite | Keeps the suites from aborting each other; the loopback guard is still *imported*, never re-written. | Plan |
| Ambiguous charge | No UI, no e2e coverage | Ruled intentional; it has no browser-reachable trigger and stays an integration concern. | Research |
| Error copy language | Polish for **every** exit the card can render, resolved from a server-sent cause `code` | A translation would have collapsed three 422 causes into one sentence, which is why the client preferred the English string; the code keeps the distinction and the copy. Extended from the refusals to all coded exits the same day, and the client's mapper no longer takes the English string at all (impl review F3), so the fallback is structural. | User, 2026-09-08 |
| Header balance staleness | Fixed with a `credits:changed` DOM event | A page that contradicts itself is worse than one uniformly stale, and the seam fixes the success path too. | User, 2026-09-08 |
| E2E rules location | `test-plan.md` §6.4, written in Phase 2 rather than Phase 5 | It is the existing sibling of §6.1 (unit) and §6.2 (integration); `CLAUDE.md`'s Lesson-4 section is course scaffolding the next lesson overwrites, and a standalone file would split the cookbook in two. The short form for `CLAUDE.md`/`AGENTS.md`/`README.md` waits for Phase 5, when the layer is finished. | User, 2026-09-08 |
| Island readiness | A hydration wait (`fixtures/hydration.ts`), the one deliberate exception to no-DOM-locators | Typing into an unhydrated island poisons React's value tracker, after which no retry of the same fill ever fires `onChange`; there is no user-visible "hydrated" signal to wait on instead. | Phase 2 |

## Scope

**In scope:** Phase 0 balance fix (migration + endpoint + hook + README + unit/integration coverage) · Polish copy for every card-renderable endpoint error via a server-sent cause `code` · a client-side header-balance sync · Playwright runner and config · the LLM alias seam and fake module · an isolated e2e harness (registry, auth fixture, cache seeding, global setup) · an accessible name on the credit balance · three specs · a blocking CI job · `test-plan.md` §6.4.

**Out of scope:** Astro component rendering · a sign-in spec · e2e coverage of the `ambiguous` outcome · any UI for `ambiguousCharge` · Sentry/alerting · RLS and cross-account checks (Phase 3 owns them) · Firefox · snapshot and pixel assertions · ~~Polish copy for the non-refusal exits (400, 429, 500, 503, the "already processed" 409)~~ — **moved into scope 2026-09-08**, see the paragraph below.

**Moved INTO scope 2026-09-08 (user, after Phase 0's manual pass):** Polish copy for **every** generate-endpoint error the card can render, via a server-sent cause `code` (Phase 0 item 6); a redirect for signed-in users on the auth forms (item 6b, noticed during the same pass); and a client-side sync for the header balance (item 7). The first two reverse decisions recorded above; see `change.md` for the reasoning.

## Architecture / Approach

Playwright runs in its own process and drives a real HTTP server, so both vendor checkpoints must be defeated *inside the app*. Supadata falls to **data**: pre-seed `transcript_cache` and `metadata_cache` through the same RPCs `generate.ts` itself calls, and both lookups hit. OpenRouter falls to **code**: `astro.config.mjs` conditionally aliases `@/lib/services/llm` to a fake when `E2E_FAKE_LLM` is set. Not as a `vite.resolve.alias` key beside the existing `cross-fetch` entry, which the plan assumed and which provably does not work — Astro contributes its own `@/*` alias from a plugin `config()` hook, Vite merges plugin aliases ahead of user ones, and the first match wins. The seam is contributed by an `enforce: "post"` plugin of ours, which merges after Astro's and therefore lands first. Because `deploy`'s build never sets the variable, the fake is not bundled into the production Worker, and that is verified by grepping `dist/`, not by reading the config. Auth is injected as session cookies from `createSyntheticAccount`; every assertion is checked twice, once against the DOM and once against the ledger through `getDbOwnerConnection()`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 0. Balance on refusal | `creditsRemaining` on the 422 body (the refusal **replay** included, via a `get_refusal_replay` migration), hook applies it above the staleness guard, README narrowed — plus Polish copy via a cause `code` on every renderable exit, and a live header balance | Touches a paid-path response body; must not disturb the `ambiguous` silence |
| 1. Runner + LLM seam | `@playwright/test`, `playwright.config.ts`, the alias and the fake module | The alias must win over Astro's tsconfig-derived `@/*` — it did **not** as a plain alias entry; proof is the bundle, not the config |
| 2. Harness + seed spec | Registry, auth fixture, cache seeding, ledger reads, a11y fix, the happy-flow spec | The exemplar propagates — one bad pattern here reaches every later spec; and the island-hydration window, which fails as a broken form rather than a race |
| 3. Charged-refusal spec | The two **charged** 422s (`unavailable`, `empty`), both sides of the oracle — the cause the card names paired with the `refusal_reason` the ledger recorded. The transient 422 is **not browser-reachable** (2026-09-09) and stays an integration-layer case | Asserting the generic per-status fallback instead of the cause's own `copy.errors.codes.*` entry |
| 4. Long-video spec | 409 prompt → relabelled confirm → 2-credit debit | Asserting a Cancel control that does not exist |
| 5. CI gate + close-out | `e2e` job, `deploy` needs it, §6.4 written | `deploy` must never set `E2E_FAKE_LLM` |

**Prerequisites:** Docker + `npx supabase start`; the five local env keys; `npx playwright install --with-deps chromium`. No cloud access and no vendor credit needed.
**Estimated effort:** ~4–6 sessions across six phases; Phases 1 and 2 carry most of it, Phases 3–5 are thin.

## Open Risks & Assumptions

- **Research's Finding 5b was wrong, the plan corrected it, and Phase 0 then made it true.** The header balance did *not* update in place on any path — `Topbar.astro` is server-rendered from `Astro.locals.credits` and had no client-side sync at all. Phase 0 item 7 built one (`src/lib/credits-events.ts`), because leaving it meant a page reading `Kredyty 1` beside "Nie masz już kredytów". Header assertions no longer need a navigation, but must wait for the expected value rather than reading it once.
- ~~The alias must take precedence over Astro's own `@/*` mapping, which is derived from `tsconfig.json` by a different code path. The array form with an anchored regex is the fallback~~ — **resolved in Phase 1, and the recorded fallback was the wrong one.** The problem is merge ORDER, not alias form: Astro's `astro:tsconfig-alias` plugin contributes `@/*` through a `config()` hook, Vite's `mergeAlias` deliberately places plugin-contributed aliases ahead of user ones, and `@rollup/plugin-alias` stops at the first match — so no form of a `vite.resolve.alias` key here is ever consulted. The seam is contributed by an `enforce: "post"` plugin of our own instead, which merges after Astro's and therefore lands first. The build-output check is what settled it, exactly as planned.
- **Interacting with a page before its Astro islands hydrate is not a recoverable race** (found in Phase 2). React installs its value tracker at hydration from whatever the DOM then holds, so a pre-hydration `fill()` leaves the island convinced the input already holds that string while its own state is empty — every later identical fill is a no-op and the submit button never enables. Every spec must call `awaitIslandsHydrated(page)` after `goto` and before touching the form.
- The Playwright process itself needs the three Supabase keys, so `test:e2e` loads `.env` the way `test:integration` does; `.dev.vars` reaches only the app server.
- Separate registries mean an e2e leak is invisible to the integration suite's sweep (and vice versa) — accepted at planning as the price of the two suites not aborting each other.
- The `e2e` CI job's placeholder vendor keys do **not** trigger the "generation disabled" notice: `config-status.ts` checks presence, never validity. Safety comes from the alias and cache seeding, not from the key being fake.

## Success Criteria (Summary)

- A card that misreports a charge, a wrong quoted price, a wrong debit, or a quote that outlives the video it was priced for makes the suite go **red** — verified by deliberately breaking each one, not assumed. The one break that does **not** go red is the frozen-input substitution, and that is recorded as a gap rather than a pass (`plan.md` Phase 4 §A).
- A full run touches no paid vendor, and a plain `npm run build` produces a Worker that cannot contain the fake summarizer.
- `deploy` will not run unless the e2e suite passes, and §6.4 lets the next contributor add a spec without reading this plan.
