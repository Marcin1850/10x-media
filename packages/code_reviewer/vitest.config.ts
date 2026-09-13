import { defineConfig } from "vitest/config";

// Without a config of its own, Vitest walks up and loads the Astro app's root `vitest.config.ts`
// (its projects, aliases and setup files). This file keeps the package self-contained.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
