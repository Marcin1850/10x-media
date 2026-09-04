import { fileURLToPath } from "node:url";
import process from "node:process";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * `AI_AGENT=1` switches the reporter to `dot`: one character per test, with detail printed only
 * for failures. A passing run then costs a few lines of an agent's context instead of a screen of
 * per-file output, while a failing run still carries everything needed to act on it. Humans get
 * the `default` reporter unchanged — the flag is opt-in and set by the caller, never by the config.
 */
const terseReporter = process.env.AI_AGENT === "1";

/**
 * Plain Vite config, NOT Astro's `getViteConfig()` — this is the fallback the plan records, and it
 * was needed. `getViteConfig()` loads the whole `astro.config.mjs`, including `@astrojs/cloudflare`,
 * whose Vite plugin refuses the environment Vitest sets up:
 *
 *   Error: The following environment options are incompatible with the Cloudflare Vite plugin:
 *     - "ssr" environment: `resolve.external`: [...node builtins...]
 *
 * That is the adapter-failure trigger, so the fallback applies. `getViteConfig()` is still not
 * needed even now that the integration project imports `astro:env/server` and a `.astro`-adjacent
 * endpoint — research.md §2.2 found the alias below resolves the virtual module cleanly under a
 * plain `vitest/config`, with no adapter involvement, because the adapter only enters through
 * `astro.config.mjs`, which a plain Vite config never loads.
 *
 * The `@/*` alias is therefore declared here and is load-bearing: `astro.config.mjs` never declares
 * it either, because Astro reads it from `tsconfig.json` during its own build. Vite alone does not,
 * so without this every test importing `@/lib/...` fails at import time with a resolution error
 * rather than an assertion failure. The `astro:env/server` alias is declared alongside it for the
 * same reason: test-plan §6.6 records that a diverging alias between projects fails at import time
 * with an error that reads nothing like an assertion failure, so it is declared once at the root
 * and inherited by both projects via `extends: true` rather than repeated per project.
 */
const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
  "astro:env/server": fileURLToPath(new URL("./src/test/astro-env-server-stub.ts", import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    // The stack decision (test-plan §4): Node, not jsdom — nothing in either project touches a DOM.
    environment: "node",
    reporters: terseReporter ? ["dot"] : ["default"],
    coverage: {
      provider: "v8",
      // No thresholds by design. The report is visibility into what the next rollout phase still
      // needs to cover — a percentage is not a target here (test-plan §6).
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
    /**
     * Two projects, one meaning boundary. `npm test` (`vitest run`) runs both by default, but the
     * CI `ci` job and the `test` script both mean "unit only" today — `test:integration` is the new,
     * separate entry point (`package.json`), invoked with `--project integration` so the two never
     * run together implicitly. `globalSetup` is deliberately set only on the integration project:
     * Vitest does not inherit it even under `extends: true`, which is exactly right here — the unit
     * project must never pay for, or be blocked by, the loopback/stale-fixture guard.
     */
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Tests are colocated next to the module they cover; tsconfig/ESLint already cover `src/**`.
          include: ["src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "src/**/*.int.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          globalSetup: ["./src/test/integration-setup.ts"],
          // Per-test-file (unlike globalSetup, which runs once, outside `vi`) — installs the fetch
          // firewall and forces placeholder vendor keys before every integration test (F1, impl-review.md).
          setupFiles: ["./src/test/fetch-firewall.ts"],
        },
      },
    ],
  },
});
