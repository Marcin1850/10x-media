import {
  httpServerIntegration,
  requestDataIntegration,
  type CloudflareOptions,
  type ErrorEvent,
} from "@sentry/cloudflare";

/**
 * The Worker's Sentry options — decision D8, and everything `worker.ts` hands to `withSentry`.
 *
 * They live here rather than inline in `worker.ts` for one reason: `worker.ts` imports the adapter's
 * `@astrojs/cloudflare/entrypoints/server`, which no Vitest project can resolve, and this is the
 * configuration whose privacy guarantee has to be tested against the real SDK
 * (`sentry-worker-options.test.ts`).
 *
 * WHY `dataCollection` ALONE DOES NOT HOLD D8 (impl-review F1). Against @sentry/cloudflare 10.74.0,
 * `dataCollection` does not govern what lands on an EVENT:
 *
 *  - the default `HttpServer` integration reads every textual request body at `"medium"` (10 KB)
 *    whatever `httpBodies` says;
 *  - the default `RequestData` integration attaches that body unconditionally (`include.data: true`),
 *    always attaches the full URL, query included, and copies request headers verbatim — the `deny`
 *    lists are applied to span attributes only, never to events.
 *
 * A probe with the previous, `dataCollection`-only config shipped a sign-in password, an
 * `Authorization` header and an auth-callback `?code=` inside the envelope. The guarantee is therefore
 * held in three layers. They are NOT each sufficient on their own — the deliberate breaks recorded in
 * the test file showed `dataCollection` alone leaking the body, and the integrations plus
 * `dataCollection` without the scrubber leaking the callback `?code=`. What each one contributes:
 *
 *  1. `integrations` — the two defaults above are REPLACED by same-named instances that capture
 *     nothing (the SDK's `filterDuplicates` lets a user instance displace a default one). This stops
 *     the body being read at all, and keeps headers, cookies and the client IP off the event at source.
 *  2. `dataCollection` — every field written out, now including the three the first version omitted.
 *     On events the `include` options above override it; it governs span attributes and whatever
 *     integration a future SDK release adds.
 *  3. `beforeSend` — `scrubRequestData`, the last gate before transport and the ONLY layer that strips
 *     the URL's query and fragment. With it in place, weakening either layer above still leaves the
 *     envelope clean (Stryker, 2026-09-10) — so those two are defence in depth for the envelope, kept
 *     because they stop the data being captured in the first place.
 *
 * Headers and query strings are dropped outright rather than filtered by name: D8's "keep the rest,
 * minus PII" was never enforced by the SDK on events, and on this app the query carries the auth
 * callback code while the body carries credentials, so nothing in either is worth the exposure.
 */

/**
 * The one binding the Worker's Sentry setup reads. `SENTRY_DSN` is a Worker secret
 * (`wrangler secret put`), declared `optional` in `astro.config.mjs`'s env schema and absent from
 * `.dev.vars.e2e` by design.
 */
export interface SentryWorkerEnv {
  SENTRY_DSN?: string;
}

export function sentryWorkerOptions(env: SentryWorkerEnv): CloudflareOptions {
  return {
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
    integrations: [
      // Never read the request body. `"none"` short-circuits before the body is cloned.
      httpServerIntegration({ maxRequestBodySize: "none" }),
      // Attach the method and the URL only; `scrubRequestData` strips the URL's query and fragment.
      requestDataIntegration({
        include: { cookies: false, data: false, headers: false, ip: false, query_string: false, url: true },
      }),
    ],
    /**
     * Spelled out in FULL — every field is load-bearing rather than a restatement of a default.
     * `@sentry/core`'s `resolveDataCollectionOptions` picks one of two baselines: with
     * `dataCollection` ABSENT it uses the tight `sendDefaultPii: false` baseline, but the moment ANY
     * field is set the baseline flips to the fully permissive `DEFAULTS`. An omitted field therefore
     * LOOSENS this Worker. Do not drop a line here as "the default anyway".
     */
    dataCollection: {
      // No `user.*` fields populated from instrumentation — which also withholds the client IP.
      userInfo: false,
      // These are Supabase auth cookies — i.e. session tokens.
      cookies: false,
      // Auth bodies carry credentials, `generate.ts`'s carry user content, its responses summaries.
      httpBodies: [],
      // Authorization headers and the auth callback's `?code=` are credentials (F1).
      httpHeaders: { request: false, response: false },
      urlQueryParams: false,
      // Supabase query values and returned rows are user content.
      databaseQueryData: false,
      // No LLM prompt or completion text.
      genAI: { inputs: false, outputs: false },
      // No GraphQL integration is active today; this keeps one from arriving permissive.
      graphQL: { document: false, variables: false },
      // Local variables in a frame can hold a password or a request body mid-handler.
      stackFrameVariables: false,
      // Source lines around a frame are bundled application code, not user data — the default, kept.
      frameContextLines: 5,
    },
    beforeSend: scrubRequestData,
  };
}

/**
 * The last gate before transport: an event keeps its request's METHOD and its URL without query or
 * fragment, and nothing else — no body, headers, cookies or query string, whichever integration put
 * them there. Mutates and returns the event, as `beforeSend` expects.
 */
export function scrubRequestData(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    const { method, url } = event.request;
    const request: NonNullable<ErrorEvent["request"]> = {};
    if (method !== undefined) request.method = method;
    if (url !== undefined) request.url = withoutQueryOrFragment(url);
    event.request = request;
  }
  return event;
}

function withoutQueryOrFragment(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
