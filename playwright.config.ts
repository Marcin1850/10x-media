import process from "node:process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { assertLoopbackSupabaseUrl } from "@/test/loopback-guard";

/**
 * The e2e runner (test-plan Phase 4). This is the first test layer where the test and the code do NOT
 * share a process, which is what makes it different from the two Vitest projects rather than merely
 * slower: none of `test-plan.md` §6.2's faking techniques reach across the process boundary.
 *
 * Both paid vendor checkpoints are therefore defeated inside the app instead:
 *   - Supadata (transcript + metadata) falls to DATA — specs pre-seed the caches through the same RPCs
 *     `generate.ts` itself calls, so both lookups hit and no fetch is attempted. Because that defence
 *     depends on the specs being CORRECT, a second one sits behind it: `CLOUDFLARE_ENV=e2e` (see
 *     `webServer` below) gives the app `.dev.vars.e2e`, whose Supadata key is not a credential — so a
 *     seeding bug that misses the cache gets a vendor 401 rather than a bill.
 *   - OpenRouter falls to CODE — `E2E_FAKE_LLM` (set on `webServer` below) turns on the config-load
 *     alias in `astro.config.mjs` that swaps `@/lib/services/llm` for `src/test/e2e/fake-llm.ts`.
 *
 * No run of this suite may spend real vendor credit (CLAUDE.md §Testing).
 */
const isCI = !!process.env.CI;

const APP_URL = "http://localhost:4321";

/**
 * Both guards run HERE, while Playwright loads this file — not in `globalSetup`, which is too late.
 * Playwright starts `webServer` and polls `url` BEFORE `globalSetup` runs, so by the time the old
 * placement executed, the app had already served a request with whatever configuration it happened to
 * have (impl-review F1).
 *
 * 1. **Loopback.** Specs create and delete `auth.users` rows; a copied-in production URL would do that
 *    for real. `globalSetup` asserts it a second time — that redundancy is deliberate and free.
 * 2. **The e2e secrets file.** `CLOUDFLARE_ENV=e2e` (below) makes wrangler prefer `.dev.vars.e2e`, but
 *    its fallback to `.dev.vars` is SILENT: delete the file and the run quietly regains the
 *    developer's real, billable vendor keys. This turns that fallback into a refusal to start.
 */
assertLoopbackSupabaseUrl(process.env.SUPABASE_URL);

const E2E_DEV_VARS = fileURLToPath(new URL("./.dev.vars.e2e", import.meta.url));
if (!existsSync(E2E_DEV_VARS)) {
  throw new Error(
    "`.dev.vars.e2e` is missing. It supplies the e2e run's non-billable vendor keys, and wrangler " +
      "falls back to `.dev.vars` — your REAL keys — without saying so when it is absent. The file is " +
      "committed and contains no secrets; restore it (`git checkout .dev.vars.e2e`) before running.",
  );
}

export default defineConfig({
  testDir: "tests/e2e",

  /**
   * `*.spec.ts`, NEVER `*.test.ts`. `vitest.config.ts`'s `unit` project collects every `.test.ts` file
   * under `src/`, and while `tests/` sits outside that glob today, the naming is the durable guard: a
   * spec that drifted into `src/` under a `.test.ts` name would be collected by Vitest and fail there
   * for reasons that read nothing like a Playwright problem.
   */
  testMatch: "**/*.spec.ts",

  /**
   * Serial, single worker. Every spec drives the real generation endpoint, which contends on the
   * singleton vendor-budget row and on per-user generation locks; parallel specs would collide there
   * and produce failures that look like product bugs. Accounts are per-test and disposable, so the
   * isolation that matters is already there — this only removes the shared-row contention.
   */
  fullyParallel: false,
  workers: 1,

  /**
   * No retries, deliberately. Each spec's oracle is a ledger DELTA (balance before vs after, plus the
   * reservation row), so a retry that passes on the second attempt would be hiding exactly the class of
   * nondeterminism this layer exists to catch. Phases 2-4 prove stability with `--repeat-each=2`
   * instead, which fails loudly rather than silently absorbing a flake.
   */
  retries: 0,

  forbidOnly: isCI,

  /**
   * Double Playwright's 30s default. This is now HEADROOM, not a compile budget: since impl-review F2
   * the server is a built `preview` in both environments, so no spec pays for on-demand route
   * compilation any more (that cost moved into `webServer`, in front of the whole run). What remains is
   * a real generation round-trip through workerd plus a first-hit isolate spin-up, and 60s keeps a slow
   * machine from turning either into a false failure.
   */
  timeout: 60_000,

  /**
   * 15s per web-first assertion, up from Playwright's 5s. The generation round-trip crosses a process
   * boundary and does real database work, and 5s expires while the pending card is still, correctly,
   * showing a spinner. This raises the CEILING on a wait for state — it is not a wait for time, and
   * nothing here ever sleeps.
   */
  expect: { timeout: 15_000 },

  reporter: isCI ? [["list"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
  },

  /**
   * Refuses to run against a non-loopback Supabase, and aborts on rows left by a hard-killed prior run.
   * Landed by Phase 2 — until then `npm run test:e2e` has no specs to run and no setup file to load.
   */
  globalSetup: "./tests/e2e/fixtures/global-setup.ts",

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      /**
       * No `setup` project and no `storageState`. The obvious Playwright pattern — sign in once, share
       * the session file — does not fit here: the thing the specs vary is the credit BALANCE, and the
       * balance is state the specs themselves spend. A shared account stops being deterministic the
       * moment a second spec (or a second `--repeat-each` iteration) debits it. Auth is injected
       * per-test instead by `tests/e2e/fixtures/account.ts` (Phase 2): `createSyntheticAccount` signs in
       * from the Node process against the local stack and the cookies go to the browser context via
       * `addCookies`, so the sign-in FORM is still never driven — the rule that mattered is kept.
       * Decision: user, 2026-09-08.
       */
    },
    /**
     * No Firefox project. `prd.md:72-73` names Chrome and Firefox as supported browsers, so this is a
     * known, deliberate gap rather than an oversight: none of the three flows carries an
     * engine-specific risk (no layout assertion, no CSS-dependent behaviour, no engine-specific API),
     * and every one of them costs a real generation round-trip to run twice. Add a project here the
     * day a flow acquires such a risk.
     */
  ],

  webServer: {
    /**
     * A BUILT `preview` in BOTH environments. `astro dev` was the local default until impl-review F2,
     * and it failed on two counts that are really the same count — the dev server is not the server the
     * gate runs against:
     *
     *  - **Determinism.** A cold run's first generation raced Vite's dependency optimizer: mid-request
     *    it discovered `astro/env/runtime`, `zod` and `@supabase/supabase-js`, reloaded the program, and
     *    the saved card never arrived. The retry passed in 7.6s. `preview` serves a finished bundle, so
     *    there is no optimizer and nothing to reload.
     *  - **The vendor keys.** `.dev.vars.e2e` only reaches the app here. Under `astro dev`,
     *    @astrojs/cloudflare re-reads the fixed-name `.dev.vars` into `process.env` and `astro:env`
     *    resolves from there, so the developer's REAL keys win; under `preview`, wrangler bakes
     *    `.dev.vars.e2e` into `dist/server/.dev.vars` and the placeholders are what the Worker sees.
     *    Measured both ways with a throwaway probe route, not assumed.
     *
     * The cost is a build (~30s) in front of every run instead of ~8s of dev startup — paid once per
     * `npm run test:e2e`, not per spec. The `E2E_FAKE_LLM` alias is applied when `astro.config.mjs` is
     * loaded, so the one mechanism still covers build and server alike; the BUILD is what bakes the
     * fake in, which is why the flag has to be on `env` below rather than on the server alone.
     */
    command: "npm run build && npm run preview",
    /**
     * `E2E_FAKE_LLM` switches on the config-load module alias (`astro.config.mjs`) that replaces
     * OpenRouter with the fake summarizer.
     *
     * `CLOUDFLARE_ENV` is the Supadata half, and it has to be an ENV NAME rather than a pair of key
     * overrides: @astrojs/cloudflare re-reads `.dev.vars` at `astro:config:done` and wrangler builds
     * the workerd bindings from its own read of it, so vendor keys passed through this object are
     * overwritten by the developer's real ones before the app ever sees them — measured, not assumed.
     * Naming an environment instead makes wrangler load `.dev.vars.e2e`, whose vendor values are
     * deliberate non-credentials. There is intentionally NO `env.e2e` section in `wrangler.jsonc`:
     * absent, wrangler warns once and keeps the top-level config, so the bindings (ASSETS, KV, Images)
     * stay identical to a normal run; adding one would silently drop every non-inheritable binding.
     */
    env: { E2E_FAKE_LLM: "1", CLOUDFLARE_ENV: "e2e" },
    url: `${APP_URL}/`,
    /**
     * NEVER reuse, in either environment. Reuse was the concrete path by which this suite could spend
     * real money (impl-review F1): a server already listening on :4321 is accepted as-is, `env` above
     * never reaches it, and a bare `npm run dev` in another terminal has neither the fake-LLM alias nor
     * the e2e secrets file — so the first spec calls OpenRouter for real. Owning the process is what
     * makes the two `env` guarantees above true of the server actually under test.
     *
     * This does not contradict `lessons.md`'s dev-server rule ("check for an already-running dev server
     * before starting a new one") — it enforces it. Playwright refuses to start when :4321 is occupied,
     * so a stale process is now a loud startup error instead of a silently reused, wrongly configured
     * app. Stop your own dev server before running the suite.
     */
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
