# Review follow-ups — error-monitoring

> Open items from `reviews/impl-review.md` that triage did not fix. Neither blocks the slice; each needs
> its own decision, and both are unverified rather than known leaks.

## 1. Outbound-request and console breadcrumbs may carry user identifiers

- **Source**: impl-review F1 decision, "Still open".
- **What**: `@sentry/cloudflare`'s default `fetchIntegration` and `consoleIntegration` attach breadcrumbs
  to every event. Outbound Supabase PostgREST URLs can carry filters such as `user_id=eq.<uuid>`, and
  console lines from non-promoted sites may carry ids — both outside the seam's no-identifiers rule and
  its one documented exception (the reconciliation family).
- **Why unverified**: `sentry-worker-options.test.ts`'s envelope probe makes no outbound `fetch` and logs
  nothing, so it cannot see breadcrumbs. `scrubRequestData` only touches `event.request`.
- **Next step**: extend the envelope probe with an outbound `fetch` carrying a sentinel query value and a
  `console.error` line carrying a sentinel. If either reaches the envelope, scrub breadcrumb URLs and
  messages (`beforeBreadcrumb` or `beforeSend`) and keep the probe as the regression test.

## 2. The browser SDK has no envelope-level privacy probe

- **Source**: impl-review F1 blind spot.
- **What**: `sentry.client.config.ts` still carries the original D8 block, with header and query-parameter
  deny lists. On the Worker those lists turned out to apply to span attributes only, never to events.
  Whether the browser SDK attaches a page URL's query string or request headers to its events has not
  been checked.
- **Next step**: a browser-side envelope probe — a recording transport and a page URL carrying a sentinel
  query value — asserting sentinel absence on the serialized envelope. If it leaks, mirror a `beforeSend`
  scrubber in the client config.
