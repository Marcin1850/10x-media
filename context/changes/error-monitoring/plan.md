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

**`wrangler.jsonc`** sets `"main": "@astrojs/cloudflare/entrypoints/server"` — the package entrypoint
directly, and **Phase 2 repoints it at a hand-written `worker.ts`** that re-exports exactly that handler
through `withSentry`.

> **Amended during Phase 2 implementation (2026-09-10).** The plan originally kept `main` untouched on
> the premise that `@sentry/astro` ≥ 10.40 "detects the Cloudflare adapter and installs a Vite plugin
> that wraps the built Worker entry with `withSentry` itself", making a hand-written wrapper a second,
> competing path. Both halves of that premise are false against the installed
> `astro@6.3.1` / `@astrojs/cloudflare@13.5.0` / `@sentry/{astro,cloudflare}@10.74.0`:
>
> 1. **The integration's wrapper never fires.** Its transform is gated on
>    `id.includes("astrojs-ssr-virtual-entry")`
>    (`node_modules/@sentry/astro/build/esm/integration/cloudflare.js`), and Astro 6 with adapter v13
>    builds the entry as `astro:cloudflare:worker-entry`. Proved by building with the integration's
>    server half enabled and grepping: `grep -rl withSentry dist/` returned **nothing**. There was no
>    Worker instrumentation at all.
> 2. **`@sentry/cloudflare` exports no `init`**, so a `sentry.server.config.ts` calling `Sentry.init`
>    cannot work either — the build warns `"init" is not exported by "@sentry/cloudflare"` and the call
>    would throw on every page render. The SDK says why in `defineCloudflareOptions`'s own docs: "the
>    options cannot be applied at module load time on Cloudflare: the DSN and other settings typically
>    come from the per-request `env`, which only exists inside the handler."
> 3. Even where the wrapper *does* fire it is hardcoded `withSentry(() => undefined, handler)`, so
>    per-request options can only come from Worker **env vars** (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`,
>    `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_DEBUG`). `dataCollection` cannot travel that way at all.
>
> The wrapper is therefore the only path that can carry decision D8, and it is the one Sentry's own
> Astro-on-Cloudflare docs show. `plan-review.md` F2's concern — *two* server initialisation paths — is
> answered instead by `enabled: { server: false }` on the integration, which leaves exactly one.

## Desired End State

A production incident, a budget threshold crossing, or a generation whose credit outcome the app could
not determine reaches the operator as a notification, without anyone going looking. Locally, in CI, in
the integration suite and in an e2e run, nothing is sent at all — and that is guaranteed by the absence
of a DSN rather than by a runtime flag.

Verify by: deploying with the Worker secret set, triggering **one deliberate event per runtime** — the
two initialise independently, so one event proves one of them and says nothing about the other — and
seeing both arrive in Sentry, each grouped under its own issue, with a notification; then confirming
that a local `npm run dev`, `npm test`, `npm run test:integration` and `npm run test:e2e` produce no
Sentry traffic.

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
- **`@sentry/cloudflare`'s `dataCollection` behaviour is a trap, but not the one expected.** _Amended
  2026-09-10:_ the option resolves against one of **two** baselines
  (`@sentry/core`'s `resolveDataCollectionOptions`). With `dataCollection` **absent** it uses the tight
  `sendDefaultPii: false` baseline — which already is, field for field, what D8 asks for. The moment
  **any** field is set the baseline flips to the fully permissive `DEFAULTS`, so a *partial* object
  **loosens** the Worker rather than tightening it (set `userInfo: false` alone and `httpBodies` widens
  from `[]` to all four). The consequence is not "tighten the defaults" but "if you configure it at all,
  configure every field" — which is why Phase 2 §2's block is exhaustive and none of its lines may be
  dropped as a restatement of a default.
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
- Promoting the console sites listed as **excluded** in the Promotion Roster below. Leaving each of them
  out is the calibration decision, not an oversight — which is why every one of them is named with its
  reason rather than passed over in silence.
- Replacing any `console.*` call. Every promoted site keeps its console line — Workers Logs stays the
  forensic fallback, and Sentry treats console output as breadcrumbs on other events.
- Changing any event's payload shape, key or wording. `BUDGET_EVENT` and `BudgetThresholdEvent` are
  unchanged; this is a routing change.

## Promotion Roster

Every operator-relevant `console.error` / `console.warn` in `src/` outside the seam, classified. An
implementer should not have to guess whether an unlisted site was considered; a future site is added
here before it is promoted or dismissed.

**Promoted — money integrity (Phase 4)**

| Site | Key | Why it is signal |
| --- | --- | --- |
| `credits.ts:300,315,320` | `[charge-ambiguous:*]` | The app cannot tell whether a credit moved; only an operator can reconcile the row. |
| `credits.ts:438,447` (`CREDIT_LEAK`) | `[credit-leak:refund-failed]`, `[credit-leak:refund-threw]` | A refund that failed leaves the reservation open — the user is out a credit until someone reconciles. The message already says so. |
| `credits.ts:378,397` (`get_refusal_replay`) | `[replay-read:rpc-error]`, `[replay-read:threw]` | Fails **open**: both paths return `null`, which reads as "no replay", so a retry of an already-charged refusal can be charged again. |
| `generate.ts:909,922,1058,1072,1096` | `[paid-path:*]` | Charge and delivery can end up out of step. |

**Promoted — silent degradation (Phase 5)**

| Site | Key | Why it is signal |
| --- | --- | --- |
| `transcript-cache.ts`, `metadata-cache.ts`, `transcript-guard.ts` (14 sites) | `[<module>:<operation>]` | A broken cache re-pays both vendors on every request while the app keeps working. |
| `supadata-ledger.ts:180,184`, `supadata-budget.ts:586,596,600`, `generation-lock.ts:62,68,72` | `[<module>:<operation>]` | Bookkeeping failures make the budget guard's own numbers untrustworthy. |
| `generate.ts:194` (`acquireGenerationLease failed`) | `[generation-lock:acquire-threw]` | Same lock family; a lease that cannot be taken fails every generation for that user. |
| `generate.ts:681` (`recordTranscriptAttempt failed`) | `[transcript-guard:record-threw]` | Same guard family; the rate limiter in front of the unbounded fetch is down. |

**Excluded, deliberately**

| Site | Why it is not worth an alert |
| --- | --- |
| `credits.ts:291` (`REFUSAL_NOT_CHARGED`) | Proves no debit landed — there is nothing to reconcile. |
| `generate.ts:512`, `:534` | Fail **closed** before any charge or vendor call; nothing is debited or fetched, and the same database trouble surfaces through the promoted post-charge siblings. |
| `generate.ts:706` (`fetchTranscript failed`) | A vendor outage the user is told about and is not charged for; during an incident it is the highest-volume line in the app, which is exactly what erodes trust in the inbox. |
| `generate.ts:978` (`fetchVideoMetadata threw despite being total`) | Degrades presentation only — the summary is still delivered and the credit outcome is unaffected. |
| `generate.ts:473` (`[duplicate-transcript-fetch]`) | Informational by construction; it already says nothing failed. |
| `metadata.ts:209` | Same presentation-only degradation as `:978`, one layer down. |
| `middleware.ts:53`, `summaries.astro:31`, `api/summaries/index.ts:40`, `[id].ts:69` | Read-path failures the user sees immediately and retries; no money and no hidden state. |

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

**One instrumentation path, not two.** `@sentry/astro` owns both runtimes: registering `sentry()`
injects the client and server init files and wraps the Worker entry through its Cloudflare Vite plugin.
_Amended 2026-09-10 — the split is by runtime, and each runtime has exactly one owner._ The integration
owns the **browser** (it injects `sentry.client.config.ts`) and source maps; `worker.ts`, which
`wrangler.jsonc`'s `main` points at, owns the **Worker**. The integration's server half is switched off
(`enabled: { server: false }`) — not because it competes with `worker.ts`, but because on these versions
it instruments nothing (see the amendment under Current State Analysis) while standing ready to
double-instrument from a different options source the day an SDK release fixes its entry-id guard. One
owner per runtime, stated in the config rather than inferred.

**The server DSN has to be observed arriving at runtime.** `worker.ts` reads it as `env.SENTRY_DSN`
inside `withSentry`'s options callback, because on Cloudflare that is the only place a Worker secret
exists — it is a runtime binding, not a build-time constant, and `@sentry/cloudflare` deliberately
offers no module-load-time `init` for that reason. Phase 2 does not get to assume the binding resolves:
it has to see it in a real `npm run preview` boot with a scratch DSN before Phase 6 depends on it.

**The e2e runner will exercise the instrumented entrypoint.** `playwright.config.ts` builds the app and
starts `preview` with `CLOUDFLARE_ENV=e2e`; `worker.ts` must be a no-op when `SENTRY_DSN` is undefined,
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
because the file replaces `.dev.vars` wholesale an e2e run cannot inherit one. `README.md` needs more than two table rows, because this change
**invalidates statements it already makes**: “All variables … are treated as server-only secrets — they
are never exposed to the client” is false of `PUBLIC_SENTRY_DSN`, which is inlined into the browser
bundle by design, and “Set all five runtime secrets” becomes a count of six. So: the environment-variable
table gains both rows marked optional; the paragraph introducing it gains the public/server distinction;
the deployment section's Worker-secret list gains `SENTRY_DSN` (and only that one — the public DSN is a
*build* input, not a Worker secret); and the CI repository-secret table gains `PUBLIC_SENTRY_DSN`, used
by the deploy job's build step only. A runbook that contradicts itself is worse than one that is
silent.

#### 4. E2E environment guard

**File**: `playwright.config.ts`

**Intent**: Make the e2e suite's silence a property of the runner rather than of a developer's luck.
`.dev.vars.e2e` governs the Worker's bindings; it does **not** govern the client *build*, which is what
`PUBLIC_SENTRY_DSN` is inlined into. `npm run test:e2e` starts Node with `--env-file-if-exists=.env`,
and Playwright hands the parent `process.env` to the `webServer` child — so a developer who has ever put
a DSN in `.env` builds a browser bundle that reports, and `src/test/fetch-firewall.ts` never sees it
because the app is a different process.

**Contract**: A third config-load guard beside the loopback and `.dev.vars.e2e` checks — same placement,
for the same reason: they run while Playwright loads the file, before `webServer` starts, and
`globalSetup` is too late. It **throws** when either `SENTRY_DSN` or `PUBLIC_SENTRY_DSN` is set,
naming the variable and saying the run would otherwise file real issues against the operator's project.
Fail closed: refuse to start rather than reconfigure quietly. `webServer.env` additionally pins both to
`""` so the child cannot inherit one by some other route.

#### 5. Sentry MCP (local, not committed)

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
- The e2e runner refuses to start with a DSN present: `PUBLIC_SENTRY_DSN=x npm run test:e2e` exits
  non-zero before the build, and the same holds for `SENTRY_DSN`

#### Manual Verification:

- Sentry project exists; org slug, project slug and DSN recorded (not committed)
- A spend cap or client-key rate limit is set on the project
- The Sentry MCP is connected at user scope and `/mcp` lists its tools
- `.dev.vars.e2e` still contains no DSN, and its new comment says so explicitly

**Implementation Note**: After completing this phase and all automated verification passes, pause here
for manual confirmation from the human before proceeding to the next phase.

---

## Phase 2: Server transport — instrument the Worker

### Overview

Instrument the Worker by wrapping the adapter's own handler with `@sentry/cloudflare`'s `withSentry`,
with data collection pinned so the SDK cannot send more than decision D2 granted. Still no seam routing
and still no DSN in any environment — this phase's whole claim is "the app builds, boots and behaves
identically."

_Amended 2026-09-10: this phase originally routed the Worker through `@sentry/astro`'s Cloudflare path
and a `sentry.server.config.ts`. Neither exists in a working form on the installed versions — see the
amendment under Current State Analysis for the evidence. §2–§4 below are the amended shape._

### Changes Required:

#### 1. Dependencies

**File**: `package.json`

**Intent**: Add the two Sentry packages the Astro-on-Cloudflare-Workers path requires.

**Contract**: `@sentry/astro` and `@sentry/cloudflare` as runtime dependencies, **on the same v10
release**, pinned with this repo's usual caret (`^10.x`) against a version verified at install time to
be **≥ 10.54**. Two separate bounds are at work and the higher one wins: 10.40 is the documented minimum
for Astro-on-Cloudflare-Workers *support*, but the `dataCollection` object §2 specifies exactly did not
land until 10.54 — a 10.4x install would type-check and then silently keep the permissive defaults this
plan exists to tighten. The caret is also what bounds the range below 11: an open `>=` would let a
breaking major in on a routine `npm install`. Confirm the resolved version and that `dataCollection` is
in its types before moving on.

#### 2. Server initialisation

**File**: `worker.ts` (new, project root)

**Intent**: Give the Worker its Sentry initialisation at the only point on this runtime that can carry
one — the entry handler, wrapped — as a complete no-op when no DSN is present, and one that never sends
session cookies or request bodies.

**Contract**: `export default Sentry.withSentry((env) => ({ … }), handler)`, where `handler` is the
adapter's own `@astrojs/cloudflare/entrypoints/server` default export, re-exported unchanged. The DSN
comes from the **server** value only — `env.SENTRY_DSN`, never `PUBLIC_SENTRY_DSN` — so a browser DSN
present at build time cannot switch the Worker on. `env` rather than `astro:env/server` because on
Cloudflare a Worker secret is a per-request binding: `@sentry/cloudflare` exports no `init` precisely so
that nobody tries to read one at module load. A missing DSN leaves the SDK disabled rather than throwing.
The file must **not** be named `sentry.server.config.*` — that is the name `@sentry/astro` probes for and
would inject into every page's SSR module.

The config is where decision D8 lives, so it is specified exactly. Every field is present because a
partial `dataCollection` flips the resolution baseline to the permissive `DEFAULTS` (see Key
Discoveries) — dropping a line here **widens** what is sent:

```ts
// const PII = ["forwarded", "-ip", "remote-", "via", "-user"];
{
  dsn: env.SENTRY_DSN,          // undefined ⇒ SDK disabled; this is the CI/e2e/dev guarantee
  environment: "production",
  tracesSampleRate: 0,          // performance tracing is explicitly out of scope
  dataCollection: {
    userInfo: false,
    cookies: false,             // these are Supabase auth cookies — session tokens
    httpBodies: [],             // generate.ts bodies carry user content
    // "keep the rest" (D8) has to be written out: a present `dataCollection` would otherwise select
    // the wider `true` for these two. The list reproduces `@sentry/core`'s own non-PII baseline.
    httpHeaders: { request: { deny: PII }, response: { deny: PII } },
    urlQueryParams: { deny: PII },
    databaseQueryData: false,   // Supabase query values and returned rows are user content
    genAI: { inputs: false, outputs: false },
  },
}
```

#### 3. Worker configuration

**File**: `wrangler.jsonc`

**Intent**: Make the wrapped handler the Worker's entry. _Amended 2026-09-10: this section previously
recorded a deliberate non-change, on the premise that the integration wrapped the entry for us. It does
not — see Current State Analysis._

**Contract**: `main` becomes `"./worker.ts"`, with a comment saying what it is not (the adapter's own
`@astrojs/cloudflare/entrypoints/server`, which `worker.ts` re-exports) and why. The adapter honours a
user-set `main` (`@astrojs/cloudflare/dist/wrangler.js`: `main: config.main ?? …`) and bundles it, so the
emitted `dist/server/wrangler.json` still points at a generated `entry.mjs`. Nothing else in the file
changes.

#### 4. Astro integration

**File**: `astro.config.mjs`

**Intent**: Register `@sentry/astro` as the owner of the **browser** half and of source maps — one owner
per runtime, with the Worker's owner being §2.

**Contract**: `sentry()` added to `integrations` with `enabled: { client: true, server: false }`.
_Amended 2026-09-10: the original contract enabled both runtimes._ The server half is off because on
these versions it instruments nothing (its entry-id guard never matches) while standing ready to
double-instrument from a different options source — Worker env vars rather than §2 — the day an SDK
release fixes that guard; the same flag also skips the `@sentry/node`-based `@sentry/astro/middleware`
injection, which has no business on workerd. The client half stays on so Phase 3 §2's
`sentry.client.config.ts` is picked up. **Known transient:** until that file exists, the integration
injects its _default_ client snippet — a ~275 KB bundle carrying browser tracing and Session Replay,
both of which this change lists as out of scope. It is inert (no `PUBLIC_SENTRY_DSN` ⇒ never
initialised) and Phase 3 §2 replaces it; it is recorded here so the size jump is not mistaken for a
finding. Source maps are §5, not a default we inherit.

#### 5. Source maps

**File**: `astro.config.mjs`

**Intent**: Keep a contributor build without Sentry credentials working, and keep hidden source-map
generation from switching on by accident.

**Contract**: `sourcemaps.disable` is set **explicitly** from whether the build environment carries
`SENTRY_AUTH_TOKEN` — absent ⇒ `disable: true`, so nothing is uploaded and no hidden maps are emitted;
present ⇒ upload enabled, with `org` and `project` from the same place. The integration's default is not
relied on.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Astro type checking passes: `npm run typecheck:astro`
- Linting passes: `npm run lint`
- Build succeeds: `npm run build`
- Unit suite passes: `npm test`
- Integration suite passes: `npm run test:integration`
- E2e suite passes against the instrumented Worker: `npm run test:e2e`
- Both Sentry packages resolve to the same v10 release, ≥ 10.54, and their types carry
  `dataCollection`: `npm ls @sentry/astro @sentry/cloudflare`
- Deploy is still valid without deploying: `npx wrangler deploy --dry-run`

#### Manual Verification:

- `npm run dev` boots and the app behaves identically with no DSN set
- Generating a summary locally still works end to end
- No Sentry network request is visible in the browser devtools Network tab
- With a scratch `SENTRY_DSN` in `.dev.vars` and the SDK's `debug` on, `npm run preview` shows
  `worker.ts` initialising with that value — proving a Worker secret reaches it at runtime, which every
  later phase assumes. The scratch value is removed immediately afterwards

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
signature, its severity rule, or any event's key or payload — and split *forwarding* from *logging*, so
the sites promoted in Phases 4–5 (which already write their own console line) can forward without
logging a second one.

**Contract**: Two exports, one transport.

- `captureEvent(key, severity, payload)` — **new, sink only**. Forwards to Sentry and writes nothing to
  the console. This is what Phases 4–5's promoted sites call, immediately after their existing
  `console.*` line, so console output stays byte-for-byte what it is today instead of doubling.
- `reportEvent(key, severity, payload)` — unchanged signature and both console branches, then calls
  `captureEvent`. The two existing families keep behaving exactly as they do.

Both carry the same never-throws / never-blocks contract; `captureEvent` is the only place the transport
lives.

**The sink is injected through one named seam**, not by mocking Sentry: the module holds a
module-scoped `sink` that defaults to the lazy runtime-split loader below, plus an exported
`setReportingSink(sink | null)` — test-only by convention, documented as such, and `null` restoring the
default. This is what `reporting.test.ts` drives, and it is also what Phases 4–5's promotion tests use to
observe forwarding without touching Sentry or `fetch`. Forwarding is done with:

- **Level mapping**: `warn` → Sentry `"warning"`; everything else → `"error"`. Same rule as the console
  branch, so the two can never disagree.
- **Message**: `key` and `severity` only. The payload goes on as structured context, never interpolated
  into the message string — a message carrying changing numbers is what splits one condition into many
  issues under default grouping.
- **`fingerprint: [key, severity]`**: one condition, one issue, regardless of the figures. This is the
  mechanism decision D3 rests on — every event is still sent, so the dashboard shows the full stream,
  but the operator's inbox gets one notification per condition (Phase 6 sets the rules).
  **The corollary binds Phases 4 and 5**: since the payload does *not* participate in the fingerprint,
  two failures an operator would act on differently must arrive under **different keys**. A shared key
  plus a payload discriminator collapses them into one issue — which is why every promoted site below
  gets its own `[family:stage]` key rather than a family key and a payload field.
- **Fire-and-forget**: never `await`ed; a synchronous throw and a rejected promise are both swallowed.
- **No `astro:env` import** — the DSN is supplied at `init` time by the two runtime entrypoints, never
  here, so this module stays reachable from the `unit` Vitest project.
- **Runtime split**: `import.meta.env.SSR` selects a **dynamic** import of a server sink module
  (wrapping `@sentry/cloudflare`) or a client sink module (wrapping `@sentry/astro`). Both arms
  dynamic — a static import on either one defeats the tree-shake and lands the Worker SDK in the client
  bundle.

#### 2. The two sink modules

**Files**: `src/lib/services/reporting-sink.server.ts`, `src/lib/services/reporting-sink.client.ts`
(both new)

**Intent**: Give each arm of the split a module of its own, so the tree-shake has something to cut and
so bundle purity has something **the app owns** to grep for. Rollup rewrites and drops package
specifiers, so `grep "@sentry/cloudflare" dist/_astro/` can come back clean from a bundle that contains
the Worker SDK — which is why the existing fake-LLM proof greps `E2E_FAKE_SUMMARIZER`, an application
sentinel, and not a package name.

**Contract**: Each module exports the same single-function sink interface (message, level, fingerprint,
context) over its own SDK, and each carries a distinct literal sentinel constant —
`SENTRY_WORKER_SINK` and `SENTRY_BROWSER_SINK` — referenced at module scope so no minifier can drop it.
Those two strings are what Phase 3's purity criterion greps, in both directions.

#### 3. Browser initialisation

**File**: `sentry.client.config.ts` (new, project root)

**Intent**: Initialise the browser SDK so the `[unsupported-feature]` family reaches the same project
(decision D1), with the same data-collection lockdown as the Worker.

**Contract**: `Sentry.init` with the DSN from the client `astro:env` value, `tracesSampleRate: 0`, replay
integrations off, and the D8 `dataCollection` object mirrored. A missing DSN must leave the SDK
uninitialised rather than throw.

#### 4. Seam tests

**File**: `src/lib/services/reporting.test.ts` (new)

**Intent**: Turn the never-throws / never-blocks contract from a comment into a checked property. This
is the contract that protects the paid path, so it is the one thing here worth testing directly.

**Contract**: Cases that must each catch a different regression — a sink that throws synchronously does
not propagate; a sink that returns a rejected promise does not produce an unhandled rejection;
`captureEvent` writes nothing to the console while `reportEvent` still writes exactly one line; a sink
that never settles does not delay `reportEvent`'s return; no initialised client is a silent no-op; the
`warn` → `warning` / other → `error` mapping; and the fingerprint is stable across differing payloads
while distinct keys stay distinct — table-driven over the promoted key set, so a future site that reuses
a sibling's key fails here rather than silently merging two issues in the dashboard. The sink is the injected seam — do not stub `fetch` or Sentry's
transport.

#### 5. Browser-seam e2e coverage

**Files**: `tests/e2e/fixtures/account.ts` (or a sibling fixture), one existing spec

**Intent**: The browser half of the no-outbound promise is currently asserted by nobody: no spec
exercises the `[unsupported-feature]` seam, and browser traffic is invisible to `fetch-firewall.ts`.
Phase 1's guard stops a DSN from reaching the build; this observes the consequence.

**Contract**: A Playwright route handler installed for every test **aborts** requests to Sentry's
ingest hosts (`*.ingest.sentry.io`, `*.sentry.io`) and counts them; a run with a non-zero count fails.
One existing spec additionally clicks the top-up button so the browser seam is actually walked rather
than merely unused — the assertion is the unchanged Polish notice plus a zero attempt count.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Unit suite passes, including the new seam tests: `npm test`
- Build succeeds: `npm run build`
- Client bundle purity, proved in both directions: `grep -rl SENTRY_WORKER_SINK dist/_astro/` returns
  nothing **and** `grep -rl SENTRY_WORKER_SINK dist/server/` finds it — an absence-only grep also
  passes when the sentinel is misspelled
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

Route the failures that mean a user may have paid for work they did not receive, or may pay twice for
work they already paid for — including the cases that carry account identifiers as the deliberate,
documented exception decision D2 granted. The Promotion Roster above is the authority on which sites
these are.

### Changes Required:

#### 1. The identifier exception

**File**: `src/lib/services/reporting.ts`

**Intent**: Amend the seam's contract rather than quietly contradicting it. `reportUnsupportedFeature`'s
doc comment currently states "No user identifiers in the payload" as a property of the seam; after this
phase that is a property of _most_ events, with one named exception.

**Contract**: A module-level doc comment stating: the seam's default is no user identifiers; the
**reconciliation family** is the exception — `[charge-ambiguous:*]`, `[credit-leak:*]` and
`[replay-read:*]`, and nothing else; the reason (each is only actionable because it names the row an
operator has to go and fix); and the retention position (identifiers are opaque UUIDs, never emails, and
are subject to the Sentry project's retention window). Any future exception must be added here, and the
Phase 4 §4 payload field-set test is what stops one being added anywhere else.

#### 2. Credit-integrity events

**File**: `src/lib/services/credits.ts`

**Intent**: Promote the events whose resolution requires an operator to reconcile a specific ledger row:
the three `REFUSAL_CHARGE_AMBIGUOUS` markers, the two `CREDIT_LEAK` sites, and the two replay-read
failures.

**Contract**: The sites at `:300`, `:315` and `:320` each additionally call `captureEvent` at severity
`error` under **its own** key in one family — `[charge-ambiguous:no-row]`,
`[charge-ambiguous:unknown-outcome]`, `[charge-ambiguous:rejected]` — because the three causes are
reconciled differently and the fingerprint is `[key, severity]`. The payload carries `userId`,
`requestId` and `refusalReason`; it describes the row, it does not do the discriminating.

`CREDIT_LEAK` (`:438`, `:447`) routes the same way, under `[credit-leak:refund-failed]` and
`[credit-leak:refund-threw]` at `error`, carrying `userId` and `reservationId` — the reservation is left
open and only that pair identifies what to close. This is the strongest money event in the file: the
message itself already tells an operator to reconcile, and until now it told only the log.

`get_refusal_replay` (`:378`, `:397`) routes under `[replay-read:rpc-error]` and `[replay-read:threw]` at
`error`, carrying `userId` and `requestId`. It is promoted because it fails **open**: both paths return
`null`, the caller reads that as "no replay exists", and a retry of an already-charged refusal can
therefore be charged a second time. A silent guard failure that costs a user money is precisely this
plan's target. Console lines stay. `REFUSAL_NOT_CHARGED` (`:291`) is deliberately **not**
promoted — it proves no debit landed, so nothing needs reconciling.

#### 3. Paid-path integrity

**File**: `src/pages/api/summaries/generate.ts`

**Intent**: Promote the swallowed failures on the generation path that can leave a charge and a delivery
out of step. `withSentry`'s automatic capture will not see these — they never throw.

**Contract**: The five sites at `:909` (`begin_generation failed`), `:922` (`summarize failed`), `:1058`
(`persist summary failed`), `:1072` (`persist summary skipped`) and `:1096` (`replayed summary could not
be read back`) each additionally call `captureEvent` at severity `error` under **its own** key in one
family: `[paid-path:begin]`, `[paid-path:summarize]`, `[paid-path:persist]`,
`[paid-path:persist-skipped]`, `[paid-path:replay-readback]`. Five stages an operator would act on
differently are five issues; the payload carries the failing detail, never the discrimination. Console lines
stay. No user identifiers beyond what decision D2 granted — these carry the failing stage, not the
account.

#### 4. Promotion tests

**Files**: `src/lib/services/credits.test.ts` (existing),
`src/pages/api/summaries/generate.int.test.ts` (existing)

**Intent**: Make the promotion itself falsifiable. The existing suites assert business outcomes and
silence console output, so today every `captureEvent` call in this phase could be deleted and every
automated criterion would still pass — the deliverable would have no test at all.

**Contract**: Install a recording sink via `setReportingSink` and drive each promoted branch through the
failure seams those suites already have (`stubFailing` / `stubRejecting` for credits; the stubbed vendor
`fetch` and mocked client constructors for generate). One parameterized case per promoted site,
asserting three things and no more: the **key**, the **severity**, and the **payload field set**. The
last one is the automated form of this phase's identifier rule — the reconciliation family carries exactly
the identifiers §1–§2 grant it (`[charge-ambiguous:*]` → `userId`, `requestId`, `refusalReason`;
`[credit-leak:*]` → `userId`, `reservationId`; `[replay-read:*]` → `userId`, `requestId`), `[paid-path:*]`
carries none, and an email address may never appear anywhere. Do not assert console copy and do not reach
into Sentry.

_Amended 2026-09-10 (Phase 4 implementation):_ this paragraph previously granted identifiers to
`[charge-ambiguous:*]` alone, contradicting §1's three-family exception and §2's field lists; §1–§2 were
the intended rule and are what the tests enforce.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Unit suite passes, including the credits promotion cases: `npm test`
- Integration suite passes, including the ambiguous-charge scenarios and their promoted events:
  `npm run test:integration`
- Deleting any single promoted `captureEvent` call turns a test red — verified once, by hand, on one
  site per family
- Build succeeds: `npm run build`

#### Manual Verification:

- The amended seam contract reads as a granted exception, not as a contradiction of the old comment

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
`src/lib/services/transcript-guard.ts`, `src/pages/api/summaries/generate.ts`

**Intent**: Report read/write failures against the caches that stand between the app and a paid vendor
call, so a regression that silently disables caching is visible before the vendor bill is.

**Contract**: Each existing `console.error` site (`transcript-cache.ts:117,138,215,222`,
`metadata-cache.ts:75,94,131,135`, `transcript-guard.ts:92,110,154,158,187,191`, plus
`generate.ts:681` — `recordTranscriptAttempt failed`, under `[transcript-guard:record-threw]`, which
belongs to this family even though it lives in the endpoint) additionally calls
`captureEvent` at severity `error` under a `[<module>:<operation>]` key — so a failing cache *read* and a
failing cache *write* are separate issues rather than one — with the error message in the payload. **No user identifiers** — the D2 exception is
narrow and does not extend here. Console lines stay.

#### 2. Ledger and lock failures

**Files**: `src/lib/services/supadata-ledger.ts`, `src/lib/services/generation-lock.ts`,
`src/lib/services/supadata-budget.ts`, `src/pages/api/summaries/generate.ts`

**Intent**: Report the bookkeeping failures that make the budget guard's own numbers untrustworthy — a
lost ledger flush or an unsettled reservation degrades the very data `reportBudgetThreshold` reasons
about.

**Contract**: Each site additionally calls `captureEvent` (never `reportEvent` — the console line is
already there). `supadata-ledger.ts:180,184`, `generation-lock.ts:62,72` and the settle failures at
`supadata-budget.ts:586,596,600` and `generate.ts:194` (`acquireGenerationLease failed`, under
`[generation-lock:acquire-threw]`) route at severity `error`; `generation-lock.ts:68` (a lease already
swept as stale — expected under load) routes at `warn`. Same key rule as §1: `[<module>:<operation>]`,
one key per condition an operator would act on separately. Reservation ids are operational identifiers, not
account identifiers, and may travel. Console lines stay.

#### 3. Promotion tests

**Files**: the existing colocated unit tests for the six touched modules

**Intent**: Same falsifiability as Phase 4 §4, on a family whose failures are by definition invisible
— a degradation event nobody asserts is a degradation event nobody will notice missing.

**Contract**: A recording sink via `setReportingSink`, then one parameterized row per promoted site over
the failure seams those tests already use, asserting **key**, **severity** (including
`generation-lock.ts:68`'s `warn`, which is the row that proves the severity argument is real rather than
a constant) and **payload field set** — no `userId` anywhere in this family. Reservation ids are
operational and allowed.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run typecheck`
- Linting passes: `npm run lint`
- Unit suite passes, including the degradation promotion cases: `npm test`
- No degradation payload carries a `userId` — asserted by the payload field-set cases, not by eye
- Integration suite passes: `npm run test:integration`
- Build succeeds: `npm run build`

#### Manual Verification:

- Each promoted condition fingerprints separately (distinct keys), so one failing operation does not mask
  another

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

#### 4. The two live smoke cases

**Intent**: The Worker and the browser now initialise from different values delivered by different
mechanisms (a Worker secret read at runtime; a repository secret inlined at build time). A single event
therefore proves at most half the end state — and the half it does not prove is the half that fails
silently.

**Contract**: Two events, recorded separately.

- **Browser** — no new code: sign in on production and click the top-up button. That walks the existing
  `[unsupported-feature]` seam, which is exactly what the client transport is for.
- **Worker** — a deliberate, explicitly temporary trigger: one `captureEvent("[smoke:worker]", "warn",
  …)` guarded behind an exact query flag on the authenticated `GET /api/summaries` handler, so only a
  signed-in operator who knows the flag can fire it and no user path can. It is deployed, fired once,
  and **removed in the immediately following commit**; the record carries both the firing and the
  revert sha, and the removal is re-verified against production after the revert deploys.

A natural Worker event (a budget near-miss) is not a substitute: it cannot be summoned on demand, so a
missing one is indistinguishable from a broken transport.

#### 5. Live verification record

**File**: `context/changes/error-monitoring/reviews/manual-verification.md` (new)

**Intent**: The account wiring — right DSN, right project, grouping, alert rule — is only provable live,
so the record is what gives that pass lasting value.

**Contract**: Records **both** smoke events — event id, issue, notification outcome, and for the Worker
case the revert sha and the post-revert re-check — and and the negative checks — each of which is an observation rather than an absence
of noticing:

- **Integration**: the suite passes, and `fetch-firewall.ts` throws on any non-loopback `fetch`, so an
  escaping event is a failing test by construction.
- **Browser**: the e2e route handler from Phase 3 §5 counts zero aborted Sentry requests across a run
  that walked the top-up seam.
- **Worker**: the e2e `webServer` boot log (Playwright pipes it) shows `worker.ts` declining to
  initialise for want of a DSN, and `grep -r "ingest.*sentry.io" dist/` — which covers
  both the inlined client value and the `.dev.vars` wrangler bakes into `dist/server/` — returns
  nothing.
- **Local dev**: `npm run dev` with no DSN set, same two observations by hand.
**No account identifiers**: describe the role ("the operator's account"), never an email or UUID — the
repo is public, and this is a real-environment pass.

#### 6. Documentation

**Files**: `README.md`, `CLAUDE.md`, `AGENTS.md`

**Intent**: Leave the environment story and the alert set discoverable, and record that the DSN's absence
outside production is a decision.

**Contract**: `README.md` gains an "Error monitoring" section covering the two DSNs and their two
delivery mechanisms, why neither is set locally (and that the e2e runner refuses to start if one is),
what is alerted on, what is deliberately not monitored (§Promotion Roster's excluded column in one
sentence), and the rollback — unset the Worker secret. The Phase 1 corrections to the env table,
Worker-secret list and repository-secret table are assumed already landed; this section is the narrative
half.

`CLAUDE.md` and `AGENTS.md` each gain the **same short paragraph** on the seam's new role, the
`captureEvent` / `reportEvent` split, and the client/server bundle constraint. The requirement is that
**that paragraph** stays identical between them — not the whole file: the two already diverge
deliberately below the shared body (different headers, different 10xDevs lesson blocks), and demanding
byte identity would mean overwriting one tool's guidance with the other's. Both files are gitignored, so
neither edit reaches the repository: `README.md` is the only committed home for this, which is why its
section carries the full story.

#### 7. Tracker sync

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

- The browser smoke event (a top-up click in production) arrives in Sentry under its own fingerprinted
  issue
- The Worker smoke event arrives under its own fingerprinted issue, and its temporary trigger is gone
  from production afterwards — re-checked, not assumed
- The alert rule delivers exactly one notification per issue, not one per event
- Each of the four negative checks above is recorded with its observed result, not asserted from
  absence of noticing
- The verification record contains no account identifiers
- The roadmap and Linear reflect the closed slice

---

## Testing Strategy

### Unit Tests:

- The seam's never-throws / never-blocks contract (`reporting.test.ts`, Phase 3): synchronous throw,
  rejected promise, never-settling sink, no client initialised.
- Level mapping (`warn` → `warning`, everything else → `error`); fingerprint stability across differing
  payloads, and fingerprint *distinctness* across the promoted key set (table-driven).
- Existing suites for the promoted modules must stay green — promotion adds a call, it does not change
  any outcome.
- **Promotion assertions** (Phases 4–5): a recording sink installed through `setReportingSink`, driven
  by each module's existing failure seams, one parameterized row per promoted site asserting key,
  severity and payload field set. Without these the promotion has no oracle: the suites would pass just
  as green with every `captureEvent` call deleted.

### Integration Tests:

- The existing ambiguous-charge scenarios in `generate.int.test.ts` continue to pass with the promoted
  reporting call in place, and additionally assert the event it forwards (key, severity, payload field
  set) through the recording sink.
- No new integration test is added for outbound suppression: `fetch-firewall.ts` already throws on every
  non-loopback fetch in that project, so an escaping event fails the suite by construction.

### Manual Testing Steps:

1. With no DSN set, run `npm run dev`, generate a summary, and confirm the console output is unchanged
   and no request reaches Sentry.
2. Click the top-up button and confirm the `[unsupported-feature]` line still appears in the browser
   console with no network request.
3. Deploy with the Worker secret set; fire **both** smoke cases (browser top-up click, and the temporary
   Worker trigger); confirm each arrives, groups under its own issue, and produces exactly one
   notification. Then revert the Worker trigger, redeploy, and confirm it no longer fires.
4. Re-run the e2e suite after deploying and confirm no events appear for it.

## Performance Considerations

`tracesSampleRate: 0` — no performance tracing, so no span overhead on the Worker. The reporting call is
fire-and-forget and never awaited, so it adds no latency to the generation path; the dynamic import
resolves once per isolate and is cached thereafter. The browser SDK adds bundle weight to hydrated
islands, kept minimal by omitting the replay and tracing integrations.

## Migration Notes

No database changes, no data migration, and no `wrangler.jsonc` edit — the integration wraps the Worker
entry at build time, so there is no entrypoint change to revert. Backing the whole thing out is removing
`sentry()` from `astro.config.mjs` and deleting the two config files.

Rollback at any point after Phase 6 is unsetting the Worker secret — the SDK disables itself with an
undefined DSN, and the app returns to console-only reporting with no code change.

## References

- Roadmap slice: `context/foundation/roadmap.md` §S-13 (and §S-09 decisions D5 / D5b, which built this
  seam and deferred its receiver)
- The seam: `src/lib/services/reporting.ts`, `src/lib/services/supadata-budget.ts:195-250`
- The promotion inventory: §Promotion Roster above — the authority on which console sites are promoted
  and which are deliberately left alone
- Environment-isolation precedent: `astro.config.mjs:15-45`, `.dev.vars.e2e`, `src/test/fetch-firewall.ts`
- Sentry MCP: `context/changes/error-monitoring/docs/sentry-mcp.md`
- Linear: MAR-24

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `.claude/skills/10x-plan/references/progress-format.md`.

### Phase 1: Sentry project, env plumbing, and the MCP

#### Automated

- [x] 1.1 Type checking passes: `npm run typecheck` — 687b0bf
- [x] 1.2 Astro type checking passes: `npm run typecheck:astro` — 687b0bf
- [x] 1.3 Linting passes: `npm run lint` — 687b0bf
- [x] 1.4 Build succeeds with no DSN set: `npm run build` — 687b0bf
- [x] 1.5 No DSN is inlined anywhere in the output: `grep -r "ingest.*sentry.io" dist/` returns nothing — 687b0bf
- [x] 1.6 The e2e runner refuses to start with a DSN present: `PUBLIC_SENTRY_DSN=x npm run test:e2e` exits non-zero before the build, and the same holds for `SENTRY_DSN` — 687b0bf

#### Manual

- [x] 1.7 Sentry project exists; org slug, project slug and DSN recorded (not committed) — 687b0bf
- [x] 1.8 A spend cap or client-key rate limit is set on the project — 687b0bf
- [x] 1.9 The Sentry MCP is connected at user scope and `/mcp` lists its tools — 687b0bf
- [x] 1.10 `.dev.vars.e2e` still contains no DSN, and its new comment says so explicitly — 687b0bf

### Phase 2: Server transport — instrument the Worker

#### Automated

- [x] 2.1 Type checking passes: `npm run typecheck` — 8d778e2
- [x] 2.2 Astro type checking passes: `npm run typecheck:astro` — 8d778e2
- [x] 2.3 Linting passes: `npm run lint` — 8d778e2
- [x] 2.4 Build succeeds: `npm run build` — 8d778e2
- [x] 2.5 Unit suite passes: `npm test` — 8d778e2
- [x] 2.6 Integration suite passes: `npm run test:integration` — 8d778e2
- [x] 2.7 E2e suite passes against the instrumented Worker: `npm run test:e2e` — 8d778e2
- [x] 2.8 Both Sentry packages resolve to the same v10 release, ≥ 10.54, and their types carry `dataCollection`: `npm ls @sentry/astro @sentry/cloudflare` — 8d778e2
- [x] 2.9 Deploy is still valid without deploying: `npx wrangler deploy --dry-run` — 8d778e2

#### Manual

- [x] 2.10 `npm run dev` boots and the app behaves identically with no DSN set — 8d778e2
- [x] 2.11 Generating a summary locally still works end to end — 8d778e2
- [x] 2.12 No Sentry network request is visible in the browser devtools Network tab — 8d778e2
- [x] 2.13 With a scratch `SENTRY_DSN` in `.dev.vars` and the SDK's `debug` on, `npm run preview` shows `worker.ts` initialising with that value — proving a Worker secret reaches it at runtime, which every later phase assumes. The scratch value is removed immediately afterwards — 8d778e2

### Phase 3: Route the seam through Sentry

#### Automated

- [x] 3.1 Type checking passes: `npm run typecheck` — b46fbd7
- [x] 3.2 Linting passes: `npm run lint` — b46fbd7
- [x] 3.3 Unit suite passes, including the new seam tests: `npm test` — b46fbd7
- [x] 3.4 Build succeeds: `npm run build` — b46fbd7
- [x] 3.5 Client bundle purity, proved in both directions: `grep -rl SENTRY_WORKER_SINK dist/_astro/` returns nothing **and** `grep -rl SENTRY_WORKER_SINK dist/server/` finds it — an absence-only grep also passes when the sentinel is misspelled — b46fbd7
- [x] 3.6 Integration suite passes: `npm run test:integration` — b46fbd7
- [x] 3.7 E2e suite passes: `npm run test:e2e` — b46fbd7

#### Manual

- [x] 3.8 With no DSN set, clicking the top-up button still logs to the browser console and issues no network request — b46fbd7
- [x] 3.9 With no DSN set, a local generation still logs `[supadata-budget]` lines to the Worker console — b46fbd7

### Phase 4: Promote the money events

#### Automated

- [x] 4.1 Type checking passes: `npm run typecheck` — f2e9800
- [x] 4.2 Linting passes: `npm run lint` — f2e9800
- [x] 4.3 Unit suite passes, including the credits promotion cases: `npm test` — f2e9800
- [x] 4.4 Integration suite passes, including the ambiguous-charge scenarios and their promoted events: `npm run test:integration` — f2e9800
- [x] 4.5 Deleting any single promoted `captureEvent` call turns a test red — verified once, by hand, on one site per family — f2e9800
- [x] 4.6 Build succeeds: `npm run build` — f2e9800

#### Manual

- [x] 4.7 The amended seam contract reads as a granted exception, not as a contradiction of the old comment — f2e9800

### Phase 5: Promote the degradation events

#### Automated

- [ ] 5.1 Type checking passes: `npm run typecheck`
- [ ] 5.2 Linting passes: `npm run lint`
- [ ] 5.3 Unit suite passes, including the degradation promotion cases: `npm test`
- [ ] 5.4 No degradation payload carries a `userId` — asserted by the payload field-set cases, not by eye
- [ ] 5.5 Integration suite passes: `npm run test:integration`
- [ ] 5.6 Build succeeds: `npm run build`

#### Manual

- [ ] 5.7 Each promoted condition fingerprints separately (distinct keys), so one failing operation does not mask another

### Phase 6: Turn it on — calibration, live verification, and docs

#### Automated

- [ ] 6.1 All three CI jobs pass on the PR: `ci`, `integration`, `e2e`
- [ ] 6.2 Build succeeds locally without either DSN: `npm run build`
- [ ] 6.3 No DSN in a non-deploy build's output: `grep -r "ingest.*sentry.io" dist/` returns nothing

#### Manual

- [ ] 6.4 The browser smoke event (a top-up click in production) arrives in Sentry under its own fingerprinted issue
- [ ] 6.5 The Worker smoke event arrives under its own fingerprinted issue, and its temporary trigger is gone from production afterwards — re-checked, not assumed
- [ ] 6.6 The alert rule delivers exactly one notification per issue, not one per event
- [ ] 6.7 Each of the four negative checks above is recorded with its observed result, not asserted from absence of noticing
- [ ] 6.8 The verification record contains no account identifiers
- [ ] 6.9 The roadmap and Linear reflect the closed slice
