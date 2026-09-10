/**
 * The BROWSER half of the receiver. `@sentry/astro` probes for this exact filename at the project
 * root and injects `import "<this file>"` into every page (`injectScript("page", …)`), which is why
 * the name is not negotiable — and why the Worker's initialisation deliberately does NOT live in a
 * `sentry.server.config.ts` (see `worker.ts` for that story).
 *
 * It exists so the `[unsupported-feature]` family, emitted from a hydrated React island, reaches the
 * same Sentry project as the Worker's `[supadata-budget]` family (decision D1). The two runtimes
 * initialise independently: neither this file nor `worker.ts` says anything about whether the other
 * one is working.
 */
import * as Sentry from "@sentry/astro";
import { PUBLIC_SENTRY_DSN } from "astro:env/client";

/**
 * The header and query-parameter names `@sentry/core`'s own non-PII baseline denies, reproduced because
 * the constant is internal to the SDK. The Worker no longer uses this list: since impl-review F1 its
 * options (`src/lib/services/sentry-worker-options.ts`) drop headers and query strings outright, because
 * the SDK applies these deny lists to span attributes only, never to events. This bundle has not yet been
 * probed at the envelope level — F1's recorded open item.
 */
const PII_HEADER_DENY_LIST = ["forwarded", "-ip", "remote-", "via", "-user"];

/**
 * THE DSN IS THE OFF SWITCH, and unlike the Worker's it is a BUILD input: a client `astro:env` value
 * is inlined into the browser bundle at build time, so it has to reach the `deploy` job's build step
 * as a GitHub repository secret. The asymmetry pays off — the `ci` and `e2e` jobs build without it,
 * so the browser bundles they produce physically cannot carry a DSN.
 *
 * The guard is explicit rather than left to the SDK: with no DSN we do not call `init` at all, so
 * there is no client, and `reporting-sink.client.ts`'s `captureMessage` is a silent no-op.
 */
if (PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: PUBLIC_SENTRY_DSN,
    environment: "production",
    // Performance tracing is explicitly out of scope for this change (decision D6).
    tracesSampleRate: 0,
    /**
     * Session Replay, browser tracing and the user-feedback widget are all out of scope, and all
     * three are expensive in bundle size as well as quota. Filtering the SDK's own defaults keeps
     * what actually matters — the global error/rejection handlers and breadcrumbs — instead of
     * passing `integrations: []` and silently losing them too.
     *
     * `Dedupe` is kept ON PURPOSE (impl-review F5, operator decision in `manual-verification.md`): it
     * drops an event identical to the previous one in the same page session, so a repeated
     * `[unsupported-feature]` click counts once. See `reporting.ts`'s fingerprint note for the contract.
     */
    integrations: (defaults) =>
      defaults.filter((integration) => !/^(Replay|ReplayCanvas|BrowserTracing|Feedback)$/.test(integration.name)),
    /**
     * Decision D8 as originally specified. The Worker's copy has since been tightened (impl-review F1,
     * `src/lib/services/sentry-worker-options.ts`); this one has not. Every line is load-bearing rather than
     * a restatement of a default: `@sentry/core`'s `resolveDataCollectionOptions` uses the tight
     * baseline only while `dataCollection` is ABSENT, and flips to the fully permissive `DEFAULTS`
     * the moment any field is set. A partial object would therefore LOOSEN this bundle. Do not drop
     * a line here as "the default anyway".
     */
    dataCollection: {
      // No `user.*` fields populated from instrumentation.
      userInfo: false,
      // These are Supabase auth cookies — i.e. session tokens.
      cookies: false,
      // Request bodies carry the user's own content.
      httpBodies: [],
      // Keep headers and query params — minus the same PII names the SDK's own baseline denies,
      // which is what "keep the rest" (D8) means.
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
  });
}
