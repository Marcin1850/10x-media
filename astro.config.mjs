// @ts-check
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig, envField, fontProviders } from "astro/config";

import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";
import sentry from "@sentry/astro";

/**
 * The e2e LLM seam. OpenRouter is the one paid checkpoint no test can defeat with data: the transcript
 * and metadata lookups sit behind caches a spec pre-seeds, but `generate.ts` calls `summarize()`
 * unconditionally, and both `astro dev` and `astro preview` run on workerd — so nothing at the Node
 * level (`nock`, `http` patching) can intercept it. The swap therefore has to happen in the module
 * graph.
 *
 * SAFETY PROPERTY: a Worker built without `E2E_FAKE_LLM` cannot contain the fake, because this plugin
 * does not exist and the module is never bundled. `deploy`'s own `npm run build` sets only
 * SUPABASE_URL/SUPABASE_KEY, so the flag is off there by construction. A RUNTIME flag was rejected: it
 * would serve canned summaries while charging real credits if it were ever set in production — see
 * `e0fdb0d`, which reverted a test-convenience `service_role` widening that had already shipped. The
 * proof is the build output, not this comment: grep `dist/` for `E2E_FAKE_SUMMARIZER` (plan Phase 1,
 * 1.4/1.5).
 *
 * WHY A PLUGIN AND NOT A PLAIN `vite.resolve.alias` ENTRY — the plan assumed one would do, and it does
 * not. Astro's own `astro:tsconfig-alias` plugin derives `@/*` from `tsconfig.json` and contributes it
 * as `{ find: /^@\/(.+)$/, replacement: "$1", customResolver }` through its `config()` hook. Vite's
 * `mergeAlias` puts plugin-contributed aliases BEFORE user ones on purpose ("the later should have
 * higher priority"), and `@rollup/plugin-alias` stops at the FIRST matching entry — so a
 * `vite.resolve.alias` key here is matched by Astro's broader `@/*` entry and never consulted. Verified
 * empirically: with the plain entry, `E2E_FAKE_LLM=1 npm run build` still bundled the real module.
 *
 * Contributing the alias from a plugin that is ALSO `enforce: "post"` fixes the order: Astro's internal
 * plugins are listed before the user's in `create-vite.js`, so this `config()` hook runs after
 * `astro:tsconfig-alias`'s, merges later, and therefore lands first. The `find` is an anchored RegExp
 * so it matches that one specifier exactly and cannot shadow anything else under `@/lib/services/`.
 *
 * Applied at CONFIG-LOAD time, not build time, which is why one mechanism serves both `npm run dev`
 * locally and a built `npm run preview` in CI.
 */
const e2eFakeLlmPlugins = process.env.E2E_FAKE_LLM
  ? [
      /** @type {import("vite").Plugin} */ ({
        name: "e2e:fake-llm-alias",
        enforce: "post",
        config: () => ({
          resolve: {
            alias: [
              {
                find: /^@\/lib\/services\/llm$/,
                replacement: fileURLToPath(new URL("./src/test/e2e/fake-llm.ts", import.meta.url)),
              },
            ],
          },
        }),
      }),
    ]
  : [];

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [
    react(),
    sitemap(),
    // Sentry, CLIENT HALF ONLY. The integration's job here is the browser SDK (it injects
    // `sentry.client.config.ts`) plus source-map handling; the Worker is instrumented by `worker.ts`,
    // which `wrangler.jsonc`'s `main` points at.
    //
    // WHY `enabled.server: false` RATHER THAN LETTING THE INTEGRATION DO BOTH. On paper this version
    // detects the Cloudflare adapter and wraps the built Worker entry with `withSentry` itself. In
    // practice its transform only fires on module ids containing `astrojs-ssr-virtual-entry`, and
    // Astro 6 + adapter v13 builds the entry as `astro:cloudflare:worker-entry` — so it wraps nothing
    // (verified: `grep -rl withSentry dist/` was empty on a full build with the server half enabled).
    // Leaving that half on would therefore add no instrumentation today while quietly arming a
    // DOUBLE instrumentation the day an SDK release fixes the id guard, with its options coming from
    // Worker env vars instead of `worker.ts`. Turning it off makes the single server path explicit.
    // The same flag also skips the `@sentry/astro/middleware` injection, which is `@sentry/node`-based
    // and has no business on workerd.
    sentry({
      enabled: { client: true, server: false },
      // Source-map upload is decided EXPLICITLY, not inherited. The integration's default is to upload
      // (and to flip `vite.build.sourcemap` to `"hidden"` to have something to upload), which would
      // make a contributor build without Sentry credentials emit maps it then cannot ship. Tie it to
      // the one credential an upload actually needs: no `SENTRY_AUTH_TOKEN` in the build environment ⇒
      // no hidden maps and no upload attempt.
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
  ],
  // Both families are downloaded at build and self-hosted from the output — no CDN at runtime, which
  // is a hard constraint on Workers. `subsets` carries the Polish diacritics (`latin-ext`) the type
  // decision rests on; `styles` is NOT optional housekeeping — Astro defaults to
  // ["normal", "italic"], which would silently double the generated face count with italics this
  // scale never uses. Weights are exactly the ones ds-bundle/type.html specifies.
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Space Grotesk",
      cssVariable: "--font-space-grotesk",
      weights: [400, 500, 600, 700],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
    },
    {
      provider: fontProviders.google(),
      name: "IBM Plex Sans",
      cssVariable: "--font-ibm-plex-sans",
      weights: [400, 500, 600],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
    },
  ],
  vite: {
    plugins: [tailwindcss(), ...e2eFakeLlmPlugins],
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

      // Sentry, one DSN delivered by two different mechanisms — which is why there are two entries
      // and not one. `SENTRY_DSN` is a Worker secret read at RUNTIME by the injected server config;
      // `PUBLIC_SENTRY_DSN` is INLINED into the client bundle at BUILD time, so it has to reach the
      // build step (a GitHub repo secret on the `deploy` job) rather than wrangler.
      //
      // Both `optional` — like every other secret here — and that is the load-bearing part: a build
      // with neither still succeeds, and an unset DSN leaves the SDK uninitialised rather than
      // throwing. That is what keeps local dev, `npm test`, the integration suite, the e2e run and
      // the `ci` job silent BY CONSTRUCTION rather than by a runtime flag someone has to remember to
      // set. The asymmetry pays off twice: the `e2e` job builds without `PUBLIC_SENTRY_DSN`, so its
      // browser bundle physically cannot carry one.
      SENTRY_DSN: envField.string({ context: "server", access: "secret", optional: true }),
      PUBLIC_SENTRY_DSN: envField.string({ context: "client", access: "public", optional: true }),
    },
  },
});
