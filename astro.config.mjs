// @ts-check
import { fileURLToPath } from "node:url";
import { defineConfig, envField } from "astro/config";

import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: {
        // `@supadata/js` depends on `cross-fetch` (CommonJS), which the workerd dev module runner
        // can't evaluate (`exports is not defined`). workerd provides a global `fetch`, so alias it
        // to a native-fetch ESM shim — behaviour-preserving in dev and prod. See the shim for why.
        "cross-fetch": fileURLToPath(new URL("./src/lib/shims/cross-fetch.mjs", import.meta.url)),
      },
    },
    ssr: {
      // Exclude `@supadata/js` from the dev dep-optimizer (it's incompatible — the optimizer can't
      // pre-bundle it for the workerd env) so Vite serves its source and the `cross-fetch` alias
      // above resolves inside it.
      optimizeDeps: {
        exclude: ["@supadata/js"],
      },
    },
  },
  adapter: cloudflare(),
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: "server", access: "secret", optional: true }),
      SUPABASE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      SUPADATA_API_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      OPENROUTER_API_KEY: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
