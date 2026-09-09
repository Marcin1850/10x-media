# Error Monitoring (Sentry) Implementation Plan

## Overview

The app already emits its operationally important events through one deliberate seam
(`src/lib/services/reporting.ts`), and that seam has never had a receiver — S-09's decision **D5b**
built it and explicitly deferred the tool. This plan lands the receiver: **Sentry**, on both runtimes
(Cloudflare Worker and browser), with the money- and degradation-relevant swallowed errors promoted
onto the same seam, alerting calibrated on Sentry's side, and the DSN kept out of every environment
that has no business reporting.

The wiring is small by design. The work is in the three places the roadmap named: reporting must never
be able to break a paid request, no event may escape a test or CI build, and the alert set must stay
small enough to keep being trusted.

## Current State Analysis

**The seam.** `reportEvent(key, severity, payload)` (`src/lib/services/reporting.ts:10`) is the single
swappable point. Its severity rule is fixed — `warn` → `console.warn`, everything else →
`console.error` — and callers pass their own severity vocabulary. Two families feed it:

- **Budget** — `reportBudgetThreshold` (`src/lib/services/supadata-budget.ts:233`), key
  `[supadata-budget]`, severities `stop` / `warn` / `untracked`, payload a `BudgetThresholdEvent`
  (`supadata-budget.ts:195`) whose figures were read under the same row lock that produced the
  decision. Three call sites: `untracked()` (`:247`), `reportNearMiss()` (`:539`), `reportRefusal()`
  (`:550`). All run on the Worker.
- **Unsupported feature** — `reportUnsupportedFeature` (`reporting.ts:34`), key
  `[unsupported-feature]`, severity `warn`. One caller: `useTopUpAction` in
  `src/components/account/TopUpAction.tsx:20`, which runs in a **hydrated React island** — so this
  family currently reaches only the user's own browser console. The module's own doc comment already
  warns that a receiver must support both transports or this family stays invisible.

**The swallowed errors.** Roughly 50 `console.error` / `console.warn` sites exist outside the seam,
and almost none of them throw — this codebase deliberately resolves failures into outcomes rather than
exceptions. That is why an entrypoint wrapper's automatic exception capture will see very little, and
why promotion has to be explicit and selective.

**Constraints already in place that this plan leans on:**

- `src/test/fetch-firewall.ts` throws on every non-loopback `fetch` in the integration project, and
  pins the vendor keys to placeholders at module scope.
- `.dev.vars.e2e` **replaces** `.dev.vars` wholesale for an e2e run (wrangler's `loadDotDevDotVars`
  tries `.dev.vars.<env>` first), and `playwright.config.ts` refuses to start when it is missing.
- `astro.config.mjs:41` proves the shape of a build-time environment guarantee: a Worker built without
  `E2E_FAKE_LLM` _cannot_ contain the fake summarizer, and the proof is a grep of `dist/`.
- All five current secrets are declared `optional` in the `astro:env` schema (`astro.config.mjs`), so a
  build succeeds without them and the app degrades with a notice (`src/lib/config-status.ts`).

**Versions.** Astro `^6.3.1`, `@astrojs/cloudflare` `^13.5.0` — both clear Sentry's documented
prerequisites for the Astro-on-Cloudflare-Workers path (Astro ≥ 6.0.0, adapter ≥ v13, Sentry SDKs
≥ 10.40.0).

**`wrangler.jsonc`** currently sets `"main": "@astrojs/cloudflare/entrypoints/server"` — the package
entrypoint directly. Sentry's server instrumentation requires that to become a local file that wraps
the same handler.

## Desired End State

A production incident, a budget threshold crossing, or a generation whose credit outcome the app could
not determine reaches the operator as a notification, without anyone going looking. Locally, in CI, in
the integration suite and in an e2e run, nothing is sent at all — and that is guaranteed by the absence
of a DSN rather than by a runtime flag.

Verify by: deploying with the Worker secret set, triggering one deliberate event, and seeing it arrive
in Sentry grouped under its own issue with a notification; then confirming that a local `npm run dev`,
`npm test`, `npm run test:integration` and `npm run test:e2e` produce no Sentry traffic.

### Key Discoveries:

- **`reporting.ts` is imported by both a React island and Worker services.** `TopUpAction.tsx:4`
  imports it into the client bundle; `supadata-budget.ts:3` imports it into the Worker. The two
  runtimes need different SDKs (`@sentry/astro`'s browser client vs `@sentry/cloudflare`), so a static
  import of either into this module is wrong. `import.meta.env.SSR` is statically replaced per bundle,
  so branching on it lets Vite drop the Worker branch from the client build entirely.
- **`reporting.ts` must not import `astro:env/server`.** Per `CLAUDE.md`, a module that does is
  unreachable from the `unit` Vitest project — and the seam's never-throws contract is exactly what
  wants unit tests. The DSN therefore belongs in the two `Sentry.init`-equivalent sites (the Worker
  entry wrapper and the client config), never in the seam.
- **`@sentry/cloudflare`'s `dataCollection` defaults are permissive** — user info, cookies and HTTP
  bodies. In this app the cookies are Supabase auth cookies (session tokens) and the generate
  endpoint's bodies carry user content, so the defaults must be tightened explicitly.
- **A client `astro:env` variable is inlined at build time, a server one is read at runtime.** So the
  browser DSN must reach the `deploy` job's _build step_ (a GitHub repo secret) while the server DSN is
  a Worker secret. This asymmetry is convenient: the `e2e` CI job builds without it, so its browser
  bundle physically cannot carry a DSN.
- **`generate.ts`'s money-adjacent failures are all swallowed** (`:909` `begin_generation failed`,
  `:922` `summarize failed`, `:1058` `persist summary failed`, `:1072` `persist summary skipped`,
  `:1096` `replayed summary could not be read back`), as are the three ambiguous-charge markers in
  `credits.ts` (`:300`, `:315`, `:320`). None reach an exception handler.

## What We're NOT Doing

- Uptime or synthetic monitoring; performance tracing (`tracesSampleRate: 0`); session replay;
  real-user monitoring; profiling.
- Duplicating S-07's per-summary cost and latency ledger — that is a record, not an alert.
- Any user-facing status or incident surface.
- Alerting on product metrics (the PRD's 75% "good enough" criterion is a different kind of measurement
  and a roadmap-wide open question).
- Committing the Sentry MCP entry to `.mcp.json` — it is installed at user scope only (decision D7).
- Promoting the remaining console sites (`middleware.ts:53`, `summaries.astro:31`,
  `src/pages/api/summaries/index.ts:40`, `[id].ts:69`, `metadata.ts:209`, `generate.ts:473`
  duplicate-transcript-fetch). They are read-path or informational; leaving them out is the calibration
  decision, not an oversight.
- Replacing any `console.*` call. Every promoted site keeps its console line — Workers Logs stays the
  forensic fallback, and Sentry treats console output as breadcrumbs on other events.
- Changing any event's payload shape, key or wording. `BUDGET_EVENT` and `BudgetThresholdEvent` are
  unchanged; this is a routing change.

## Implementation Approach

Six phases, ordered so that nothing can send an event before the transport's safety properties are in
place, and so the two promotion sets land separately (money first, degradation second) — a deliberately
smaller blast radius per phase, and a natural point to stop if the volume turns out wrong.

Phases 1–3 build and prove the transport with the DSN **unset everywhere**, so they are safe to merge
before the Sentry project is even wired to production. Phases 4–5 promote events. Phase 6 turns it on,
calibrates the alert rules, and records a live verification pass.

## Critical Implementation Details

**Bundle purity is the load-bearing constraint of Phase 3.** `@sentry/cloudflare` must never appear in
a client asset. The proof is the same one this repo already uses for the fake summarizer: grep the
built output. `import.meta.env.SSR` is replaced with a literal by Vite in each bundle, so an
`if (import.meta.env.SSR) { … } else { … }` split with **dynamic** imports on both arms is tree-shaken
correctly; a static import on either arm is not.

**Fire-and-forget is a contract, not a style.** The seam sits inside `reserveBudget`, which runs
immediately before the first paid Supadata call inside a request whose entire design is that a user is
never charged for work they did not receive. `reportEvent` must return synchronously, must never
`await` the transport, and must swallow both a synchronous throw and a rejected promise. Sentry's
`captureMessage` is already non-blocking (it enqueues), but the wrapper cannot depend on that staying
true across SDK versions.

**Ordering within Phase 2.** `wrangler.jsonc`'s `main` and the new wrapper file must land in the same
commit — a `main` pointing at a file that does not exist breaks `npm run dev`, `npm run preview` and
therefore the whole e2e suite, which builds and starts its own server.

**The e2e runner will exercise the new entrypoint.** `playwright.config.ts` builds the app and starts
`preview` with `CLOUDFLARE_ENV=e2e`; the wrapper must be a no-op when `env.SENTRY_DSN` is undefined,
which is the state `.dev.vars.e2e` guarantees.

---

## Phase 1: Sentry project, env plumbing, and the MCP

### Overview

Everything needed before a line of transport code: the Sentry project exists with a spend cap, both
DSNs are declared as optional environment values, every non-production environment documents their
deliberate absence, and the Sentry MCP is reachable from this machine.

### Changes Required:

#### 1. Sentry project (manual, operator)

**Intent**: Create the receiving project on the free developer tier and bound its blast radius before
anything can send to it. Free tier, no sampling (decision D6) — real volume for a single-operator MVP
should be a handful of events a week, but a looping bug can burn a quota in an hour.

**Contract**: One Sentry project, platform `javascript-astro`. Record the org slug, project slug and
DSN. Set a spend cap / rate limit on the project's client keys. One project serves both runtimes; the
two are distinguished by the event keys and Sentry's `environment`, not by separate projects.

#### 2. Environment schema

**File**: `astro.config.mjs`

**Intent**: Declare both DSNs so the app reads them through `astro:env` like every other secret, and so
a build with neither still succeeds — the property that keeps CI and e2e clean by construction.

**Contract**: Two new entries in `env.schema`, both `optional: true`: `SENTRY_DSN` —
`context: "server", access: "secret"`, read at runtime by the Worker wrapper; and `PUBLIC_SENTRY_DSN` —
`context: "client", access: "public"`, **inlined at build time** into the client bundle. They may carry
the same DSN string; they are two entries because they are delivered by two different mechanisms
(Worker secret vs build env).

#### 3. Environment documentation

**Files**: `.env.example`, `.dev.vars.e2e`, `README.md`

**Intent**: Make the absence of a DSN a documented decision rather than an omission, in every file that
describes this project's environment. This is the same treatment `.dev.vars.e2e` already gives the two
vendor non-credentials.

**Contract**: `.env.example` gains both keys **commented out**, with a line saying local development
deliberately does not report and that setting them locally will file real issues. `.dev.vars.e2e` gains
a comment block in its "paid vendors" spirit explaining that no DSN appears here on purpose, and that
because the file replaces `.dev.vars` wholesale an e2e run cannot inherit one. `README.md`'s
environment-variable table gains both rows, marked optional, with the production-only note.

#### 4. Sentry MCP (local, not committed)

**File**: `context/changes/error-monitoring/docs/sentry-mcp.md` (new)

**Intent**: Honour the change note's ask ("we also want to install the Sentry MCP") while keeping the
org/project slugs out of a public repo (decision D7). The repo gets the instructions; the machine gets
the server.

**Contract**: A short doc recording the endpoint shape
(`https://mcp.sentry.dev/mcp/{organizationSlug}/{projectSlug}` — project-scoped is the narrowest of the
three published forms), that the first connection runs an OAuth flow so no token is stored, and the
exact user-scope install command. `.mcp.json` is **not** modified.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Astro type checking passes: `npm run typecheck:astro`
- Linting passes: `npm run lint`
- Build succeeds with no DSN set: `npm run build`
- No DSN is inlined anywhere in the output: `grep -r "ingest.*sentry.io" dist/` returns nothing

#### Manual Verification:

- Sentry project exists; org slug, project slug and DSN recorded (not committed)
- A spend cap or client-key rate limit is set on the project
- The Sentry MCP is connected at user scope and `/mcp` lists its tools
- `.dev.vars.e2e` still contains no DSN, and its new comment says so explicitly

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human before proceeding to the next phase.

---

## Phase 2: Server transport — wrap the Cloudflare entrypoint

### Overview

Instrument the Worker: `Sentry.withSentry` around `@astrojs/cloudflare`'s server handler, with data
collection tightened so the SDK cannot send more than decision D2 granted. Still no seam routing and
still no DSN in any environment — this phase's whole claim is "the app builds, boots and behaves
identically."

### Changes Required:

#### 1. Dependencies

**File**: `package.json`

**Intent**: Add the two Sentry packages the Astro-on-Cloudflare-Workers path requires.

**Contract**: `@sentry/astro` and `@sentry/cloudflare`, both `>= 10.40.0` (the documented minimum for
this combination), as runtime dependencies.

#### 2. Worker entry wrapper

**File**: `src/sentry-worker-entry.ts` (new)

**Intent**: Give the Worker a Sentry-instrumented entrypoint that is a complete no-op when no DSN is
present, and that never sends session cookies or request bodies.

**Contract**: Default-exports `Sentry.withSentry(configFn, handler)` where `handler` is the default
import of `@astrojs/cloudflare/entrypoints/server` and `configFn` is `(env) => ({ … })`. The config is
where decision D8 lives, so it is specified exactly:

```ts
{
  dsn: env.SENTRY_DSN,          // undefined ⇒ SDK disabled; this is the CI/e2e/dev guarantee
  environment: "production",
  tracesSampleRate: 0,          // performance tracing is explicitly out of scope
  dataCollection: {
    userInfo: false,
    cookies: { mode: "off" },   // these are Supabase auth cookies — session tokens
    httpBodies: [],             // generate.ts bodies carry user content
    genAI: { inputs: false, outputs: false },
    // httpHeaders and urlQueryParams keep their `denyList` default — "keep the rest" (D8)
  },
}
```

#### 3. Worker configuration

**File**: `wrangler.jsonc`

**Intent**: Point the Worker at the wrapper instead of the package entrypoint.

**Contract**: `main` changes from `"@astrojs/cloudflare/entrypoints/server"` to the new file. Must land
in the same commit as the file itself — a dangling `main` breaks `dev`, `preview` and the whole e2e
suite.

#### 4. Astro integration

**File**: `astro.config.mjs`

**Intent**: Register `@sentry/astro` so the client bundle can be instrumented in Phase 3, without it
also injecting a Node-based server SDK — workerd is not Node, and the server side is already handled by
the entrypoint wrapper.

**Contract**: `sentry()` added to `integrations`. Source-map upload stays off unless `SENTRY_AUTH_TOKEN`
is present in the build environment, so a contributor build without it still succeeds; if wired, `org`
and `project` come from the same place.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Astro type checking passes: `npm run typecheck:astro`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- Unit suite passes: `npm test`
- Integration suite passes: `npm run test:integration`
- E2e suite passes against the new entrypoint: `npm run test:e2e`
- Deploy is still valid without deploying: `npx wrangler deploy --dry-run`

#### Manual Verification:

- `npm run dev` boots and the app behaves identically with no DSN set
- Generating a summary locally still works end to end
- No Sentry network request is visible in the browser devtools Network tab

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human before proceeding to the next phase.

---

## Phase 3: Route the seam through Sentry

### Overview

Make `reportEvent` forward to Sentry on both runtimes, under a contract it can be held to by unit tests:
it returns synchronously, it never throws, and it does nothing at all when no client is initialised.
This is the phase that makes the seam a receiver, and the phase whose bundle-purity check is
load-bearing.

### Changes Required:

#### 1. The seam

**File**: `src/lib/services/reporting.ts`

**Intent**: Add Sentry forwarding beside the existing console output, without changing the function's
signature, its severity rule, or any event's key or payload.

**Contract**: `reportEvent(key, severity, payload)` keeps its signature and both console branches. After
logging, it forwards to Sentry with:

- **Level mapping**: `warn` → Sentry `"warning"`; everything else → `"error"`. Same rule as the console
  branch, so the two can never disagree.
- **Message**: `key` and `severity` only. The payload goes on as structured context, never interpolated
  into the message string — a message carrying changing numbers is what splits one condition into many
  issues under default grouping.
- **`fingerprint: [key, severity]`**: one condition, one issue, regardless of the figures. This is the
  mechanism decision D3 rests on — every event is still sent, so the dashboard shows the full stream,
  but the operator's inbox gets one notification per condition (Phase 6 sets the rules).
- **Fire-and-forget**: never `await`ed; a synchronous throw and a rejected promise are both swallowed.
- **No `astro:env` import** — the DSN is supplied at `init` time by the two runtime entrypoints, never
  here, so this module stays reachable from the `unit` Vitest project.
- **Runtime split**: `import.meta.env.SSR` selects a **dynamic** import of a server sink
  (`@sentry/cloudflare`) or a client sink (`@sentry/astro`). Both arms dynamic — a static import on
  either one defeats the tree-shake and lands the Worker SDK in the client bundle.

#### 2. Browser initialisation

**File**: `sentry.client.config.ts` (new, project root)

**Intent**: Initialise the browser SDK so the `[unsupported-feature]` family reaches the same project
(decision D1), with the same data-collection lockdown as the Worker.

**Contract**: `Sentry.init` with the DSN from the client `astro:env` value, `tracesSampleRate: 0`, replay
integrations off, and the D8 `dataCollection` object mirrored. A missing DSN must leave the SDK
uninitialised rather than throw.

#### 3. Seam tests

**File**: `src/lib/services/reporting.test.ts` (new)

**Intent**: Turn the never-throws / never-blocks contract from a comment into a checked property. This
is the contract that protects the paid path, so it is the one thing here worth testing directly.

**Contract**: Cases that must each catch a different regression — a sink that throws synchronously does
not propagate; a sink that returns a rejected promise does not produce an unhandled rejection; a sink
that never settles does not delay `reportEvent`'s return; no initialised client is a silent no-op; the
`warn` → `warning` / other → `error` mapping; and the fingerprint is `[key, severity]` and stable across
differing payloads. The sink is the injected seam — do not stub `fetch` or Sentry's transport.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Unit suite passes, including the new seam tests: `npm test`
- Build succeeds: `npm run build`
- Client bundle purity: `grep -rl "@sentry/cloudflare" dist/_astro/` returns nothing
- Integration suite passes: `npm run test:integration`
- E2e suite passes: `npm run test:e2e`

#### Manual Verification:

- With no DSN set, clicking the top-up button still logs to the browser console and issues no network
  request
- With no DSN set, a local generation still logs `[supadata-budget]` lines to the Worker console

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human before proceeding to the next phase.

---

## Phase 4: Promote the money events

### Overview

Route the failures that mean a user may have paid for work they did not receive — including the
ambiguous-charge case, which carries account identifiers as the deliberate, documented exception
decision D2 granted.

### Changes Required:

#### 1. The identifier exception

**File**: `src/lib/services/reporting.ts`

**Intent**: Amend the seam's contract rather than quietly contradicting it. `reportUnsupportedFeature`'s
doc comment currently states "No user identifiers in the payload" as a property of the seam; after this
phase that is a property of _most_ events, with one named exception.

**Contract**: A module-level doc comment stating: the seam's default is no user identifiers; the
`[charge-ambiguous]` event is the single exception; the reason (the event is only actionable because it
names the row to reconcile); and the retention position (identifiers are opaque UUIDs, never emails, and
are subject to the Sentry project's retention window). Any future exception must be added here.

#### 2. Ambiguous charge

**File**: `src/lib/services/credits.ts`

**Intent**: Promote the three `REFUSAL_CHARGE_AMBIGUOUS` markers onto the seam, so the one event whose
resolution requires an operator to reconcile a specific ledger row actually reaches the operator.

**Contract**: The sites at `:300`, `:315` and `:320` each additionally call `reportEvent` with a new key
(e.g. `[charge-ambiguous]`), severity `error`, and a payload carrying `userId`, `requestId`,
`refusalReason` and a short cause discriminator distinguishing the three (no row returned / unknown
outcome / rejected promise). Console lines stay. `REFUSAL_NOT_CHARGED` (`:291`) is deliberately **not**
promoted — it proves no debit landed, so nothing needs reconciling.

#### 3. Paid-path integrity

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Promote the swallowed failures on the generation path that can leave a charge and a delivery
out of step. `withSentry`'s automatic capture will not see these — they never throw.

**Contract**: The five sites at `:909` (`begin_generation failed`), `:922` (`summarize failed`), `:1058`
(`persist summary failed`), `:1072` (`persist summary skipped`) and `:1096` (`replayed summary could not
be read back`) each additionally call `reportEvent` under one key (e.g. `[paid-path]`) at severity
`error`, with a per-site discriminator in the payload so the fingerprint separates them. Console lines
stay. No user identifiers beyond what decision D2 granted — these carry the failing stage, not the
account.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Unit suite passes: `npm test`
- Integration suite passes, including the ambiguous-charge scenarios: `npm run test:integration`
- Build succeeds: `npm run build`

#### Manual Verification:

- The amended seam contract reads as a granted exception, not as a contradiction of the old comment
- No promoted payload carries an email address or any identifier beyond `userId` / `requestId`

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human before proceeding to the next phase.

---

## Phase 5: Promote the degradation events

### Overview

Route the silent-degradation family: cache, ledger and lock failures. These are self-healing and
individually harmless, which is exactly why they are invisible — a broken cache re-pays both vendors on
every request while the app keeps working. Fingerprinting is what keeps them from becoming the inbox
that teaches you to ignore Sentry.

### Changes Required:

#### 1. Cache and guard failures

**Files**: `src/lib/services/transcript-cache.ts`, `src/lib/services/metadata-cache.ts`,
`src/lib/services/transcript-guard.ts`

**Intent**: Report read/write failures against the caches that stand between the app and a paid vendor
call, so a regression that silently disables caching is visible before the vendor bill is.

**Contract**: Each existing `console.error` site (`transcript-cache.ts:117,138,215,222`,
`metadata-cache.ts:75,94,131,135`, `transcript-guard.ts:92,110,154,158,187,191`) additionally calls
`reportEvent` under a per-module key (so fingerprints separate by module) at severity `error`, with the
operation name and the error message in the payload. **No user identifiers** — the D2 exception is
narrow and does not extend here. Console lines stay.

#### 2. Ledger and lock failures

**Files**: `src/lib/services/supadata-ledger.ts`, `src/lib/services/generation-lock.ts`,
`src/lib/services/supadata-budget.ts`

**Intent**: Report the bookkeeping failures that make the budget guard's own numbers untrustworthy — a
lost ledger flush or an unsettled reservation degrades the very data `reportBudgetThreshold` reasons
about.

**Contract**: `supadata-ledger.ts:180,184`, `generation-lock.ts:62,72` and the settle failures at
`supadata-budget.ts:586,596,600` route at severity `error`; `generation-lock.ts:68` (a lease already
swept as stale — expected under load) routes at `warn`. Reservation ids are operational identifiers, not
account identifiers, and may travel. Console lines stay.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Unit suite passes: `npm test`
- Integration suite passes: `npm run test:integration`
- Build succeeds: `npm run build`

#### Manual Verification:

- Each module's events fingerprint separately (distinct keys), so one failing cache does not mask another
- No degradation payload carries a `userId`

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human before proceeding to the next phase.

---

## Phase 6: Turn it on — calibration, live verification, and docs

### Overview

Supply the DSNs to production only, set the alert rules that make decision D3 survivable, prove the whole
path with one deliberate live event, and leave the record and documentation behind.

### Changes Required:

#### 1. Production secrets

**Intent**: Deliver each DSN by the mechanism its runtime needs — and by no other, so every
non-production environment stays silent by absence.

**Contract**: `SENTRY_DSN` set as a Worker secret (`npx wrangler secret put SENTRY_DSN`), read at
runtime. `PUBLIC_SENTRY_DSN` added as a GitHub repository secret and passed to the **`deploy` job's build
step only** — it is inlined at build time, so it must be present there and absent everywhere else. The
`ci`, `integration` and `e2e` jobs set neither.

#### 2. CI workflow

**File**: `.github/workflows/ci.yml`

**Intent**: Wire the client DSN into the deploy build, and make the omission from the other three jobs
explicit rather than incidental — the same way the workflow already documents that `deploy`'s build sets
neither `E2E_FAKE_LLM` nor `CLOUDFLARE_ENV`.

**Contract**: The `deploy` job's build step gains `PUBLIC_SENTRY_DSN` from repository secrets, with a
comment stating that the `ci`, `integration` and `e2e` jobs deliberately do not set it and that this is
what keeps CI from filing incidents against itself.

#### 3. Sentry-side calibration (manual, operator)

**Intent**: Implement decision D3 — every event is sent, but a single ongoing condition produces one
notification, not a stream. This is the calibration the roadmap calls the whole value of the slice.

**Contract**: Alert rules that notify on **first-seen and regression** of an issue rather than per event,
so the `[supadata-budget]` / `warn` issue — which re-fires roughly once per reading TTL for as long as
the budget stays high — notifies once and then accumulates silently under the fingerprint set in Phase 3.
Confirm the spend cap from Phase 1 is active.

#### 4. Live verification record

**File**: `context/changes/error-monitoring/reviews/manual-verification.md` (new)

**Intent**: The account wiring — right DSN, right project, grouping, alert rule — is only provable live,
so the record is what gives that pass lasting value.

**Contract**: Records the deliberate event fired, the issue it grouped under, whether the notification
arrived, and the negative checks (a local run, an integration run and an e2e run each sending nothing).
**No account identifiers**: describe the role ("the operator's account"), never an email or UUID — the
repo is public, and this is a real-environment pass.

#### 5. Documentation

**Files**: `README.md`, `CLAUDE.md`, `AGENTS.md`

**Intent**: Leave the environment story and the alert set discoverable, and record that the DSN's absence
outside production is a decision.

**Contract**: `README.md` gains an "Error monitoring" section covering the two DSNs, why neither is set
locally, what is alerted on and what is deliberately not monitored. `CLAUDE.md` and `AGENTS.md` gain a
line on the seam's new role and the client/server bundle constraint — and must stay byte-identical to
each other.

#### 6. Tracker sync

**Files**: `context/foundation/roadmap.md`, Linear MAR-24

**Intent**: Keep the roadmap and the board matching reality at the moment the slice closes, per the
project's standing rule.

**Contract**: S-13's status advances in the At a glance table, the slice body and the Backlog Handoff row
in one edit; the Linear issue moves to the matching state with a comment summarising the phase.

### Success Criteria:

#### Automated Verification:

- All three CI jobs pass on the PR: `ci`, `integration`, `e2e`
- Build succeeds locally without either DSN: `npm run build`
- No DSN in a non-deploy build's output: `grep -r "ingest.*sentry.io" dist/` returns nothing

#### Manual Verification:

- A deliberate event fired in production arrives in Sentry under its own fingerprinted issue
- The alert rule delivers exactly one notification for that issue, not one per event
- `npm run dev` locally, `npm run test:integration` and `npm run test:e2e` each send nothing
- The verification record contains no account identifiers
- The roadmap and Linear reflect the closed slice

---

## Testing Strategy

### Unit Tests:

- The seam's never-throws / never-blocks contract (`reporting.test.ts`, Phase 3): synchronous throw,
  rejected promise, never-settling sink, no client initialised.
- Level mapping (`warn` → `warning`, everything else → `error`) and fingerprint stability across
  differing payloads.
- Existing suites for the promoted modules must stay green — promotion adds a call, it does not change
  any outcome.

### Integration Tests:

- The existing ambiguous-charge scenarios in `generate.int.test.ts` continue to pass with the promoted
  reporting call in place.
- No new integration test is added for outbound suppression: `fetch-firewall.ts` already throws on every
  non-loopback fetch in that project, so an escaping event fails the suite by construction.

### Manual Testing Steps:

1. With no DSN set, run `npm run dev`, generate a summary, and confirm the console output is unchanged
   and no request reaches Sentry.
2. Click the top-up button and confirm the `[unsupported-feature]` line still appears in the browser
   console with no network request.
3. Deploy with the Worker secret set; fire one deliberate event; confirm it arrives, groups under its own
   issue, and produces exactly one notification.
4. Re-run the e2e suite after deploying and confirm no events appear for it.

## Performance Considerations

`tracesSampleRate: 0` — no performance tracing, so no span overhead on the Worker. The reporting call is
fire-and-forget and never awaited, so it adds no latency to the generation path; the dynamic import
resolves once per isolate and is cached thereafter. The browser SDK adds bundle weight to hydrated
islands, kept minimal by omitting the replay and tracing integrations.

## Migration Notes

No database changes, no data migration. The one irreversible-feeling step is `wrangler.jsonc`'s `main`
moving to a local wrapper; reverting is a one-line change back to the package entrypoint.

Rollback at any point after Phase 6 is unsetting the Worker secret — the SDK disables itself with an
undefined DSN, and the app returns to console-only reporting with no code change.

## References

- Roadmap slice: `context/foundation/roadmap.md` §S-13 (and §S-09 decisions D5 / D5b, which built this
  seam and deferred its receiver)
- The seam: `src/lib/services/reporting.ts`, `src/lib/services/supadata-budget.ts:195-250`
- Environment-isolation precedent: `astro.config.mjs:15-45`, `.dev.vars.e2e`, `src/test/fetch-firewall.ts`
- Sentry MCP: `context/changes/error-monitoring/docs/sentry-mcp.md`
- Linear: MAR-24

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Sentry project, env plumbing, and the MCP

#### Automated

- [ ] 1.1 Type checking passes: `npm run typecheck`
- [ ] 1.2 Astro type checking passes: `npm run typecheck:astro`
- [ ] 1.3 Linting passes: `npm run lint`
- [ ] 1.4 Build succeeds with no DSN set: `npm run build`
- [ ] 1.5 No DSN is inlined anywhere in the output

#### Manual

- [ ] 1.6 Sentry project exists; org slug, project slug and DSN recorded (not committed)
- [ ] 1.7 A spend cap or client-key rate limit is set on the project
- [ ] 1.8 The Sentry MCP is connected at user scope and `/mcp` lists its tools
- [ ] 1.9 `.dev.vars.e2e` still contains no DSN, and its new comment says so explicitly

### Phase 2: Server transport — wrap the Cloudflare entrypoint

#### Automated

- [ ] 2.1 Type checking passes: `npm run typecheck`
- [ ] 2.2 Astro type checking passes: `npm run typecheck:astro`
- [ ] 2.3 Linting passes: `npm run lint`
- [ ] 2.4 Build succeeds: `npm run build`
- [ ] 2.5 Unit suite passes: `npm test`
- [ ] 2.6 Integration suite passes: `npm run test:integration`
- [ ] 2.7 E2e suite passes against the new entrypoint: `npm run test:e2e`
- [ ] 2.8 Deploy is still valid without deploying: `npx wrangler deploy --dry-run`

#### Manual

- [ ] 2.9 `npm run dev` boots and the app behaves identically with no DSN set
- [ ] 2.10 Generating a summary locally still works end to end
- [ ] 2.11 No Sentry network request is visible in the browser devtools Network tab

### Phase 3: Route the seam through Sentry

#### Automated

- [ ] 3.1 Type checking passes: `npm run typecheck`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Unit suite passes, including the new seam tests: `npm test`
- [ ] 3.4 Build succeeds: `npm run build`
- [ ] 3.5 Client bundle purity: no client asset references the Worker SDK
- [ ] 3.6 Integration suite passes: `npm run test:integration`
- [ ] 3.7 E2e suite passes: `npm run test:e2e`

#### Manual

- [ ] 3.8 With no DSN set, the top-up button logs to the browser console and issues no network request
- [ ] 3.9 With no DSN set, a local generation still logs `[supadata-budget]` lines to the Worker console

### Phase 4: Promote the money events

#### Automated

- [ ] 4.1 Type checking passes: `npm run typecheck`
- [ ] 4.2 Linting passes: `npm run lint`
- [ ] 4.3 Unit suite passes: `npm test`
- [ ] 4.4 Integration suite passes, including the ambiguous-charge scenarios: `npm run test:integration`
- [ ] 4.5 Build succeeds: `npm run build`

#### Manual

- [ ] 4.6 The amended seam contract reads as a granted exception, not a contradiction
- [ ] 4.7 No promoted payload carries an email address or any identifier beyond `userId` / `requestId`

### Phase 5: Promote the degradation events

#### Automated

- [ ] 5.1 Type checking passes: `npm run typecheck`
- [ ] 5.2 Linting passes: `npm run lint`
- [ ] 5.3 Unit suite passes: `npm test`
- [ ] 5.4 Integration suite passes: `npm run test:integration`
- [ ] 5.5 Build succeeds: `npm run build`

#### Manual

- [ ] 5.6 Each module's events fingerprint separately, so one failing cache does not mask another
- [ ] 5.7 No degradation payload carries a `userId`

### Phase 6: Turn it on — calibration, live verification, and docs

#### Automated

- [ ] 6.1 All three CI jobs pass on the PR: `ci`, `integration`, `e2e`
- [ ] 6.2 Build succeeds locally without either DSN: `npm run build`
- [ ] 6.3 No DSN in a non-deploy build's output

#### Manual

- [ ] 6.4 A deliberate production event arrives in Sentry under its own fingerprinted issue
- [ ] 6.5 The alert rule delivers exactly one notification for that issue, not one per event
- [ ] 6.6 A local dev run, an integration run and an e2e run each send nothing
- [ ] 6.7 The verification record contains no account identifiers
- [ ] 6.8 The roadmap and Linear reflect the closed slice
