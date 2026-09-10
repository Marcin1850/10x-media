/**
 * The Worker entry, wrapped with Sentry. `wrangler.jsonc`'s `main` points here instead of at
 * `@astrojs/cloudflare/entrypoints/server`, and this file re-exports that handler through
 * `withSentry` — which is what initialises the Cloudflare SDK.
 *
 * WHY A HAND-WRITTEN WRAPPER AND NOT `sentry.server.config.ts`. Both alternatives were tried against
 * astro 6.3.1 / @astrojs/cloudflare 13.5.0 / @sentry/{astro,cloudflare} 10.74.0 and neither works:
 *
 *  1. `@sentry/astro`'s Cloudflare plugin claims to wrap the built entry for us, but its transform
 *     only fires on module ids containing `astrojs-ssr-virtual-entry`. Astro 6 with adapter v13 builds
 *     the entry as `astro:cloudflare:worker-entry`, so the transform never matches and NOTHING is
 *     instrumented — `grep -rl withSentry dist/` came back empty on a full build. That is why the
 *     integration is registered with `enabled: { server: false }` in `astro.config.mjs`: not because
 *     its server half competes with this file, but because its server half does not run at all, and
 *     an SDK release that fixes the id guard must not silently start double-instrumenting.
 *  2. A `sentry.server.config.ts` calling `Sentry.init` cannot work either: `@sentry/cloudflare`
 *     deliberately exports no `init`. Its own `defineCloudflareOptions` docs give the reason — "the
 *     options cannot be applied at module load time on Cloudflare: the DSN and other settings
 *     typically come from the per-request `env`, which only exists inside the handler". Reading the
 *     DSN off `env` in the callback is therefore not a shortcut around `astro:env/server`; it is the
 *     only place a Worker secret exists.
 *
 * The file is named `worker.ts`, not `sentry.server.config.ts`, on purpose: the latter is the name
 * `@sentry/astro` probes for and would inject into every page's SSR module.
 *
 * The options themselves — the DSN switch and decision D8's data lockdown — live in
 * `src/lib/services/sentry-worker-options.ts`, where a unit test can drive them through the real SDK.
 * This file cannot be imported by Vitest, because the adapter entry above cannot be resolved there.
 */
import * as Sentry from "@sentry/cloudflare";
import handler from "@astrojs/cloudflare/entrypoints/server";
import { sentryWorkerOptions, type SentryWorkerEnv } from "./src/lib/services/sentry-worker-options";

export default Sentry.withSentry<SentryWorkerEnv>(sentryWorkerOptions, handler);
