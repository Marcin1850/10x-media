# Test Rollout Phase 1: Bootstrap + Cost/Credit Rules — Implementation Plan

## Overview

Stand up Vitest as this project's first test runner, and use it to pin two classes of rule that no other layer can check:

- **Risk #5** — what the server refuses at the trust boundary, independently of what the UI would ever send.
- **Risk #1** — who pays, and whether the response tells the truth about it, on every terminating path that touches the ledger.

The oracle for every assertion comes from the PRD, the README's credit rules, and the roadmap's recorded decisions (S-01, S-09 D14, S-09 phase 9 D1, S-09 phase 3 F1) — never from reading the implementation. Where a source does not resolve a value, the row is not asserted in this phase (see "What We're NOT Doing").

## Current State Analysis

**There is no test infrastructure at all.** Zero test files, no `vitest.config`, no `test` script in `package.json`, no Vitest in `devDependencies`, and no test job in `.github/workflows/ci.yml`. Everything in this phase is greenfield except the schema extraction.

What already exists and constrains the work:

- **`tsconfig.json`** maps `@/*` → `./src/*`; every service under test imports through it (`credits.ts:2`, `summaries.ts`, and the endpoint's whole import block). **`astro.config.mjs` does not declare that alias** — Astro resolves it from `tsconfig` at build time, so Vite alone will not.
- **`eslint.config.js`** applies `tseslint.configs.strictTypeChecked` with `projectService: true` over `**/*`. Test files are type-checked-linted the moment they land, and `no-console` is `warn` globally. It also consumes `.gitignore` via `includeIgnoreFile`, so anything ignored there is also unlinted.
- **`astro.config.mjs` carries workerd-specific machinery** — the `cross-fetch` → ESM shim alias and the `@supadata/js` `optimizeDeps.exclude` — plus two `fontProviders.google()` families that are downloaded at build.
- **`generateSchema` is a module-private `const`** at `generate.ts:108-120`, inside a module whose line 3 imports `astro:env/server`. Both facts make it unreachable from a unit test today.
- **CI** runs `npm ci` → `npx astro sync` → `lint` → `lint:tokens` → `build`, with a separate `deploy` job gated on `ci`.

## Desired End State

`npm test` runs a green unit suite locally and in CI. The suite asserts the documented cost rules, the trust-boundary schema, the URL rule shared by client and server, and the credit-ledger outcome contracts — each assertion traceable to a source document rather than to the code it covers. `test-plan.md` §6.1 carries a cookbook a future contributor can follow without rediscovering the alias and stub-client details, and §3 Phase 1 reads `complete`.

Verified by: `npm test` green, `npm run lint` clean over the new files, `npm run build` unaffected, a CI run passing the new job, and a Stryker report over `credits.ts` whose survivors are each either killed or consciously ignored with a written reason.

### Key Discoveries

- **The endpoint reports the charge; it does not decide it.** Every `charged` value is read back from a ledger outcome (`generate.ts:287-307` over `credits.ts:265-323`). That inversion is what makes risk #1 unit-testable at all — the truth table lives in a service, not in HTTP handling.
- **`chargeFailedTranscript` never throws, and its `notCharged`/`ambiguous` split is the highest-signal rule in the phase** (`credits.ts:287-322`). A structured PostgREST `error` is the *only* proof no debit landed; a rejected promise, an empty `data`, or an unrecognised `outcome` all resolve to `ambiguous` because the statement may well have committed.
- **`requestId: z.uuid()` is the S-09 phase 3 F1 regression, already made once** (`generate.ts:114-119`) — an optional key let any authenticated caller opt out of the D14 charge. This is the single most valuable assertion in the phase.
- **Zod 4's `z.uuid()` accepts any RFC 9562/4122 version, v1–v8** (verified via Context7, 2026-08-22). The roadmap's "rejects a hand-typed non-v4 key" is loose phrasing. **A test asserting a valid v1 UUID is rejected would fail.**
- **`summaryCost`'s boundary is strictly `>`** (`summaries.ts:153-155`), so exactly `40 000` costs 1. `summaryCost(0) === 1` is a documented hazard (`generate.ts:732-737`), not a bug in the pricing function — the protection is the whitespace guard at `generate.ts:743`.
- **`extractYoutubeId` is one implementation shared by both sides** (`summaries.ts:161`, imported by `GenerateSummaryForm.tsx:11`). Client and server cannot drift on the URL rule; for `requestId`, `character` and `allowLong` there is no client validation at all, so the schema is the only guard.
- **Stryker's default `mutate` glob already excludes `*.test.ts`**, and `--mutate <file>` narrows scope from the CLI (Context7, 2026-08-23) — so colocated tests need no extra ignore configuration.
- **API responses are English by deliberate decision** (roadmap S-06, UI went Polish, API did not). Any copy assertion expects English.

## What We're NOT Doing

- **Not extracting `refuseAndCharge` / `refusalResponse` from the endpoint.** The phase asserts one level down at `chargeFailedTranscript`, which covers the outcome mapping but **not** the `REFUSAL_COPY` lookup nor the `ambiguousCharge: true` body shape. Phase 2's request-boundary integration tests cover both without any refactor. The gap is real and stated here rather than discovered later.
- **Not asserting `readBillableCredits`.** `supadata-billable-requests.md:163-171` prescribes `Number.parseInt`; the implementation (`supadata-ledger.ts:206`) deliberately rejects anything not `/^\d+$/`. Asserting the code's behaviour while the doc says otherwise is a mirror test. Belongs to Phase 2 once the doc is corrected.
- **Not asserting `billedSince`.** Pure and cheap, but it belongs to risk #2, which is Phase 2's scope.
- **No integration, database, RLS, component, or e2e tests.** No local Supabase stack, no HTTP boundary, no Astro Container API. Phases 2–4.
- **Not wiring the typecheck gate.** `@astrojs/check` is installed but never invoked; test-plan §5 assigns that to Phase 4.
- **Not running the unit suite in the pre-commit hook.** CI-only, matching how `lint:tokens` and `build` are already gated.
- **No coverage thresholds.** The reporter is for visibility into what Phase 2 still needs; a number is not a target here.
- **Not inventing unreachable inputs.** `summaryCost` receives `content.length`, so negative and `NaN` are unreachable from the endpoint and are not tested.
- **Not chasing a 100% mutation score.** Survivors that would not hurt a user or the business are ignored with a written reason.

## Implementation Approach

Environment first, then the two risks in ascending order of setup cost (pure before hermetic), then the gates that lock the floor, then the documentation that lets the next phase start without rediscovery.

Two test layers, both zero-infrastructure:

- **Pure** — functions with no dependencies: `summaryCost`, `extractYoutubeId`, the extracted schema. Called directly.
- **Hermetic** — functions pure with respect to an injected Supabase client: `chargeFailedTranscript`, `beginGeneration`, `lookupRefusalReplay`. A stub exposing only `rpc` is passed in. The seam is the injected client, not the paid vendor HTTP boundary — so test-plan §4's "API mocking — see Phase 2" still holds.

**Phase-by-phase execution mode.** Phases 2 and 3 are the ones where a first red test can be named in a sentence (`/10x-tdd`-eligible: *"the schema rejects a body with no `requestId`"*, *"a rejected RPC promise resolves as `ambiguous`, never `notCharged`"*). Phases 1, 4 and 5 are environment, gates and documentation — `/10x-implement`.

## Critical Implementation Details

**The `@/*` alias must be declared explicitly in the Vitest config.** `getViteConfig()` inherits `astro.config.mjs`, which does not carry it; Astro resolves `@/*` from `tsconfig.json` during its own build. Every module under test imports through the alias, so if this is missed, Phase 1's first test fails at import time with a resolution error rather than an assertion failure.

**`getViteConfig()` loads the full Astro config, including the two Google font families and the Cloudflare adapter.** If the suite turns out to need network access or a workerd-shaped environment at config load, the recorded fallback is a plain `defineConfig` from `vitest/config` with the same explicit alias — legitimate here because no Phase 1 target imports `astro:env`, a `.astro` file, or `@supadata/js`. The trigger is specific (network access, adapter failure, or config-load time dominating the run), the fallback is defined, and whichever is used gets recorded in test-plan §6.6. `getViteConfig()` becomes non-negotiable only in **rollout Phase 4** (`test-plan.md` §3 — Astro component rendering and e2e), **not** this plan's Phase 4, which is gates and mutation and touches no component.

**Vitest globals stay off; test files import `describe`/`it`/`expect`/`vi` from `vitest` explicitly.** Enabling globals would require a `types` entry in `tsconfig.json`, which is shared with the app build. Explicit imports keep the runner's footprint out of the app's type configuration.

## Phase 1: Runner Bootstrap

### Overview

Install and configure Vitest with coverage, wire the scripts, and prove the whole path — config, alias resolution, TypeScript, type-checked lint — with the first real test file rather than a scaffold.

### Changes Required:

#### 1. Dependencies

**File**: `package.json`

**Intent**: Add the test runner and its coverage reporter as devDependencies, and expose the three scripts the rest of the rollout will use.

**Contract**: `devDependencies` gains `vitest` and `@vitest/coverage-v8` at matching majors (the coverage package is version-locked to Vitest). `scripts` gains `test` (single run, the CI entry point), `test:watch`, and `test:coverage`. No existing script changes.

#### 2. Runner configuration

**File**: `vitest.config.ts` (new, repo root)

**Intent**: Configure Vitest through Astro's own integration point, with the Node environment the stack decision requires and the path alias Vite would otherwise not resolve.

**Contract**: Default-exports the result of `getViteConfig()` from `astro/config`, merged with a `test` block setting `environment: "node"` and an `include` covering `src/**/*.test.ts`. `resolve.alias` maps `@` to `./src` explicitly — see Critical Implementation Details. Coverage uses the `v8` provider with **no thresholds**, reporting text plus HTML into `coverage/`.

#### 3. Ignore entries

**File**: `.gitignore`

**Intent**: Keep generated coverage output out of the repository — and, because `eslint.config.js` feeds `.gitignore` through `includeIgnoreFile`, out of the lint surface too.

**Contract**: Adds `coverage/` under a "Test output" heading. Stryker's `reports/` and `.stryker-tmp/` are added in Phase 4 alongside its config, not here.

#### 4. First test — the cost rule

**File**: `src/lib/services/summaries.test.ts` (new)

**Intent**: Pin the credit price of delivered work, and serve as the bootstrap's proof that the runner, the alias, TypeScript and lint all work end to end.

**Contract**: Covers `summaryCost` only (`extractYoutubeId` belongs to Phase 2, which owns risk #5). Assertions and their sources:

- a transcript at or below `LONG_TRANSCRIPT_CHARS` costs **1** — README §Summary credits, roadmap S-01;
- a transcript above it costs **2** — roadmap S-01 (">40k transcript chars ⇒ 2 credits");
- **exactly `40 000` costs 1** — the rule is "long ⇒ 2", and `40 000` is not above `40 000`. This is the boundary the whole rule turns on;
- `summaryCost(0) === 1` — derived from the rule ("long ⇒ 2, else 1"; there is no zero tier), carrying a comment that this **documents the hazard at `generate.ts:732-737` and does not protect against it** — the protection is the whitespace guard.

One `it.each` over the length/cost pairs, not four near-identical cases. Imports through `@/lib/services/summaries` so the alias is exercised.

### Success Criteria:

#### Automated Verification:

- `npm test` runs and the suite is green
- `npm run lint` passes over `vitest.config.ts` and the new test file under `strictTypeChecked`
- `npm run test:coverage` produces a report without failing on a threshold
- `npm run build` still succeeds — colocated test files are not in the build graph
- The test imports resolve through `@/` (a failure here is a resolution error, not an assertion failure)

#### Manual Verification:

- The suite runs without network access and without workerd-specific machinery loading; if it does not, apply the documented `vitest/config` fallback and record which was used
- Suite runtime is fast enough to be run habitually (single-digit seconds at this size)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Risk #5 — The Trust Boundary

### Overview

Make the request schema reachable from a test, then assert what the server refuses — concentrating on the three fields the client never validates, where the schema is the only guard and a regression has already happened once.

### Changes Required:

#### 1. Extract the schema

**File**: `src/lib/schemas/generate-summary.ts` (new)

**Intent**: Move the trust-boundary schema out of the endpoint so it can be imported by a test without dragging in `astro:env/server`.

**Contract**: Exports `generateSchema` under its existing name (so the endpoint's usage site is untouched) plus the inferred request type. Field definitions move **verbatim** — same `refine` over `extractYoutubeId`, same enum, same `.optional().default(false)`, same `z.uuid()`. **The explanatory comment at `generate.ts:114-118` travels with `requestId`**: it records why the field is required and what the accepted cost is, and it is the F1 rationale this phase's headline assertion rests on. A behaviour change here would invalidate the tests written against it in the same phase.

#### 2. Import it back

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Consume the extracted schema; remove the local definition.

**Contract**: The `const generateSchema = z.object({…})` block at `:108-120` is deleted and replaced by an import from `@/lib/schemas/generate-summary`. The `z` import stays — `z.prettifyError` is still used at `:143`. Nothing else in the file changes; `extractYoutubeId` keeps its own import, since `:146` calls it directly after parsing.

#### 3. Schema tests

**File**: `src/lib/schemas/generate-summary.test.ts` (new)

**Intent**: Assert what the server refuses, on the fields the form never validates.

**Contract**: Uses `safeParse` and asserts on `success`, never on error message strings. Assertions and their sources:

- **`requestId` missing ⇒ rejected** — roadmap S-09 phase 3 **F1**. The headline assertion of the phase: `refuseAndCharge` skips the D14 fee without a key, so an optional field lets any caller opt out of the charge. A comment names F1 so a future reader knows this pins a regression that already shipped once.
- **`requestId` non-UUID string ⇒ rejected**; **a valid UUID ⇒ accepted**. **Do not assert that a non-v4 UUID is rejected** — Zod 4's `z.uuid()` accepts any RFC version, and the field's contract is stable idempotency identity, which any RFC UUID satisfies.
- **`character` outside `informational` / `educational` ⇒ rejected** — PRD **FR-004** and its Non-Goals close the set. A third value would reach `summarize()` and prompt selection after the debit.
- **`allowLong` omitted ⇒ parses to `false`** — the default direction is the safe one; omitting it means the long-video 409 gate applies.
- **`allowLong: true` on a first request ⇒ accepted** — **pre-authorization by design** (user decision, 2026-08-22), not a bypass. A comment states this explicitly, because the obvious-looking test here is a refusal assertion and it would be wrong. There is no free ride either way: the atomic debit at `generate.ts:804` is the authoritative gate.
- **`allowLong` non-boolean ⇒ rejected.**
- **A non-YouTube URL ⇒ rejected** — PRD **FR-003**; the rule is `extractYoutubeId`'s contract.

#### 4. URL rule tests

**File**: `src/lib/services/summaries.test.ts` (extend Phase 1's file)

**Intent**: Pin the URL rule that both the client and the server enforce through the same function, one `it.each` per property rather than several near-identical happy paths.

**Contract**: Covers `extractYoutubeId`. Accepted shapes: `/watch?v=`, `/shorts/`, `/embed/`, `/live/`, `youtu.be/`, each of the four allowed hosts, and `http://` equally with `https://`. Rejected, each derived from the documented rule rather than from the code shape:

- a **look-alike host** (`youtube.com.example.test`) — the check is set membership, not a suffix match;
- a **credentials-in-URL form** (`https://www.youtube.com@example.test/watch?v=…`) — `URL.hostname` resolves to the real host;
- a **bare 11-character id** with no URL around it;
- an id of the wrong length or with out-of-charset characters;
- a string `new URL()` cannot parse.

A comment records that `GenerateSummaryForm.tsx:11` imports this same function, so client and server cannot drift — worth stating so nobody "hardens" one side and creates the drift that does not exist today.

### Success Criteria:

#### Automated Verification:

- `npm test` green with the new schema and URL suites
- `npm run lint` passes over the new schema module and both test files
- `npm run build` succeeds with the endpoint importing the extracted schema
- The endpoint's behaviour is unchanged: no field's shape, default, or optionality differs from `generate.ts:108-120` before the move

#### Manual Verification:

- A generation request through the running app still succeeds end to end (the schema is on the live paid path — check for an already-running dev server on :4321 before starting one)
- A request with `requestId` omitted, sent by hand, still returns 400

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Risk #1 — The Ledger Truth Table

### Overview

The highest-signal work in the phase. Three functions decide who pays and what the caller may claim about it; each collapses to a plausible-looking wrong answer under the obvious implementation, and each protects a real user-money claim.

### Changes Required:

#### 1. Stub-client helper

**File**: `src/lib/services/__fixtures__/supabase-stub.ts` (new)

**Intent**: One place to build a Supabase client stub exposing only `rpc`, so the three test files below share a seam instead of hand-rolling three.

**Contract**: A factory returning an object with an `rpc` member built from a `vi.fn()`, configurable to (a) resolve `{ data, error: null }`, (b) resolve `{ data: null, error: { message } }`, and (c) **reject** — the third is not an edge case but the distinction the whole `ambiguous` outcome exists for, so it must be first-class in the helper rather than improvised per test. Cast to `SupabaseClient` at the boundary; the production signatures take the untyped default client, so no production type changes. This helper becomes the cookbook's hermetic pattern in Phase 5, so it is written to be read.

#### 2. `chargeFailedTranscript` — the five-way table

**File**: `src/lib/services/credits.test.ts` (new)

**Intent**: Pin the mapping from RPC result to charge outcome, and above all the boundary between "proven not charged" and "unknown".

**Contract**: Source for every row is the `ChargeFailedTranscriptResult` contract (`credits.ts:196-215`) and roadmap S-09 phase 9 **D1** — both documents about the money, not descriptions of the code. Rows:

- `outcome: "charged"` ⇒ `{ outcome: "charged", balance }`;
- `outcome: "replay"` ⇒ `replay` — a credit **was** taken, by the original attempt on this key, not by this retry;
- `outcome: "insufficient"` ⇒ `insufficient`, and a **null `new_balance` reads as `0`**, matching `beginGeneration`;
- a **structured PostgREST `error`** ⇒ `notCharged` — the one failure mode that proves no debit landed;
- a **rejected promise** ⇒ `ambiguous` — a transport failure can happen after Postgres commits;
- **`data` empty** ⇒ `ambiguous` — no `error` means the statement executed;
- an **unrecognised `outcome`** with no `error` ⇒ `ambiguous`, same reasoning.

Plus the property that ties it to risk #1: **it never throws** — every failure shape resolves. Assert this on the rejected-promise case rather than as a separate happy-path wrapper.

Two testing notes: the four failure branches each `console.error` a marker (`REFUSAL_NOT_CHARGED`, `REFUSAL_CHARGE_AMBIGUOUS`); silence the console in these cases so a green run stays readable, but **do not assert the marker strings** — they are operator log copy, not a contract any consumer reads. And assert `ambiguous` **by its own shape**, never as "not `notCharged`": the mistake this rule guards against is exactly collapsing the two.

#### 3. `beginGeneration` — narrowing and contract violations

**File**: `src/lib/services/credits.test.ts` (same file)

**Intent**: Pin the six outcomes and, more importantly, the two deliberate throws — a debit whose reservation id is lost is unrecoverable, and the throw is the guard.

**Contract**: Source is the `BeginGenerationResult` doc contract (`credits.ts:40-69`). Rows: each of `reserved`, `fresh`, `replay`, `in_progress` → `inProgress`, `unavailable`, `insufficient` maps to its documented shape; `new_balance: null` on `insufficient` and on `replay` reads as `0`; `cost: null` on `replay` reads as `1`. Throws: a `reserved` row **without** `reservation_id` or with a null `new_balance`; a `replay` row without a summary; an empty `data` array; an unrecognised `outcome`; and a structured `error`. Note the contrast with `chargeFailedTranscript` and assert it deliberately — **this function throws where that one resolves**, because here a throw protects the user from paying for work that did not happen.

#### 4. `lookupRefusalReplay` — the opposite fail direction

**File**: `src/lib/services/credits.test.ts` (same file)

**Intent**: Pin a fail direction that is the reverse of the charge path's, since assuming one convention across this module asserts the wrong direction somewhere.

**Contract**: Source is `credits.ts:325-342`'s stated contract. Each of `unavailable`, `empty`, `whitespace` returns verbatim. `null` for: a value outside those three (an operator-side settle writes a settled, summary-less row with **no** reason, and that row must keep the 409 it was written for — this is load-bearing, not a fallback), a structured `error`, and a rejected promise. Never throws.

### Success Criteria:

#### Automated Verification:

- `npm test` green with the credits suite
- `npm run lint` passes over the fixture helper and the credits test file
- Each of the three functions' failure branches is exercised, including the rejected-promise case for all three
- No test asserts `ambiguous` as the negation of `notCharged`

#### Manual Verification:

- Read the credits suite end to end and confirm each assertion traces to `credits.ts`'s doc contract or a roadmap decision, not to the switch statement it covers
- Confirm the `replay ⇒ charged: true` reasoning reads correctly to someone who has not seen the ledger — a credit was taken by the original attempt, not by this retry

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 4: Gates and Mutation Check

### Overview

Lock the floor in CI, then ask the question coverage cannot: would a test actually fail if the rule were broken?

### Changes Required:

#### 1. CI job

**File**: `.github/workflows/ci.yml`

**Intent**: Enforce the unit gate that test-plan §5 marks "required after §3 Phase 1".

**Contract**: A `npm test` step is added to the existing `ci` job, after `npm run lint:tokens` and before `npm run build`. It needs no secrets — nothing in the suite touches Supabase, Supadata or OpenRouter, which is what makes it safe under §7's hard rule that CI never holds paid keys. The `deploy` job is unchanged; it already depends on `ci`, so the gate reaches production by inheritance.

#### 2. Stryker configuration

**File**: `stryker.config.json` (new, repo root) and `package.json`

**Intent**: Make the mutation check runnable as a narrow, deliberate step — not a CI gate.

**Contract**: `devDependencies` gains `@stryker-mutator/core` and `@stryker-mutator/vitest-runner`. Config sets `testRunner: "vitest"`, `plugins: ["@stryker-mutator/vitest-runner"]`, and points the runner at `vitest.config.ts`. `mutate` is **not** broadened — Stryker's default glob already excludes `*.test.ts`, and the intended invocation narrows scope per run:

```
npx stryker run --mutate "src/lib/services/credits.ts"
```

Documented contingency (Stryker troubleshooting docs, verified 2026-08-23): if the runner reports it cannot find tests related to the mutated files, set `"vitest": { "related": false }` in the config. `.gitignore` gains `reports/` and `.stryker-tmp/`.

#### 3. Act on survivors

**File**: `src/lib/services/credits.test.ts`, `src/lib/schemas/generate-summary.test.ts`

**Intent**: Run the mutation check over `credits.ts` and the extracted schema, and resolve every survivor one way or the other.

**Contract**: For each survived mutant, the question is "would this change hurt a user or the business?" — **yes** ⇒ add the assertion that kills it; **no** (equivalent or cosmetic) ⇒ ignore it consciously and record why. The ratio of killed to ignored is not a target and no threshold is configured. A test that pins an implementation detail purely to kill a cosmetic mutant is itself a vibe test and must not be written; if a survivor can only be killed that way, it is an ignore.

### Success Criteria:

#### Automated Verification:

- A CI run on the branch passes with the new `npm test` step
- `npx stryker run --mutate "src/lib/services/credits.ts"` completes and produces an HTML report
- `npm test` still green after any assertions added in response to survivors
- `npm run lint` passes over the changed test files

#### Manual Verification:

- Open the Stryker report and review every survivor; each is either killed or has a one-line written reason for being ignored
- Confirm no assertion was added purely to raise the score — each new one names a user- or business-visible consequence

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 5: Cookbook and Status Sync

### Overview

Write down what this phase learned so Phase 2 does not rediscover it, and move every tracker that claims to reflect reality.

### Changes Required:

#### 1. Cookbook §6.1

**File**: `context/foundation/test-plan.md`

**Intent**: Replace the "TBD — see §3 Phase 1" placeholder with a pattern a contributor can follow without reading this plan.

**Contract**: §6.1 covers: where test files live (colocated `*.test.ts`), the explicit `vitest` imports and why globals are off, how to reach a hermetic function through the `__fixtures__` stub client, the oracle rule (assert from PRD / README / roadmap decisions, never from the implementation), the `it.each`-per-property convention, and how to run the mutation check narrowly. It states the two-layer split — pure vs hermetic — and that the hermetic seam is the injected client, not the vendor HTTP boundary.

#### 2. Stack, gate and status rows

**File**: `context/foundation/test-plan.md`

**Intent**: Make the frozen strategy sections reflect what now exists.

**Contract**: §4's `unit + integration` row names Vitest with its installed version and the `getViteConfig()` decision (or the recorded fallback, if it was used); a Stryker row is added, marked as a selective ad-hoc check and explicitly **not** a CI gate. §5's `unit` row moves from "required after §3 Phase 1" to required-and-wired. §3's Phase 1 Status moves to `complete`. §6.6 records what this phase taught: the `@/*` alias gap in `getViteConfig()`, whether the fallback was needed, and the Stryker `related` contingency if it was hit.

#### 3. Change and tracker sync

**File**: `context/changes/testing-phase-1-bootstrap/change.md`, Linear MAR-19

**Intent**: Close the change locally and on the board in the same session, per `lessons.md`.

**Contract**: `change.md` `status` and `updated` are stamped. MAR-19 moves to its completion state with a comment summarising what landed and the impl-review verdict. Per `lessons.md`, MAR-19 stays In Progress until this final phase closes — intermediate phases get their own comments, not a state change. No roadmap item carries this Change ID, so `roadmap.md` is untouched; the Backlog Handoff sync rule does not apply. **MAR-20 (Phase 2) and MAR-23 (Phase 5) are unblocked by this change** — note that in the closing comment.

### Success Criteria:

#### Automated Verification:

- `test-plan.md` §6.1 contains no "TBD" text
- §3 Phase 1 Status reads `complete`; §5's unit row reads as wired
- `change.md` frontmatter carries the current status and date

#### Manual Verification:

- Read §6.1 as if starting Phase 2 cold: is the stub-client pattern followable without opening this plan?
- MAR-19 shows the completion state and a comment; the issue description carries no stale `Next:` pointer
- Confirm no account identifiers from any manual verification pass reached a committed file

**Implementation Note**: This is the final phase; after it, the change is ready for `/10x-impl-review` and then `/10x-archive`.

---

## Testing Strategy

This phase *is* the testing strategy, so this section records how the suite is verified rather than restating it.

### Unit Tests (pure):

- `summaryCost` — the `> 40 000` boundary, the `40 000` case that proves it is strict, and the `0` hazard
- `extractYoutubeId` — the five accepted URL shapes across four hosts, and the four rejection properties (look-alike host, credentials-in-URL, bare id, unparseable)
- `generateSchema` — `requestId` required (F1), the closed `character` enum, `allowLong`'s safe default and its accepted pre-authorization, the URL refine

### Unit Tests (hermetic, stub client):

- `chargeFailedTranscript` — the five-way outcome table and the `notCharged`/`ambiguous` boundary
- `beginGeneration` — six outcomes, the null-coalescing defaults, and the two contract-violation throws
- `lookupRefusalReplay` — the three valid reasons and the deliberate fail-toward-`null`

### Verification of the suite itself:

1. Break `summaryCost`'s comparison to `>=` locally and confirm the boundary test goes red; revert.
2. Make `requestId` optional locally and confirm the F1 test goes red; revert.
3. Change the rejected-promise branch to return `notCharged` and confirm the ambiguity test goes red; revert.
4. Run the Stryker check over `credits.ts` and resolve each survivor (Phase 4).

Steps 1–3 are the cheap version of the same question Stryker answers, and are worth doing by hand once as each test lands.

## Performance Considerations

The suite must stay fast enough to run habitually — it is the floor every later phase builds on, and a slow bootstrap makes the Phase 2 integration suite feel intolerable by comparison. Nothing here touches a network, a database, or a file system, so the only real cost is config load. That is the practical reason the `getViteConfig()` fallback exists: if loading the full Astro config (adapter, fonts, workerd aliases) dominates the run, a plain Vite config with the alias is both faster and sufficient at this stage.

## Migration Notes

The only production code change in the whole phase is the schema extraction (Phase 2). It is a pure move — same fields, same defaults, same optionality — so there is no data migration and no rollback beyond a revert. The endpoint keeps its own `extractYoutubeId` import because `generate.ts:146` calls it directly after parsing, independently of the refine.

## References

- Research: `context/changes/testing-phase-1-bootstrap/research.md` — the oracle, the 35-exit map, and the three scope decisions
- Strategy: `context/foundation/test-plan.md` §2 (risks #1, #5), §3 (Phase 1), §4 (stack), §5 (gates), §6.1 (cookbook), §7 (exclusions)
- Change identity: `context/changes/testing-phase-1-bootstrap/change.md` — Linear MAR-19
- Rules: `context/foundation/lessons.md` — Linear/roadmap sync, derived-doc sync, no real-environment identifiers, dev-server check
- Trust boundary today: `src/pages/api/summaries/generate.ts:108-120`
- Cost rule and URL rule: `src/lib/services/summaries.ts:149-185`
- Ledger contracts: `src/lib/services/credits.ts:40-69`, `:190-215`, `:265-323`, `:343-371`
- Shared client-side URL rule: `src/components/summaries/GenerateSummaryForm.tsx:11,67-76`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Runner Bootstrap

#### Automated

- [x] 1.1 `npm test` runs and the suite is green — 8dfa356
- [x] 1.2 `npm run lint` passes over `vitest.config.ts` and the new test file under `strictTypeChecked` — 8dfa356
- [x] 1.3 `npm run test:coverage` produces a report without failing on a threshold — 8dfa356
- [x] 1.4 `npm run build` still succeeds — colocated test files are not in the build graph — 8dfa356
- [x] 1.5 The test imports resolve through `@/` — 8dfa356

#### Manual

- [x] 1.6 Suite runs without network access or workerd machinery; fallback applied and recorded if not — 8dfa356
- [x] 1.7 Suite runtime is fast enough to run habitually — 8dfa356

### Phase 2: Risk #5 — The Trust Boundary

#### Automated

- [ ] 2.1 `npm test` green with the new schema and URL suites
- [ ] 2.2 `npm run lint` passes over the new schema module and both test files
- [ ] 2.3 `npm run build` succeeds with the endpoint importing the extracted schema
- [ ] 2.4 The endpoint's behaviour is unchanged — no field's shape, default, or optionality differs

#### Manual

- [ ] 2.5 A generation request through the running app still succeeds end to end
- [ ] 2.6 A hand-sent request with `requestId` omitted still returns 400

### Phase 3: Risk #1 — The Ledger Truth Table

#### Automated

- [ ] 3.1 `npm test` green with the credits suite
- [ ] 3.2 `npm run lint` passes over the fixture helper and the credits test file
- [ ] 3.3 All three functions' failure branches exercised, including the rejected-promise case
- [ ] 3.4 No test asserts `ambiguous` as the negation of `notCharged`

#### Manual

- [ ] 3.5 Each assertion traces to a doc contract or roadmap decision, not to the code it covers
- [ ] 3.6 The `replay ⇒ charged: true` reasoning reads correctly to a fresh reader

### Phase 4: Gates and Mutation Check

#### Automated

- [ ] 4.1 A CI run on the branch passes with the new `npm test` step
- [ ] 4.2 `npx stryker run --mutate "src/lib/services/credits.ts"` completes and produces a report
- [ ] 4.3 `npm test` still green after assertions added in response to survivors
- [ ] 4.4 `npm run lint` passes over the changed test files

#### Manual

- [ ] 4.5 Every survivor is killed or has a written reason for being ignored
- [ ] 4.6 No assertion was added purely to raise the score

### Phase 5: Cookbook and Status Sync

#### Automated

- [ ] 5.1 `test-plan.md` §6.1 contains no "TBD" text
- [ ] 5.2 §3 Phase 1 Status reads `complete`; §5's unit row reads as wired
- [ ] 5.3 `change.md` frontmatter carries the current status and date

#### Manual

- [ ] 5.4 §6.1 is followable cold when starting Phase 2
- [ ] 5.5 MAR-19 shows the completion state, a comment, and no stale `Next:` pointer
- [ ] 5.6 No account identifiers from a manual pass reached a committed file
