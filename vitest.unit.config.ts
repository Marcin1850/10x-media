import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Stryker-only entry point (`stryker.config.json`'s `vitest.configFile`). `@stryker-mutator/vitest-runner`
 * has no option to pass `--project` through to Vitest — its schema exposes only `dir`, `related`,
 * `configFile` — and it always runs every project a config defines
 * (`vitest-test-runner.ts`: `this.ctx.projects.forEach(...)`). Pointing Stryker at `vitest.config.ts`
 * would therefore also spin up the `integration` project, including its `globalSetup`, which aborts
 * without a live local Supabase stack reachable at a loopback `SUPABASE_URL`.
 *
 * This file re-declares the `unit` project's settings standalone, with no `projects` array, so
 * mutation testing never touches the integration layer. Keep it in sync with the `unit` project
 * block in `vitest.config.ts` — Stryker has no mechanism to share that block directly.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "src/**/*.int.test.ts"],
  },
});
