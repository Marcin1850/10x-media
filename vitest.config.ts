import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Plain Vite config, NOT Astro's `getViteConfig()` — this is the fallback the plan records, and it
 * was needed. `getViteConfig()` loads the whole `astro.config.mjs`, including `@astrojs/cloudflare`,
 * whose Vite plugin refuses the environment Vitest sets up:
 *
 *   Error: The following environment options are incompatible with the Cloudflare Vite plugin:
 *     - "ssr" environment: `resolve.external`: [...node builtins...]
 *
 * That is the adapter-failure trigger, so the fallback applies. It is legitimate at this stage
 * because no unit target imports `astro:env`, a `.astro` file, or `@supadata/js` — the three things
 * the full Astro config exists to make resolvable. It also loads faster, which keeps the suite
 * habitually runnable. Revisit in rollout Phase 4, when Astro components are rendered and
 * `getViteConfig()` (or an environment split) becomes non-negotiable.
 *
 * The `@/*` alias is therefore declared here and is load-bearing: `astro.config.mjs` never declares
 * it either, because Astro reads it from `tsconfig.json` during its own build. Vite alone does not,
 * so without this every test importing `@/lib/...` fails at import time with a resolution error
 * rather than an assertion failure.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // The stack decision (test-plan §4): Node, not jsdom — nothing in the unit layer touches a DOM.
    environment: "node",
    // Tests are colocated next to the module they cover; `tsconfig` and ESLint already cover `src/**`.
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // No thresholds by design. The report is visibility into what the next rollout phase still
      // needs to cover — a percentage is not a target here (test-plan §6).
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
