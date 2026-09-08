import process from "node:process";
import { defineConfig, devices } from "@playwright/test";

/**
 * The e2e runner (test-plan Phase 4). This is the first test layer where the test and the code do NOT
 * share a process, which is what makes it different from the two Vitest projects rather than merely
 * slower: none of `test-plan.md` §6.2's faking techniques reach across the process boundary.
 *
 * Both paid vendor checkpoints are therefore defeated inside the app instead:
 *   - Supadata (transcript + metadata) falls to DATA — specs pre-seed the caches through the same RPCs
 *     `generate.ts` itself calls, so both lookups hit and no fetch is attempted.
 *   - OpenRouter falls to CODE — `E2E_FAKE_LLM` (set on `webServer` below) turns on the config-load
 *     alias in `astro.config.mjs` that swaps `@/lib/services/llm` for `src/test/e2e/fake-llm.ts`.
 *
 * No run of this suite may spend real vendor credit (CLAUDE.md §Testing).
 */
const isCI = !!process.env.CI;

const APP_URL = "http://localhost:4321";

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
   * Double Playwright's 30s default. Locally the app server is `astro dev`, which compiles routes on
   * first request — the first spec's page load pays a one-off ~20s of Vite work that has nothing to do
   * with the flow under test, and a 30s budget leaves almost nothing for the flow itself.
   */
  timeout: 60_000,

  /**
   * 15s per web-first assertion, up from Playwright's 5s. The generation round-trip is genuinely slow
   * the first time it runs under `astro dev`, which compiles `/api/summaries/generate` and its
   * dependency graph on first request; 5s expires while the pending card is still, correctly, showing
   * a spinner. This raises the CEILING on a wait for state — it is not a wait for time, and nothing
   * here ever sleeps.
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
     * `dev` locally for the fast loop, a BUILT `preview` in CI for production fidelity — the alias is
     * applied when `astro.config.mjs` is loaded, so a single mechanism covers both. The build must run
     * with `E2E_FAKE_LLM` too: in CI it is the build, not the server, that bakes the fake in.
     */
    command: isCI ? "npm run build && npm run preview" : "npm run dev",
    env: { E2E_FAKE_LLM: "1" },
    url: `${APP_URL}/`,
    /**
     * The codified form of `lessons.md`'s dev-server rule ("Check for an already-running dev server
     * before starting a new one"), learned by losing time to a stale process on :4321 that kept serving
     * an old `middleware.ts`. Locally, reuse whatever is already listening; in CI always start clean,
     * where nothing else can be running and a reused server would mean a stale build.
     *
     * NOTE the one hazard reuse carries: a dev server started WITHOUT `E2E_FAKE_LLM` is reused as-is,
     * `env` above does not reach it, and the suite would then call OpenRouter for real. Start the local
     * server via this config (or with the flag set) — never a bare `npm run dev` in another terminal.
     */
    reuseExistingServer: !isCI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
