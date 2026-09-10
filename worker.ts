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
 *     DSN off `env` in the callback below is therefore not a shortcut around `astro:env/server`; it is
 *     the only place a Worker secret exists.
 *
 * The file is named `worker.ts`, not `sentry.server.config.ts`, on purpose: the latter is the name
 * `@sentry/astro` probes for and would inject into every page's SSR module.
 */
import * as Sentry from "@sentry/cloudflare";
import handler from "@astrojs/cloudflare/entrypoints/server";

/**
 * The one binding this file reads. `SENTRY_DSN` is a Worker secret (`wrangler secret put`), declared
 * `optional` in `astro.config.mjs`'s env schema and absent from `.dev.vars.e2e` by design.
 */
interface SentryWorkerEnv {
  SENTRY_DSN?: string;
}

/**
 * The header and query-parameter names `@sentry/core`'s own non-PII baseline denies. Reproduced here
 * because the constant is internal to the SDK, and because a present `dataCollection` (see below)
 * would otherwise select the wider `true` for these two fields.
 */
const PII_HEADER_DENY_LIST = ["forwarded", "-ip", "remote-", "via", "-user"];

export default Sentry.withSentry<SentryWorkerEnv>(
  (env) => ({
    /**
     * THE DSN IS THE OFF SWITCH, and it is the SERVER value only — never `PUBLIC_SENTRY_DSN`, so a
     * browser DSN present at build time cannot switch the Worker on. Undefined leaves the SDK
     * disabled, which is the state of local dev, both Vitest projects, an e2e run and the `ci`/`e2e`
     * CI jobs. Silence is a property of the environment, not of a runtime flag someone has to
     * remember to set.
     */
    dsn: env.SENTRY_DSN,
    environment: "production",
    // Performance tracing is explicitly out of scope for this change (decision D6).
    tracesSampleRate: 0,
    /**
     * Decision D8, spelled out in FULL — and every field below is load-bearing rather than a
     * restatement of a default. `@sentry/core`'s `resolveDataCollectionOptions` picks one of two
     * baselines: with `dataCollection` ABSENT it uses the tight `sendDefaultPii: false` baseline, but
     * the moment ANY field is set the baseline flips to the fully permissive `DEFAULTS`. A partial
     * object would therefore LOOSEN this Worker — omitting `httpBodies` alone would start shipping
     * request bodies. Do not drop a line here as "the default anyway".
     */
    dataCollection: {
      // No `user.*` fields populated from instrumentation.
      userInfo: false,
      // These are Supabase auth cookies — i.e. session tokens.
      cookies: false,
      // `generate.ts`'s request bodies carry user content and its responses carry summaries.
      httpBodies: [],
      // Keep headers and query params — minus the same PII names the SDK's own baseline denies, which
      // is what "keep the rest" (D8) means. Genuinely sensitive keys (`auth`, `token`, `session`,
      // `cookie`, …) are filtered unconditionally by the SDK on top of this list.
      httpHeaders: {
        request: { deny: PII_HEADER_DENY_LIST },
        response: { deny: PII_HEADER_DENY_LIST },
      },
      urlQueryParams: { deny: PII_HEADER_DENY_LIST },
      // Supabase query values and returned rows are user content.
      databaseQueryData: false,
      // No LLM prompt or completion text.
      genAI: { inputs: false, outputs: false },
    },
  }),
  handler,
);
