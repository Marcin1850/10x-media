# Critical-flow e2e (test-plan Phase 4) — Implementation Plan

## Overview

Stand up the project's e2e layer from zero and use it to cover risk #6 — *"a UI refactor silently misreports paid work — a card that does not match what was actually charged or saved"* — across three flows. The plan opens with a **non-e2e Phase 0**: a balance-reporting defect that the specs would otherwise normalise into the oracle.

Playwright is absent entirely today. The hard part is not Playwright: it is that this is the **first test layer where the test and the code do not share a process**, which invalidates every faking technique `test-plan.md` §6.2 relies on.

## Current State Analysis

**Nothing browser-level exists.** No `playwright.config.*`, no `*.spec.ts`, no `tests/` directory, `@playwright/test` not in `package.json`. `test-plan.md` §6.4 reads `- TBD — see §3 Phase 4.` Phase 4's *gate* half (typecheck in CI, husky pre-commit/pre-push) shipped early on 2026-09-04; **only the e2e half remains** (`test-plan.md:69`).

**The vendor boundary has two different shapes, and only one is free.**

| Checkpoint | Reached at | Defeatable by |
| --- | --- | --- |
| Supadata transcript | `generate.ts:629`, behind `get_transcript_cache` | **Data** — pre-seed the cache; zero code change |
| Supadata metadata | `generate.ts:878`, behind `getCachedMetadata` | **Data** — same |
| OpenRouter | `generate.ts:822` → `summarize()` → `generateText`, **unconditional** | **Code only** — no cache, no flag, no bypass exists |

Both `astro dev` and `astro preview` run on **workerd**, not Node (`astro.config.mjs:43-56`, `wrangler.jsonc`), so `nock`, `http` patching and every other process-level interception is physically unavailable. A seam must be built in-app.

**The harness hands over more than expected.** `synthetic-account.ts`, `db-owner.ts`, `synthetic-fixtures.ts` and `integration-setup.ts`'s guards are plain TypeScript with zero Vitest and zero `astro:env/server` coupling — importable from a Playwright process as-is. Only `fetch-firewall.ts` is unusable (it stubs `fetch` inside the Vitest process).

**Phase 0's defect.** `chargeFailedTranscript` computes a fresh balance and returns it for `charged`, `replay` and `insufficient` (`credits.ts:305-310`); `refuseAndCharge` collapses it to a boolean and **discards the number** (`generate.ts:293-294`). The 422 body therefore carries no balance, `useGenerateSummary.ts:274` only calls `setCredits` on the success path, and the client's idea of the balance is stale by exactly one credit after every charged refusal.

This is the unfinished half of S-06 Phase 9's supersession of roadmap D14 consequence (2): the **qualitative** signal (`charged`) shipped, the **quantitative** one never did. `refuseAndCharge`'s own doc comment still cites the pre-supersession D14 as the reason ("never the status, the error copy, or a balance field", `generate.ts:258-259`).

### Key Discoveries:

- **The header credit balance never updates client-side on any path — success included.** `Topbar.astro:25` reads `Astro.locals.credits`, set once per request in `middleware.ts:22-29`. It is server-rendered per page load and there is no client-side sync anywhere (a grep for `addEventListener`/`CustomEvent`/`dispatchEvent` across `src/components/` and `src/layouts/` returns nothing). **This corrects `research.md` Finding 5b**, which states the header "does update in place" on success. It does not. What the hook's `credits` actually feeds is `GenerateSummaryForm` (`DashboardSummaries.tsx:361` → `GenerateSummaryForm.tsx:65,73-75,189`) and, through it, the confirmation card's cost/resulting-balance copy. Two consequences were drawn from this — **both since superseded by Phase 0 item 7 (2026-09-08)**, which built the missing sync after the manual pass showed one page reading `Kredyty 1` beside "Nie masz już kredytów": Phase 0's user-visible effect now reaches the header as well as the form gate, and a header assertion no longer needs a navigation. The finding itself was correct about the code as found, and the correction to research Finding 5b stands — the sync did not exist, which is why it had to be written.
- **Phase 0's real failure mode is sharper than a stale label.** The hook over-states the balance after a charged refusal, so `noCredits` (`GenerateSummaryForm.tsx:74`) and `confirmTooExpensive` (`:75`) under-block: a user at a true balance of 0 sees a hook balance of 1 and is allowed to submit into a 402.
- **The alias reaches `astro dev` too.** `astro.config.mjs` is plain Node and its `vite.resolve.alias` is applied at **config-load** time, not build time — which is why the existing `cross-fetch` alias exists at all: to fix a failure in the *workerd dev module runner* (`astro.config.mjs:43-46`). So one mechanism serves both `npm run dev` locally and a built `preview` in CI, while `deploy`'s own `npm run build` (`ci.yml:83-87`, which sets only `SUPABASE_URL`/`SUPABASE_KEY`) bundles a Worker that cannot contain the fake.
- **`summarize` has exactly one production import site** — `generate.ts:17`, `import { summarize } from "@/lib/services/llm"` — so the alias has a single, unambiguous target.
- **Naming is load-bearing.** `vitest.config.ts:61-82`'s `unit` project globs `src/**/*.test.ts`. A Playwright file named `src/e2e/foo.test.ts` **would be collected and run by Vitest**, and fail. `*.spec.ts` under `tests/` matches neither project's glob. No `vitest.config.ts` change is needed.
- **`tests/` is already covered by the existing gates.** `tsconfig.json` includes `**/*` (excluding only `dist`, `coverage`) and `eslint.config.js` globs `**/*.{js,jsx,ts,tsx}` — so specs are type-checked and linted the moment they land, and `@/` resolves in them. No config change is needed for either.
- **The long-video 409 is free to trigger.** `LONG_TRANSCRIPT_CHARS = 40000` (`summaries.ts:159`), documented in README §Summary credits and independently pinned in `summaries.test.ts:13,22` — a seeded transcript row over that length yields `cost: 2` and the 409 without any vendor call.
- **The `ambiguous` outcome has no browser-reachable trigger.** It requires a rejected RPC promise, a zero-row RPC return, or an unrecognised outcome value (`credits.ts:296-321`) — a transport failure or a deploy/migration skew, neither forceable from outside the app. It stays an integration-layer concern; see "What We're NOT Doing".
- **The session cookie's name derives from the *Supabase* URL, not the app's.** `@supabase/ssr@0.10.3` defaults give `sb-${hostname.split(".")[0]}-auth-token`, so local Supabase at `127.0.0.1:54321` produces **`sb-127-auth-token`** — while the cookie's attributes carry **no `domain`**, scoping it to the host the browser navigates (`localhost`). Both facts must be right simultaneously. Values are chunked above 3180 chars into `.0`, `.1`, … — every chunk must be added.
- **A test-convenience backdoor has already deformed production here once.** `20260904130000_test_support_grants.sql` widened `service_role` for a harness, shipped in `d8f37f1`, and was reverted in `e0fdb0d` by human review — not by a test. That precedent, not convenience, governs the seam choice.

## Desired End State

`npm run test:e2e` runs three Playwright specs against a real local Supabase stack and a real app server, with no paid vendor call anywhere. Each spec asserts what the user sees **and** what the ledger actually recorded, so a card that misreports paid work fails the suite. A fourth CI job blocks `deploy`. `test-plan.md` §6.4 documents how to add the next spec.

Verify: with `npx supabase start` running, `npm run test:e2e` is green; a plain `npm run build` produces a `dist/` with no reference to the fake summarizer; `npm test` and `npm run test:integration` are unaffected.

## What We're NOT Doing

- **No Astro component-rendering layer.** The `getViteConfig()`/Cloudflare-adapter conflict `test-plan.md:284` handed forward is still live in the installed tree (`@cloudflare/vite-plugin/dist/index.mjs:48499-48513`), but it gates *in-process Astro rendering only*, which Playwright never needs. Opening that layer would mean an upstream adapter fight or a dependency on `experimental_AstroContainer`. Scope is e2e alone (`test-plan.md:69`, research Finding 1).
- **No sign-in spec.** Auth is injected as cookies minted server-side by `createSyntheticAccount`, per the `/10x-e2e` rule ("never log in through UI in individual tests"). ~~via `storageState`~~ — **narrowed 2026-09-08 (user)**: no `storageState` file and no `setup` project, see Phase 1's implementation note. Sign-in carries no risk-map row of its own, and every other spec exercises the real cookie path by using it. The gap is deliberate and gets recorded in §6.4.
- **No e2e coverage of the `ambiguous` charge outcome.** Not browser-reachable (see Key Discoveries). Already covered at the unit layer (`credits.test.ts` via `stubRejecting`) and the integration layer.
- **No UI for `ambiguousCharge`.** Ruled intentional 2026-09-07 — the silence is the desired behaviour. A spec that reaches that state asserts the *absence* of both charge lines; it never asserts a positive charge message.
- ~~**No change to the English refusal copy.**~~ **Reversed 2026-09-08 (user)** — see Phase 0 item 6. Refusal copy is Polish, resolved from a server-sent cause `code` rather than translated from the English string, so the multi-cause distinction survives. Specs assert the **Polish** string from `copy.errors.codes`. The English `error` still travels on the body for logs and untranslated consumers, so a spec may assert its presence but must not assert it as what the user reads. ~~Statuses outside the refusal set (400, 429, 500, 503) are still English by decision.~~ **Also reversed 2026-09-08 (user)** — item 6 was extended to every exit the card can render, and the impl review (F3) removed the English string from `messageForError`'s signature outright, so no status renders English.
- **No Sentry or alerting.** Logging-without-alerting via Cloudflare Workers Logs ruled acceptable for now. §6.1's rule stands: never assert the `REFUSAL_CHARGE_AMBIGUOUS` marker strings.
- **No RLS or cross-account assertions.** Phase 3 owns the data boundary through two purpose-built layers; the one prior browser-level cross-account check disclaims itself (`browse-summary-list/reviews/manual-verification-phase-1.md:67-75`).
- **No Firefox project.** `prd.md:72-73` names Chrome and Firefox; none of the three flows carries an engine-specific risk. The gap is documented in the config, not silently left.
- **No snapshot or pixel assertions** (`test-plan.md` §7).
- **No shared fixture registry with the integration suite.** Decided at planning: the e2e layer gets its own youtube-id family, its own account email prefix, and its own sweep, so neither suite can abort the other. The one thing it does *not* re-implement is the loopback guard.

## Implementation Approach

Six phases, in dependency order.

**Phase 0** closes the balance defect at the unit and integration layers, so no later spec encodes the stale value as truth. **Phase 1** cuts the LLM seam — a config-load-time alias whose safety property (a production Worker cannot contain the fake) is *proved*, not asserted. **Phase 2** builds the test-only harness and lands `seed.spec.ts`, the happy flow, which doubles as the rig's proof and as the exemplar `/10x-e2e` models every later spec on — *what you show is what you get*. **Phases 3 and 4** are thin because the skill drives them. **Phase 5** wires the gate and writes §6.4.

**The oracle for every spec is two-sided**: the card's claim *and* the real ledger read through `getDbOwnerConnection()`. Risk #6 is a mismatch between what the UI says and what the request did — asserting only the UI proves the card is self-consistent, which is exactly what a UI refactor keeps true while breaking the truth. This mirrors S-03's manual pass, where "the balance invariant was **observed**, not just asserted" (`roadmap.md:146`).

## Critical Implementation Details

**Timing & lifecycle.** ~~The header balance is server-rendered per request and never updates client-side.~~ **Superseded by Phase 0 item 7 (2026-09-08):** the header now syncs on the `credits:changed` event, so a spec may read it in place. The reason the original rule existed still matters, though, and it generalises: reading any server-rendered value *in place* after an action asserts what the app held *before* the action unless something explicitly re-rendered it — the `/10x-e2e` "hallucinated assertion" anti-pattern, syntactically valid, semantically empty, green against a real regression. Waiting for the header to reach the expected value (`toHaveText`) rather than reading it once is what makes the in-place assertion safe here.

**State sequencing (cleanup).** Cache rows first, `dispose()` second — always. `supadata_calls` is `on delete set null`, so it survives account deletion and must be deleted by `youtube_id` *before* the `auth.users` row, or the rows orphan into exactly the ledger risk #2 sums. `dispose()` throws by design (impl-review F3), so a fixture teardown must not swallow it.

**Debug & observability.** Phase 1's safety property is verified by inspecting the build output, not by reading the config: a plain `npm run build` must produce a `dist/` containing no reference to the fake module. A config that "looks right" is not the proof — the bundle is.

---

## Phase 0: Report the balance on a charged refusal

### Overview

Pass `chargeFailedTranscript`'s already-computed balance through the 422 body as `creditsRemaining`, mirroring the success path, and have the hook apply it. Non-e2e by design: this changes a paid-path response body, so §1's cost×signal rule puts it at the layers that already assert those bodies — unit and integration. **No later phase may assert a balance until this lands.**

### Changes Required:

#### 1. The refusal response contract

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Stop discarding the balance `chargeFailedTranscript` already returns. `refuseAndCharge` currently collapses the service result to a boolean at `:293-294`; it should carry the number through to `refusalResponse` so the client can resynchronise without a second query.

**Contract**: `refusalResponse` gains an optional balance parameter and emits `creditsRemaining: number` on the 422 body **whenever the ledger outcome supplies one** — `charged`, `replay` and `insufficient` (`credits.ts:305-310`). It is **omitted** for `notCharged`, for `ambiguous`, and for the `requestId === null` skip branch, none of which has a balance to report.

**Amended 2026-09-08 (impl review F1)**: the refusal REPLAY carries one too. It was omitted there on the reasoning that a replay moves no credit, so the client's number is still right — but the replay is reached by the retry of a request whose *response was lost*, which is the one client that never learned that number. `get_refusal_replay` now returns the balance beside the reason (migration `20260908120000_refusal_replay_balance.sql`), making the refusal replay symmetric with the successful one. The field means *"the user's current balance"*, not *"a charge happened"* — that distinction belongs in the doc comment, because `insufficient` sends a balance while nothing moved.

The doc comments at `:258-259` and `:225-231` both assert the body carries no balance field, citing the pre-supersession D14. Both must be rewritten to the post-S-06 framing rather than left contradicting the code — `test-plan.md`'s stale-doc trap sprang here once already (`roadmap.md` S-09 D14, quoted verbatim into `test-plan.md:27` after it had become false).

#### 2. The client's balance state

**File**: `src/components/hooks/useGenerateSummary.ts`

**Intent**: Apply the new field so the hook's `credits` stops over-stating the balance after a charged refusal. Today `setCredits` runs only inside the `response.ok` branch (`:274`).

**Contract**: Apply `payload.creditsRemaining` through the same `typeof … === "number"` narrowing the success path uses. `payload` already declares `creditsRemaining?: number` at `:249`, so no type change is needed.

~~The 402 branch is deliberately untouched — the endpoint embeds that balance in the `error` string.~~ **Superseded twice on 2026-09-08.** Item 6 gave the 402 a `creditsRemaining` field of its own, so it syncs like every other status. Then the impl review (F2) moved the application ABOVE the stale non-success guard and made it single: a balance is a fact about the user's money, not advice about the submission it answered, so editing the inputs while a charged refusal is in flight must still drop the error card and must NOT drop the number — the same reason the paid success branch already applied before the staleness check. The 402 and 422 branches no longer apply it themselves.

#### 3. Narrow the README's charge-visibility claim

**File**: `README.md` (§Summary credits, the paragraph at `:261`)

**Intent**: The sentence "The response body reports the outcome (`charged: true`/`false`, or `ambiguousCharge: true` when a retry cannot tell) and the UI shows it — the charge is never silent" is inaccurate for the ambiguous case: the client never reads `ambiguousCharge` and the card renders nothing (ruled intentional 2026-09-07).

**Contract**: Narrow the "and the UI shows it" claim to the `charged: true`/`false` cases, and state plainly that when the app cannot prove what happened it says nothing about the credit rather than guessing. Mention the balance now travelling with the refusal in the same edit.

#### 4. Unit coverage

**File**: `src/lib/services/credits.test.ts` (extend)

**Intent**: Pin that each ledger outcome carries the balance the documented contract says it does, so a future refactor cannot quietly drop it again — which is precisely what happened between S-06 Phase 9 and now.

**Contract**: One `it.each` over the outcomes, each row proving a different regression: `charged` and `replay` return `{ outcome, balance }`; `insufficient` returns a balance too; `notCharged` and `ambiguous` return no balance key at all. Assert each outcome **by its own shape, never as the negation of another** (§6.1) — `ambiguous` is not "not `notCharged`". Head the block with its oracle: README §Summary credits and roadmap S-09 D14 as superseded by S-06 Phase 9.

#### 5. Integration coverage

**File**: `src/pages/api/summaries/generate*.int.test.ts` (extend the file that already asserts the 422 bodies)

**Intent**: Prove the field reaches the wire on a charged refusal, and stays absent where it must.

**Contract**: On a charged 422, the body carries `creditsRemaining` equal to the post-charge balance — read independently, not recomputed the way the endpoint does (§6.1's oracle rule). On the transient `failed`/`timeout` exit and on an ambiguous outcome, the key is **absent**. Follow §6.2's layer split: the balance-bearing case needs a real balance, so it belongs in the real-database layer with its two-step cleanup.

### Success Criteria:

#### Automated Verification:

- `npm run typecheck` passes
- `npm run lint` passes
- `npm test` passes, including the new `credits.test.ts` rows
- `npm run test:integration` passes against a local stack, including the new 422-body assertions

#### Manual Verification:

- With a 1-credit account, submit a URL that hits a charged refusal; the form's "Za mało kredytów" gate now reflects the post-charge balance instead of the pre-attempt one, and a second submit is blocked client-side rather than bouncing off a 402
- `README.md` §Summary credits no longer claims the UI shows the ambiguous case
- `refuseAndCharge`'s doc comment no longer cites the superseded D14 "no balance field" rationale

**Implementation Note**: Pause here for manual confirmation before Phase 1.

### Added during implementation (2026-09-08, user decisions on the manual pass)

The manual pass on 0.5 surfaced two things the plan had either ruled the other way or scoped out, and
the user reversed both. Recorded here rather than in a new phase because they close the same defect
Phase 0 exists to close — *the client tells the user something the request has already made untrue* —
and because later phases assert against them.

#### 6. Polish refusal copy, via a cause code

**Files**: `src/pages/api/summaries/generate.ts`, `src/lib/copy/pl.ts`,
`src/components/hooks/useGenerateSummary.ts`

**Contract**: The endpoint sends a machine-readable `code` **beside** `error`, never instead of it, and
the client localises the code. A translation of the string was not an option: several statuses answer
with more than one cause (422 alone has three), which is precisely why the client preferred the
server's English sentence over its own one-entry-per-status Polish table. The code carries the
distinction the status cannot.

Grouping mirrors `REFUSAL_COPY`, and therefore D3 — `unavailable` → `noCaptions`; `empty` and
`whitespace` share `transcriptUnavailable` — while the transient 422 gets its **own**
`transcriptFetchFailed` despite sharing an English string with the durable one, because one is
permanent and charged and the other is our outage, free and retryable. An absent or unknown code falls
back to the per-status message, so a cause shipped ahead of its translation degrades to a generic
Polish sentence rather than an English one. **Amended 2026-09-08 (impl review F3)**: that fallback was
stated but not implemented — `messageForStatus` still preferred the English `error` on exactly the
multi-cause statuses. `messageForError` no longer TAKES the English string, so the promise is now
structural rather than a priority order a refactor can invert.

Both 402s are included: the zero-balance one by code, and the insufficient-for-cost one by **fields** —
`code`, `cost`, `creditsRemaining` — so the client rebuilds the sentence with
`copy.generate.gate.tooExpensive`, the string the confirmation card already shows. That also extends
item 1's balance rule to the 402, which previously synced nothing.

**Extended 2026-09-08 (user) to every remaining exit**: 400, 429, 500, 503 and the "already processed"
409 are coded too, so nothing the card can render is English any more. Where several `return`s say the
same thing to a user they share a code — the five generic 500s, the three save 500s, the three
configuration 503s — while the three 429s keep three, because "something else of yours is running",
"this exact one is running" and "you are asking too fast" are three different waits. The two 502s and
the 401 carry no code by design: their per-status Polish message is already the right one, and a code
would only add a second place to keep that copy correct.

`src/lib/copy/error-codes.test.ts` guards the half of this contract nothing else can see — it reads the
endpoint's source and fails if a code has no translation, the one regression that otherwise ships
silently. It earned its place immediately, catching `insufficientCredits` with no entry.

#### 6b. Signed-in users redirected away from the auth forms

**File**: `src/middleware.ts`

**Intent**: Noticed while verifying 0.5, and reported by the user as a suspected credit leak: a
signed-in user opening `/auth/signin` got the sign-in form rendered under their own topbar, balance and
account menu. It was never a leak — `Topbar.astro` renders the balance only inside its `user ?` branch
and `locals.credits` stays null without a user, both confirmed empirically against a signed-out
session — but the page invites exactly that reading and cost a round of investigation to rule out.

**Contract**: A `SIGNED_OUT_ONLY_ROUTES` list (`/auth/signin`, `/auth/signup`) redirected to
`/summaries` when `locals.user` is set — the mirror of `PROTECTED_ROUTES`, which redirected one way
only. `/auth/callback` is excluded because it *establishes* a session and redirecting it would break
the email-confirmation link; `/auth/confirm-email` is excluded because a user can plausibly reach it
with another account's stale session still in the jar.

#### 7. A client-side sync for the header balance

**Files**: `src/lib/credits-events.ts` (new), `src/components/Topbar.astro`, `src/pages/account.astro`

**Intent**: Item 1 made the form's gate truthful and left the server-rendered topbar on its
pre-request number, so one page could read `Kredyty 1` next to "Nie masz już kredytów".

**Contract**: The hook announces every balance the server reports on a `credits:changed` window event;
an inline script in `Topbar.astro` applies it to every `[data-credit-balance]` node, which is why the
account page carries the same attribute — the two render one number and must not disagree. The event
module **imports nothing**: `Topbar.astro` renders on every page, so pulling the constant from the hook
would drag React and the copy table into a site-wide bundle to move one integer. A skeleton (balance
unavailable at request time) has no such node and is deliberately left alone.

This fixes the success path too, which had the same staleness.

**Supersedes two statements above**: "Phase 0's user-visible effect is on the **form gate**, not the
header" and "any header assertion in any spec must follow a navigation, on every path" (Key
Discoveries, Critical Implementation Details). Both were true of the code as found; neither is true
now.

### Added success criteria

#### Automated

- `npm run typecheck:astro` passes (Phase 0 now touches `.astro` files)
- The refusal, transient-422 and both 402 bodies carry their documented `code`
- `messageForError` prefers the code, and falls back to the per-status message on an unknown one

#### Manual

- A charged refusal renders **Polish** copy, and no English string remains on the page
- The topbar balance updates in place, with no reload, on both the refusal and the success path

**Implementation Note**: Pause here for manual confirmation before Phase 1.

---

## Phase 1: The Playwright runner and the LLM seam

### Overview

Install the runner, write the config, and cut the one seam the codebase does not have. The seam is a production-code change on the paid path, so its safety property gets proved against the build output rather than argued from the config.

### Changes Required:

#### 1. Runner and scripts

**File**: `package.json`

**Intent**: Add `@playwright/test` as a dev dependency and a script that names the e2e project explicitly, following the existing convention where every test script names the project it means.

**Contract**: `"test:e2e": "playwright test"`. Browser binaries install via `npx playwright install --with-deps chromium` (a documented setup step, not a script). Do not let a bare `vitest` creep into any script — `test`, `test:watch` and `test:coverage` keep `--project unit`.

#### 2. Playwright config

**File**: `playwright.config.ts` (new, repo root)

**Intent**: Define the run: where specs live, which browser, how the app starts, and how auth is injected.

**Contract**:
- `testDir: "tests/e2e"`, spec glob `*.spec.ts` — **never `*.test.ts`**, which `vitest.config.ts`'s `unit` project would collect (see Key Discoveries).
- One `chromium` project, plus a `setup` project it depends on. A comment records that `prd.md:72-73` also names Firefox and why no project exists for it, so the gap is a decision on the record rather than an omission.
- `webServer`: `npm run dev` locally, a built `npm run preview` under `process.env.CI`, both with `E2E_FAKE_LLM` set; `url: "http://localhost:4321/"`; `reuseExistingServer: !process.env.CI` — which is the codified form of `lessons.md`'s dev-server rule, learned by losing time to a stale process on :4321.
- `globalSetup` pointing at the harness's setup (Phase 2).
- `forbidOnly: !!process.env.CI`, and workers pinned so parallel specs cannot collide on the singleton vendor-budget row.

#### 3. The LLM seam

**File**: `astro.config.mjs`

**Intent**: Swap `@/lib/services/llm` for a fake module when `E2E_FAKE_LLM` is set in the environment that loads the config. This is the same mechanism, in the same block, as the existing `cross-fetch` alias — a precedent, not an invention.

**Contract**: Under `vite.resolve.alias`, add a conditional entry mapping the exact specifier `@/lib/services/llm` to the fake's absolute path, gated on `process.env.E2E_FAKE_LLM`. Absent the variable the alias must not exist at all.

The one non-obvious risk: the alias has to win over Astro's own `@/*` mapping, which Astro derives from `tsconfig.json` rather than from this file, so the two are resolved by different code paths and the merge order is not guaranteed by inspection. If the object form does not take precedence, Vite's array form with an anchored `find` regex (`/^@\/lib\/services\/llm$/`) makes the match exact and unambiguous — but the existing `cross-fetch` entry has to move into the same array, since the two forms cannot be mixed. Whichever form is used, the acceptance test is the build output, not the config.

A comment must state the safety property in one line: *a Worker built without `E2E_FAKE_LLM` cannot contain the fake, because the module is never bundled* — and name `e0fdb0d` as the precedent for why a runtime flag was rejected.

#### 4. The fake summarizer

**File**: `src/test/e2e/fake-llm.ts` (new)

**Intent**: Return a deterministic `SummarizeResult` without any network call, so a spec can assert that *this specific* summary reached the card.

**Contract**: Exports `summarize` with the same signature and return shape as `src/lib/services/llm.ts` — `{ text, model, costUsd, promptTokens, completionTokens }`, the shape `defaultSummarizeResult()` (`generation-harness.ts:286-300`) already models. The text is Polish and carries a token derived from the input so the happy-path assertion can distinguish the fake's output from any other string on the page — a fixed lorem string would let a spec pass against a card rendering the wrong summary. Costs are small non-zero literals so the telemetry columns receive plausible values. It must import nothing from `@/lib/services/llm`, or the alias would make it self-referential.

Keep the identifiers greppable (`FAKE`, or similar) so Phase 1's build-output check has something unambiguous to search for.

### Success Criteria:

#### Automated Verification:

- `npx playwright --version` resolves; `npx playwright install --with-deps chromium` completes
- `npm run typecheck` and `npm run lint` pass with the new files in the tree
- `npm test` and `npm run test:integration` still pass — neither runner collects `tests/e2e/`
- **The safety proof**: plain `npm run build` (no `E2E_FAKE_LLM`), then a recursive grep of `dist/` for the fake's marker identifier returns **nothing**
- **The seam proof**: `E2E_FAKE_LLM=1 npm run build`, same grep, returns a match

#### Manual Verification:

- `E2E_FAKE_LLM=1 npm run dev` serves the app and a generation attempt against a pre-seeded video returns the fake's text without contacting OpenRouter (confirm by network inactivity or by an unchanged OpenRouter dashboard)
- Plain `npm run dev` still reaches the real provider — the seam is off by default in the developer's normal loop
- `playwright.config.ts` reads as a decision record: the Firefox gap and the `reuseExistingServer` rationale are both stated

**Implementation Note**: Pause here for manual confirmation before Phase 2. The safety proof is the gate — do not proceed on a config that looks correct but has not been checked against `dist/`.

### Added during implementation (2026-09-08)

Two things diverged from the contract above. Recorded here rather than rewritten into it, so the
reasoning stays visible — the same form Phase 0 used.

#### A. The alias could not be a `vite.resolve.alias` entry (corrected, not a decision)

The contract said to add a conditional key under `vite.resolve.alias`, with "Vite's array form with an
anchored `find` regex" as the fallback if it did not take precedence. **Both are wrong**, and the
build-output check is what caught it: with the plain entry, `E2E_FAKE_LLM=1 npm run build` still bundled
the real module. The plan's own instinct — *the acceptance test is the build output, not the config* —
is what made this a ten-minute correction instead of a Phase 2 mystery.

The cause is merge **order**, not alias **form**, so no form of the entry would have worked:

- Astro's `astro:tsconfig-alias` plugin derives `@/*` from `tsconfig.json` and contributes it through a
  `config()` hook as `{ find: /^@\/(.+)$/, replacement: "$1", customResolver }`
  (`node_modules/astro/dist/vite-plugin-config-alias/index.js`).
- Vite's `mergeAlias` places plugin-contributed aliases **ahead of** user ones deliberately — its own
  comment reads *"the order is flipped because the alias is resolved from top-down, where the later
  should have higher priority"*.
- `@rollup/plugin-alias` stops at the **first** matching entry. Astro's `@/*` matches
  `@/lib/services/llm`, so a user entry for that specifier is never consulted.
- A plugin `resolveId` hook cannot win either: Vite's alias plugin runs *before* all user plugins,
  `enforce: "pre"` included.

The seam is therefore contributed by an `enforce: "post"` plugin of our own (`e2e:fake-llm-alias`).
Astro lists its internal plugins before the user's in `create-vite.js`, so among `post` plugins ours
runs later, merges later, and lands first. `find` is the anchored RegExp the plan wanted, which is what
keeps it from shadowing anything else under `@/lib/services/`.

`cross-fetch` is unaffected and stays where it is — it never collides with `@/*`, which is why it has
worked all along and why it looked like a safe precedent.

**The proof was strengthened while fixing it.** Grepping `dist/` for the fake's marker only shows the
fake is *present*; it cannot show the real module is *gone*, and "both bundled" is a passing grep with a
broken seam. Each build is now checked in both directions: flag off → no marker **and** the real
system prompt present; flag on → marker present **and** the real system prompt absent. The first
attempt passed the marker half of 1.4 while the seam was entirely inert.

#### B. No `setup` project and no `storageState` (user decision, 2026-09-08)

The contract said "one `chromium` project, plus a `setup` project it depends on", and "What We're NOT
Doing" said auth is injected via `storageState`. That collides with Phase 2 §4, which injects auth
through a per-test `test.extend` fixture — nothing for a `setup` project to produce, and a
`dependencies: ["setup"]` with no matching `*.setup.ts` fails the runner at startup.

Raised before writing the config; the user chose the per-test fixture. The reason is that the dimension
the specs vary is the credit **balance**, and the balance is state the specs themselves spend: Phase 3
wants an account at 1 credit, Phase 4 an account at 2+, and each spec's oracle is a *delta* read for its
own `user_id`. One shared session gives one balance, mutated by whichever spec ran first, which stops
being deterministic under the `--repeat-each=2` that 2.4 / 3.3 / 4.3 require. Three further consequences
were weighed: a shared account would have to be exempted from the global setup's stale-account guard
(weakening the one thing that makes the layer safe to run), `dispose()` — which throws by design — would
have no natural call site without a `teardown` project, and a `storageState` file on disk carries a real
Supabase JWT that expires, which combined with `reuseExistingServer` fails as a silently signed-out run.

The rule that actually mattered is kept: the sign-in **form** is still never driven. `createSyntheticAccount`
signs in from the Node process and the cookies reach the browser through `context.addCookies`, so the cost
is two loopback round-trips per test (~200-400 ms, bcrypt-dominated), not a browser session.

#### C. Scope taken on beyond the contract

- **`src/test/e2e/fake-llm.test.ts`** (new). The fake cannot import `SummarizeResult` — under the alias
  that specifier resolves back to the fake itself — so it restates the shape, and a restated contract
  drifts. A bidirectional assignability pair fails `npm run typecheck` if the real `summarize` changes
  shape; verified by narrowing `costUsd` to `number` and watching the build break. The runtime cases pin
  the one property no type expresses: the summary text is a function of the input, which is what lets a
  spec tell the fake's output for *this* video from its output for any other.
- **`.gitignore`**: `test-results/`, `playwright-report/`, `blob-report/`. Phase 1 introduces the runner
  that writes them. `.playwright-cli/` stays with Phase 2 §9 as planned.

#### D. Left deliberately incomplete

`playwright.config.ts` points `globalSetup` at `./tests/e2e/fixtures/global-setup.ts`, which **Phase 2
lands**. Until then `npm run test:e2e` cannot run — there are no specs either, so nothing is lost, but the
failure would read as a missing module rather than an unfinished phase. Noted in the config itself.

---

## Phase 2: The e2e harness and the seed spec

### Overview

Everything test-only: an isolated fixture registry, an auth fixture that skips the sign-in UI, a cache-seeding helper, and one accessibility fix. Lands `seed.spec.ts` — the happy flow — which proves the whole rig works end to end and becomes the exemplar every later spec is modelled on.

### Changes Required:

#### 1. A separate fixture registry

**File**: `tests/e2e/fixtures/registry.ts` (new)

**Intent**: Give the e2e layer its own reserved youtube ids and its own account email prefix, so a leak from either suite is attributed to the suite that caused it and neither can abort the other.

**Contract**: An `E2E_RESERVED_YOUTUBE_IDS` list (synthetic ids only — never a real YouTube id, per impl-review F1 and `lessons.md`) with one entry per scenario, each commented with the spec that owns it and its shape (short transcript, long transcript, no transcript). An `E2E_ACCOUNT_EMAIL_PREFIX` distinct from `synthetic-db-int-`. A comment must state the consequence the user accepted at planning: these registries are deliberately disjoint from `src/test/synthetic-fixtures.ts`, so `integration-setup.ts`'s sweep will never see an e2e leak, and vice versa.

#### 2. A configurable account prefix

**File**: `src/test/synthetic-account.ts`

**Intent**: `createSyntheticAccount` hardcodes `SYNTHETIC_ACCOUNT_EMAIL_PREFIX` at `:66`. The e2e layer needs its own prefix while reusing everything else in the file — the `email_confirm: true` creation, the real cookie-jar sign-in, and the ordered `dispose`.

**Contract**: An optional prefix parameter defaulting to the current constant, so every existing call site is unaffected. Additionally expose the cookie **jar entries** alongside the joined `cookieHeader` — Playwright's `storageState` needs `{name, value}` pairs, and re-splitting the joined string in the fixture would duplicate a format decision that lives here. The existing `cookieHeader` stays; nothing about the integration suite changes.

#### 3. The Playwright global setup

**File**: `tests/e2e/fixtures/global-setup.ts` (new)

**Intent**: Refuse to run against anything but a loopback Supabase, and abort on state left by a hard-killed prior run — the same two guarantees `integration-setup.ts` gives its suite, over the e2e registry.

**Contract**: **Import `assertLoopbackSupabaseUrl` from `src/test/integration-setup.ts`** (it is exported at `:34` and Vitest-free) rather than re-implementing it. The loopback guard is the reason this layer is safe to run at all, and a second hand-written copy is the one piece that must never diverge — the registries are deliberately separate, the guard deliberately is not. Then sweep for stale rows keyed on `E2E_RESERVED_YOUTUBE_IDS` and stale accounts keyed on `E2E_ACCOUNT_EMAIL_PREFIX`, aborting with named repair instructions rather than silently reusing state.

#### 4. The auth fixture

**File**: `tests/e2e/fixtures/account.ts` (new)

**Intent**: Give each spec its own signed-in account without ever driving the sign-in form, and dispose it afterwards.

**Contract**: A `test.extend` fixture that creates a synthetic account (5 credits by trigger), sets an exact balance where a spec needs one — a direct service-role `user_credits` update, the pattern at `generate.db.int.test.ts:314-318` — and hands the browser context the session cookies.

Two cookie facts must both be right or the session silently does not exist: the name is derived from the **Supabase** hostname (`sb-127-auth-token` for `127.0.0.1:54321`), while the cookie carries **no `domain`** and so must be scoped to the host the browser navigates (`localhost:4321`). Values above 3180 chars arrive chunked as `.0`, `.1`, … and every chunk must be added. Attributes: `path: "/"`, `sameSite: "Lax"`, `httpOnly: false`.

Teardown disposes the account. `dispose()` throws by design, so the fixture must let it — a swallowed failure leaks an `auth.users` row that only the next run notices.

#### 5. The cache-seeding helper

**File**: `tests/e2e/fixtures/seed-cache.ts` (new)

**Intent**: Make both Supadata checkpoints cache hits, so no transcript or metadata fetch is ever attempted.

**Contract**: Seed through `save_transcript_cache` / `save_metadata_cache` — **the same RPCs `generate.ts` itself calls** (`generate.ts:379-404,903`) — so the endpoint exercises its real cache-hit branch rather than a stand-in. Both must be seeded; either miss reaches a vendor. Transcript content length is the knob the long-video case turns (Phase 4). Cleanup deletes the seeded rows by `youtube_id` through `getDbOwnerConnection()` **before** `dispose()`, per §6.2's two-step recipe.

#### 6. An accessible name on the credit balance

**File**: `src/components/Topbar.astro` (and `src/lib/copy/pl.ts` for the string)

**Intent**: The balance is a bare `<span>` following a `Kredyty` label (`:36-39`) with no accessible name of its own — a screen reader reads a naked number, and a spec can reach it only by walking from a sibling. Fix the accessibility defect and the locator problem with one change.

**Contract**: The number carries a real accessible name tying it to its label — `aria-labelledby` against the existing `Kredyty` span, or an `aria-label` built from `copy.nav.credits`. The Polish string goes through `pl.ts`, never inline. No `data-testid` is added; the codebase has none today and this element no longer needs one. `src/pages/account.astro:19-32` renders the same balance and should be checked for the same gap.

#### 7. The seed spec — generate → see summary

**File**: `tests/e2e/generate-summary.spec.ts` (new; the `seed.spec.ts` role)

**Intent**: Prove the rig works, and stand as the exemplar `/10x-e2e` models Phases 3 and 4 on. *What you show is what you get*: if this file uses `getByRole` and waits on state, so will every generated test; one `waitForTimeout` here propagates to all of them.

**Contract**: Signed in via the fixture, on `/summaries` with a short transcript seeded. Fill `getByLabel("Adres URL z YouTube")`, pick a character radio in the `Charakter kanału` radiogroup, submit `Generuj podsumowanie`. Wait for the pending card's `role="status"`, then for the saved card. Assert **both sides of the oracle**: the card shows the fake summarizer's distinctive text, *and* the ledger recorded exactly one settled reservation with the balance moved by exactly 1 — read through `getDbOwnerConnection()`, which is what makes this a claim about the request rather than about the card's self-consistency. Any header-balance assertion waits for the expected value rather than reading it once (see Critical Implementation Details).

Any header-balance assertion waits for the value rather than reading it once (Phase 0 item 7 replaced the reload workaround).

Cleanup: cache rows, then `dispose([youtubeId])`.

#### 8. The E2E rules block

**File**: `CLAUDE.md` §"10xDevs AI Toolkit — Module 3, Lesson 4" (extend) or a dedicated file under `tests/e2e/`

**Intent**: `/10x-e2e` creates this on its first phase if absent; creating it here instead means Phase 3 starts with the rules already tuned to this app's real routes, locators and seam.

**Contract**: The rules from `references/e2e-quality-rules.md`, plus the three project-specific facts a generated spec cannot infer: the header balance updates on the `credits:changed` event, so assert it by waiting for the expected value rather than reading it once (Phase 0 item 7); refusal text is the **Polish** `copy.errors.codes.*` entry for the cause, never the English `error` still carried on the body (Phase 0 item 6); the two-sided oracle is mandatory. CLAUDE.md's existing Lesson-4 section already matches the skill's rules nearly verbatim, so this is an extension, not a reconciliation.

#### 9. Ignore the Playwright CLI scratch directory

**File**: `.gitignore`

**Intent**: `.playwright-cli/` is untracked and unignored today, so its snapshot dumps would be committed on the next `git add`.

**Contract**: Add `.playwright-cli/`. Note that `.gitignore` feeds ESLint through `includeIgnoreFile` (`eslint.config.js:87`), so anything ignored is also unlinted — correct for scratch output, and the reason `coverage/` had to be listed there too.

### Success Criteria:

#### Automated Verification:

- `npm run typecheck`, `npm run typecheck:astro` and `npm run lint` pass
- `npm test` and `npm run test:integration` still pass — the `synthetic-account.ts` change is backward-compatible
- `npm run test:e2e` runs `generate-summary.spec.ts` green against a local stack
- The spec passes twice in a row and in `--repeat-each=2`, proving cleanup and isolation
- Re-running after a deliberately killed run aborts with the stale-row message rather than proceeding

#### Manual Verification:

- **The deliberate-break check** (the `/10x-e2e` gate against a hallucinated assertion): make the endpoint report a wrong `creditsRemaining`, or the card render a different summary, and confirm the spec goes **red**. A spec that stays green here protects nothing
- No transcript, metadata or LLM vendor call is made during a run — confirmed against the vendor dashboards or by the absence of new `supadata_calls` rows beyond the seeded ids
- The credit balance is announced with its label by a screen reader (or by the browser's accessibility inspector) on `/summaries` and `/account`
- After a run, `auth.users`, `transcript_cache` and `metadata_cache` hold no rows matching the e2e registry

**Implementation Note**: Pause here for manual confirmation before Phase 3. The deliberate-break check is the gate.

### Added during implementation (2026-09-08)

Recorded rather than rewritten into the contract above, the form Phases 0 and 1 used.

#### A. The rules block went to `test-plan.md` §6.4 — user ruling, 2026-09-08

The contract offered `CLAUDE.md` or a dedicated file under `tests/e2e/`. Both were written and both
were wrong, and the user rejected them for the right reason: **§6.4 already exists for exactly this**,
as the sibling of §6.1 (unit) and §6.2 (integration), and it is where a contributor already looks. The
two rejected homes each fail differently — `CLAUDE.md`'s Lesson-4 section is course scaffolding that
the next lesson overwrites (and the file is gitignored, so it reaches neither CI nor another
checkout), while a standalone `tests/e2e/RULES.md` splits the cookbook across two documents that would
drift.

Both were removed and `test-plan.md` §6.4 now carries the full cookbook, replacing its
`- TBD — see §3 Phase 4.` placeholder.

**Consequence for Phase 5**, whose item 2 owned §6.4: the bulk of it is written. What is left there is
genuinely Phase 5's — the CI job, whatever Phases 3 and 4 add, the §6.6 Phase 4 notes, the §3 status
flip, the §5 gate row and the §8 freshness-ledger line.

**Deferred to Phase 5 by the same ruling**: the short-form e2e paragraph in
`CLAUDE.md` / `AGENTS.md` / `README.md`, alongside the existing unit and integration ones. It should
describe the finished layer — three specs and a blocking CI job — so writing it now would describe a
one-spec suite with no gate and be rewritten sentence by sentence in Phase 5.

#### B. `npm run test:e2e` had to load `.env`

Phase 1 shipped `"test:e2e": "playwright test"`. That is enough to run a browser and not enough to run
this harness: `global-setup.ts` and the account fixture execute in the **Playwright Node process**,
where `SUPABASE_URL`, `SUPABASE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` must be set — `.dev.vars` reaches
only the app server. The script is now
`node --env-file-if-exists=.env node_modules/@playwright/test/cli.js test`, the shape `test:integration`
already uses for exactly this reason.

#### C. The hydration wait — and why no retry could replace it

Not anticipated, and it cost the most time. These pages are server-rendered HTML with `client:load`
React islands, so after `goto` the capture bar is on screen, looks interactive, and is not wired.
Typing in that window does not merely get ignored: React installs its **value tracker** at hydration
from whatever the DOM then holds, so the island comes up believing the input already contains the
typed URL while its own state is empty. Every later `fill()` of that same string is then a no-op —
React raises `onChange` only when the *tracked* value changes — the submit button never enables, and
the failure reads like a broken form. A retry loop around the fill was tried first and failed for
precisely this reason; it is the shape of bug that would otherwise have been "fixed" with a sleep.

`tests/e2e/fixtures/hydration.ts` waits for Astro's own hydration contract (`<astro-island ssr>`
disappearing) and is **the one deliberate exception** to the no-DOM-locators rule, confined to that
helper so no spec ever writes a selector: there is no user-visible signal for "hydrated", which is
exactly what makes the window dangerous.

#### D. Scope taken on beyond the four planned files

- **`fixtures/admin.ts`** — one service-role client, its type inferred rather than annotated
  `SupabaseClient` (the wider generic default is what produced an `no-unsafe-return`), so account,
  seeding and global-setup all agree on one shape.
- **`fixtures/ledger.ts`** — the oracle's second side: `readBalance`, `readReservations`,
  `readSummaries`, `readSupadataCalls`, all through the table-owner connection.
- **`fixtures/test.ts`** — the composed spec entry point. `seedVideo` depends on `account`, so
  Playwright's teardown graph *enforces* "cache rows first, `dispose()` second" rather than leaving it
  to a comment.
- **`transcriptFingerprint`** is now exported from `src/test/e2e/fake-llm.ts`, so a spec names the one
  token distinguishing this video's summary from any other by calling the same function the response
  came from, instead of restating the hash.
- **`eslint.config.js`** — `react-hooks/rules-of-hooks` off for `tests/e2e/**`. Playwright's fixture
  idiom (`async ({ page }, use) => { await use(value) }`) reads to that rule as a call to React 19's
  `use()` hook outside a component. Nothing here renders; the alternative was contorting every fixture
  to dodge a false positive.
- **`playwright.config.ts`** — `timeout: 60_000` and `expect: { timeout: 15_000 }`. Under `astro dev`
  the first request compiles `/api/summaries/generate` and its graph, which expires a 5s web-first
  assertion while the pending card is still, correctly, spinning. Both raise a ceiling on a wait for
  *state*; nothing sleeps.
- **`fixtures/registry.ts`** registers Phase 3's and Phase 4's ids alongside Phase 2's, one per
  scenario shape as the contract asks. They are inert until a spec seeds them.

#### E. The accessibility fix needed no new Polish string

The contract named `src/lib/copy/pl.ts` as a file to change. `aria-labelledby` against the **existing**
visible label was used instead of an `aria-label` built from `copy.nav.credits`, so there is no second
copy of the word to keep in sync — and the balance became addressable by meaning
(`getByLabel(copy.nav.credits)`) rather than by walking from a sibling node. `account.astro` carries
its own id because the topbar renders on that page too.

#### F. The deliberate-break check was run three ways

Each broke a different link in the chain, and each went red on its own assertion:

1. **Card body** — `SummaryCard` rendering a constant instead of `item.content`: red on the
   fingerprint assertion, ledger assertions untouched.
2. **Reported balance** — the endpoint's success body sending `creditsRemaining + 1`: red on the header
   assertion, while the database balance was correct. This is risk #6 in its purest form — the number
   the app *says* diverging from the number it *holds*.
3. **Ledger only** — the fake summarizer recording a different `model`: red on the stored-row
   assertion, with nothing visible on the page wrong at all. Proof that the second side of the oracle
   is live rather than decorative.

---

## Phase 3: The charged-refusal spec

### Overview

Driven by `/10x-e2e`, against risk #6's sharpest case: a refusal that took a credit. Covers the four 422 exits that charge by design and the one that deliberately does not.

### Changes Required:

#### 1. The refusal spec

**File**: `tests/e2e/charged-refusal.spec.ts` (new)

**Intent**: Prove that when the server charges for a refusal, the card says so — and that when it does not charge, the card says that instead. This is the exact contract S-06 Phase 9 shipped and that risk #6 exists to protect.

**Contract**: Seed a cache row whose transcript is unavailable or empty, so the endpoint reaches a charged 422 without any vendor call. Assert, inside the failure card's `role="alert"`: the **Polish** copy for the cause — `copy.errors.codes.noCaptions` for a cached `unavailable`, `copy.errors.codes.transcriptUnavailable` for `empty` (Phase 0 item 6) — the charge line `Za tę operację pobrano kredyt.` (`pl.ts:196`), and the dismiss control. Then assert the other side of the oracle — the ledger actually recorded the debit, balance down by exactly 1, read through the owner connection.

A second case covers the transient `failed`/`timeout` exit, which hardcodes `charged: false` (`generate.ts:678`): the card shows `copy.errors.codes.transcriptFetchFailed` — **a different string from the durable refusal**, which is the point of giving that exit its own code — plus `Nie pobrano kredytu za tę operację.`, and the balance is **unmoved**. Assert each by its own shape — "charged" is not "not un-charged".

With Phase 0 landed, both balance surfaces are live: the form's gate reflects the post-charge number, and so does the **header**, which now syncs on the `credits:changed` event (Phase 0 item 7). Neither needs a reload.

### Success Criteria:

#### Automated Verification:

- `npm run test:e2e` passes with both cases
- `npm run typecheck` and `npm run lint` pass
- The spec passes standalone (`--grep`) and under `--repeat-each=2`

#### Manual Verification:

- **Deliberate-break check**: invert the `charged` boolean on the response and confirm the spec goes red; separately, make the ledger debit silently fail and confirm the ledger half goes red independently of the UI half
- No `test.skip` or `test.fixme` remains
- The refusal text asserted is the Polish `copy.errors.codes.*` entry for that cause, and the two 422s that share an English string assert different Polish ones

**Implementation Note**: Pause here for manual confirmation before Phase 4.

---

## Phase 4: The long-video confirmation spec

### Overview

The only flow no other layer can reach. The confirmation is not a dialog — it is client state rendered as an amber card, and the confirm action is the capture bar's own submit, relabelled, replaying frozen inputs.

### Changes Required:

#### 1. The long-video spec

**File**: `tests/e2e/long-video-confirmation.spec.ts` (new)

**Intent**: Prove the two-credit path end to end: the prompt appears, the relabelled submit replays the inputs it was priced for, and the user is charged the documented 2 credits for the summary they consented to.

**Contract**: Seed a transcript longer than `LONG_TRANSCRIPT_CHARS` (40,000 — the oracle is README §Summary credits and `summaries.ts:159`, pinned independently at `summaries.test.ts:13`, not read off the constant at test time). Submit without the allow-long checkbox → 409 → assert the amber `needs-confirmation` card's cost and resulting-balance copy (`pl.ts:180-183`).

Then click the relabelled submit `Generuj mimo to (2 kr.)` and drive through to a saved summary. Assert both sides: the card shows the fake summarizer's text, and the ledger debited exactly **2**. The relabelled submit replaying `confirm.url`/`confirm.character` (`GenerateSummaryForm.tsx:82-88,151-155`) is the real risk-#6 surface here — a refactor that drops the freeze would send whatever is currently in the form at the price quoted for something else.

**There is no Cancel control.** Editing the URL or character clears the confirmation via `inputsChanged()` (`DashboardSummaries.tsx:336-351`). A spec asserting a cancel button would be asserting a control that does not exist; the gate button `Przejdź do paska generowania, aby potwierdzić` only moves focus to the URL input (`DashboardSummaries.tsx:365-367`).

### Success Criteria:

#### Automated Verification:

- `npm run test:e2e` passes all three specs
- `npm run typecheck` and `npm run lint` pass
- The spec passes standalone and under `--repeat-each=2`

#### Manual Verification:

- **Deliberate-break check**: change the confirmed cost from 2 to 1 on the server and confirm the ledger assertion goes red; separately, break the frozen-input replay so the confirm submits the current form value, and confirm the spec catches it
- The prompt's copy asserted is the amber card's, not an invented dialog's
- The 40,000 threshold in the spec cites its documented source in a comment, not the exported constant

**Implementation Note**: Pause here for manual confirmation before Phase 5.

---

## Phase 5: The CI gate and close-out

### Overview

Make the suite a gate rather than a local convenience, and write down what the phase learned. `test-plan.md:110` lists e2e as **required after §3 Phase 4**, so this is in scope, not optional.

### Changes Required:

#### 1. The `e2e` CI job

**File**: `.github/workflows/ci.yml`

**Intent**: Run the suite on every push and PR to `master`, in parallel with `ci` and `integration`, and block `deploy` on it.

**Contract**: A third job that is effectively `integration`'s setup plus `ci`'s build: the same `supabase start -x <non-essential services>` invocation (its exclusion list is already hard-won — the valid names are container keys, not `config.toml` section names), `npx playwright install --with-deps chromium`, a build with `E2E_FAKE_LLM` set, then `npm run test:e2e`.

Env follows the `integration` job's established shape exactly (`ci.yml:67-71`): the Supabase CLI's fixed local demo JWTs and **literal placeholder vendor keys**. Placeholders are safe here for a different reason than in `integration`, and the comment must say which: `config-status.ts:17-35` checks key **presence only, never validity** (`generate.ts:111-113`), so a placeholder does not steer the app into the "generation disabled" notice — it proceeds into the real flow. What makes it safe is the alias plus cache seeding, not the key being fake. Never `secrets.SUPABASE_URL` — that is production.

Extend `deploy`'s `needs` to `[ci, integration, e2e]`. `deploy`'s own build step must **not** set `E2E_FAKE_LLM` — that omission is the safety property, and it is worth one comment line where a future reader will see it.

Upload the Playwright HTML report as an artifact on failure; a red e2e job with no trace is a job people learn to re-run rather than read.

#### 2. `test-plan.md` §6.4 and status

**File**: `context/foundation/test-plan.md`

**Intent**: §6.4 is the deliverable that lets the next contributor add a spec without re-deriving this phase.

**Amended 2026-09-08 (user ruling during Phase 2)**: §6.4 was **written in Phase 2** — the rules block
had to exist before Phase 3 generated a spec against it, and §6.4 is where it belongs rather than in
`CLAUDE.md` or a standalone file. What remains here is revising it for what Phases 3-5 add (the CI job,
the other two specs) and the short-form paragraph in `CLAUDE.md` / `AGENTS.md` / `README.md` beside the
existing unit and integration ones, which was deferred here so it can describe the finished layer.

**Contract**: Replace `- TBD — see §3 Phase 4.` with the cookbook: file placement and the `*.spec.ts`-not-`*.test.ts` reason; the two-sided oracle rule; the LLM alias and its safety property; cache seeding as the Supadata answer; the separate registry and its accepted consequence; the auth fixture and the `sb-127-auth-token` derivation; the header's `credits:changed` sync and the rule for asserting it (wait for the expected value, never read it once — Phase 0 item 7 replaced the header-never-updates fact); the deliberate-break check as the definition of done; and what is deliberately not covered (sign-in, `ambiguous`, Firefox, component rendering).

Add a §6.6 "Phase 4" entry for what would otherwise be rediscovered: that process separation — not Playwright — is what made this a design phase; that the alias reaches dev as well as build; that research's "header updates in place" claim was wrong and how it was caught. Flip §3's Phase 4 Status to `complete`, mark §5's e2e gate row wired, and add a §8 freshness-ledger line.

#### 3. Change and tracker close-out

**File**: `context/changes/testing-phase-4-critical-flow-e2e/change.md`, Linear MAR-22

**Contract**: `status: complete`, `updated:` stamped. Per `lessons.md`, the Linear issue moves in the **same session** and carries one comment per phase completion, staying In Progress until this final phase closes. `context/foundation/roadmap.md` holds no item with this Change ID (verified — it indexes product slices F-/S-, not test-rollout phases), so there is nothing to sync there.

### Success Criteria:

#### Automated Verification:

- The `e2e` job passes on a PR to `master`
- `ci` and `integration` still pass and still run in parallel
- `deploy` is blocked while any of the three fails, and runs when all three pass
- A failing spec uploads a readable HTML report artifact

#### Manual Verification:

- `deploy`'s build step sets no `E2E_FAKE_LLM`, and the deployed Worker serves real summaries — confirmed against the live site after the first post-merge deploy
- `test-plan.md` §6.4 is sufficient to add a fourth spec without reading this plan
- `test-plan.md` §3 Phase 4 reads `complete`; §5's e2e row reads wired
- Linear MAR-22 reflects the whole change and carries a comment per phase

---

## Testing Strategy

### Unit Tests:

- `chargeFailedTranscript`'s outcome→balance mapping, one `it.each` row per outcome, each asserted by its own shape (Phase 0)

### Integration Tests:

- The 422 body carries `creditsRemaining` on a charged refusal and omits it on the transient and ambiguous exits (Phase 0), split across §6.2's stub and real-database layers by whether the assertion needs a real balance

### E2E Tests:

- Happy flow: generate → saved card, card text + ledger debit of 1 (Phase 2)
- Charged refusal: Polish `copy.errors.codes.*` error + charge line + real debit; transient refusal: no-charge line + unmoved balance (Phase 3)
- Long video: 409 prompt → relabelled confirm → saved card + debit of 2 (Phase 4)

### Manual Testing Steps:

1. Run each spec's **deliberate-break check** — invert the behaviour the spec exists to catch and confirm it goes red. A spec that has not failed on purpose has not been tested.
2. Confirm no vendor call occurs across a full `npm run test:e2e` run.
3. Confirm `dist/` from a plain build contains no fake, and that the deployed Worker summarises for real after the first post-merge deploy.
4. Confirm a hard-killed run is caught by the next run's sweep rather than silently reused.

## Performance Considerations

The `e2e` job adds a third parallel CI job whose wall time is a Supabase stack plus a build plus browser install — comparable to `integration`, so it should not extend total CI time much beyond the slower of the existing two. Chromium-only is half the reason that holds. Playwright's browser cache should be keyed in CI so the install is not paid on every run.

Locally, `reuseExistingServer` keeps a warm dev server across runs; the build cost is paid only under `CI`.

## Migration Notes

None — no schema change. Phase 0 **adds** an optional field to a 422 response body; older clients ignore an unknown key, so there is no client/server ordering constraint on deploy.

## References

- Research: `context/changes/testing-phase-4-critical-flow-e2e/research.md` (Findings 1–8; **Finding 5b's "header updates in place" claim is corrected in Key Discoveries above**)
- Strategy and cookbook: `context/foundation/test-plan.md` §1, §2 risk #6, §3 Phase 4, §6.1–6.3, §7
- Prior phases: `context/changes/testing-phase-2-paid-path/`, `context/changes/testing-phase-3-data-boundary/`
- The governing precedent: `d8f37f1` → `e0fdb0d` (a harness-convenience grant, shipped and reverted by human review)
- Seeding and exact-balance patterns to port: `src/pages/api/summaries/generate.db.int.test.ts:60-99,314-318`
- The alias precedent: `astro.config.mjs:39-46`
- Skill contract: `.claude/skills/10x-e2e/SKILL.md` and its `references/`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 0: Report the balance on a charged refusal

#### Automated

- [x] 0.1 `npm run typecheck` passes — ca954c4
- [x] 0.2 `npm run lint` passes — ca954c4
- [x] 0.3 `npm test` passes, including the new `credits.test.ts` rows — ca954c4
- [x] 0.4 `npm run test:integration` passes, including the new 422-body assertions — ca954c4
- [x] 0.8 `npm run typecheck:astro` passes with the header sync in the tree — ca954c4
- [x] 0.9 Refusal, transient-422 and both 402 bodies carry their documented `code` — ca954c4
- [x] 0.10 `messageForError` prefers the code and falls back on an unknown one — ca954c4

#### Manual

- [x] 0.5 Form balance gate reflects the post-charge balance on a 1-credit account — ca954c4
- [x] 0.6 README §Summary credits no longer claims the UI shows the ambiguous case — ca954c4
- [x] 0.7 `refuseAndCharge`'s doc comment no longer cites the superseded D14 rationale — ca954c4
- [x] 0.11 A charged refusal renders Polish copy, with no English string left on the page — ca954c4
- [x] 0.12 The topbar balance updates in place, with no reload — ca954c4
- [x] 0.13 No endpoint exit the card can render is English any more — ca954c4
- [x] 0.14 A signed-in user opening `/auth/signin` lands on `/summaries` — ca954c4

#### Added by the implementation review (`reviews/impl-review-phase-0.md`, 2026-09-08)

Automated:

- [x] 0.15 The refusal **replay** carries `creditsRemaining` — `get_refusal_replay` returns the balance beside the reason (F1) — 1fc8a5f
- [x] 0.17 No unresolved or absent code renders English — `messageForError` no longer takes the server string (F3) — 1fc8a5f

Manual:

- [x] 0.16 A balance-bearing non-2xx still syncs the balance when the inputs changed mid-flight, while its error card is still dropped (F2) — 1fc8a5f
- [x] 0.18 `plan.md`, `plan-brief.md` and README reconciled with items 6/7 and with F1-F3 (F4) — 1fc8a5f

### Phase 1: The Playwright runner and the LLM seam

#### Automated

- [x] 1.1 Playwright resolves and Chromium installs — 1b88bb3
- [x] 1.2 `npm run typecheck`, `npm run lint` pass with the new files — 1b88bb3
- [x] 1.3 `npm test` and `npm run test:integration` still pass — neither collects `tests/e2e/` — 1b88bb3
- [x] 1.4 Safety proof: plain `npm run build`, no fake marker in `dist/` — 1b88bb3
- [x] 1.5 Seam proof: `E2E_FAKE_LLM=1 npm run build`, fake marker present — 1b88bb3

#### Manual

- [x] 1.6 `E2E_FAKE_LLM=1 npm run dev` serves the fake summary with no OpenRouter call — 1b88bb3
- [x] 1.7 Plain `npm run dev` still reaches the real provider — 1b88bb3
- [x] 1.8 `playwright.config.ts` records the Firefox gap and the `reuseExistingServer` rationale — 1b88bb3

### Phase 2: The e2e harness and the seed spec

#### Automated

- [x] 2.1 `npm run typecheck`, `npm run typecheck:astro`, `npm run lint` pass
- [x] 2.2 `npm test` and `npm run test:integration` still pass
- [x] 2.3 `npm run test:e2e` runs `generate-summary.spec.ts` green
- [x] 2.4 The spec passes twice in a row and under `--repeat-each=2`
- [x] 2.5 A killed run is caught by the next run's stale-row abort

#### Manual

- [x] 2.6 Deliberate-break check: the spec goes red when the card or the balance is wrong
- [x] 2.7 No vendor call during a run
- [x] 2.8 The credit balance is announced with its label on `/summaries` and `/account`
- [x] 2.9 No e2e-registry rows survive a run

### Phase 3: The charged-refusal spec

#### Automated

- [ ] 3.1 `npm run test:e2e` passes with both refusal cases
- [ ] 3.2 `npm run typecheck` and `npm run lint` pass
- [ ] 3.3 The spec passes standalone and under `--repeat-each=2`

#### Manual

- [ ] 3.4 Deliberate-break check: UI half and ledger half each go red independently
- [ ] 3.5 No `test.skip` / `test.fixme` remains
- [ ] 3.6 The asserted refusal text is the Polish `copy.errors.codes.*` entry for the cause, never the English `error` still carried on the body

### Phase 4: The long-video confirmation spec

#### Automated

- [ ] 4.1 `npm run test:e2e` passes all three specs
- [ ] 4.2 `npm run typecheck` and `npm run lint` pass
- [ ] 4.3 The spec passes standalone and under `--repeat-each=2`

#### Manual

- [ ] 4.4 Deliberate-break check: a wrong cost and a broken frozen-input replay are both caught
- [ ] 4.5 The asserted copy is the amber card's, not an invented dialog's
- [ ] 4.6 The 40,000 threshold cites its documented source in a comment

### Phase 5: The CI gate and close-out

#### Automated

- [ ] 5.1 The `e2e` job passes on a PR to `master`
- [ ] 5.2 `ci` and `integration` still pass in parallel
- [ ] 5.3 `deploy` is blocked while any of the three fails and runs when all pass
- [ ] 5.4 A failing spec uploads a readable HTML report artifact

#### Manual

- [ ] 5.5 `deploy` sets no `E2E_FAKE_LLM`; the live site summarises for real after deploy
- [ ] 5.6 §6.4 is sufficient to add a fourth spec without reading this plan
- [ ] 5.7 §3 Phase 4 reads `complete`; §5's e2e row reads wired
- [ ] 5.8 Linear MAR-22 reflects the whole change, one comment per phase
