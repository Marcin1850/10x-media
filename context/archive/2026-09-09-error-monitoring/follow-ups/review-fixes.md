# Review follow-ups — error-monitoring

> Open items from `reviews/impl-review.md` that triage did not fix. Item 1 was confirmed on a stored
> production event and fixed on 2026-09-11; item 2 remains unverified.

## 1. Outbound-request and console breadcrumbs may carry user identifiers

- **Source**: impl-review F1 decision, "Still open".
- **What**: `@sentry/cloudflare`'s default `fetchIntegration` and `consoleIntegration` attach breadcrumbs
  to every event. Outbound Supabase PostgREST URLs can carry filters such as `user_id=eq.<uuid>`, and
  console lines from non-promoted sites may carry ids — both outside the seam's no-identifiers rule and
  its one documented exception (the reconciliation family).
- **Status (2026-09-11): confirmed and fixed on the Worker.** Inspecting the stored production events
  through the Sentry MCP found a Supabase `GET /rest/v1/summaries?select=…` fetch breadcrumb on the Worker
  smoke event (`10XMEDIA-3`). `summary-list.ts` sends `.eq("user_id", …)` as a query parameter, so that
  URL carried the operator's own account id (the MCP view truncates it before the filter). No password,
  token or callback code was found in any stored event.
- **Fix**: `sentry-worker-options.ts` sets `beforeBreadcrumb: scrubBreadcrumb` — console breadcrumbs are
  dropped (app console lines interpolate user ids; Workers Logs keeps them), and every breadcrumb URL
  loses its query and fragment. The envelope test gained a case with an outbound fetch and a console
  line, each carrying its own sentinel id; one deliberate break per branch went red naming only its own
  sentinel.
- **Operator**: delete `10XMEDIA-3` in the Sentry UI — the MCP exposes no delete tool.
- **Still open**: the browser SDK's breadcrumbs, as part of item 2.

## 2. The browser SDK has no envelope-level privacy probe

- **Source**: impl-review F1 blind spot.
- **What**: `sentry.client.config.ts` still carries the original D8 block, with header and query-parameter
  deny lists. On the Worker those lists turned out to apply to span attributes only, never to events.
  Whether the browser SDK attaches a page URL's query string or request headers to its events has not
  been checked.
- **Next step**: a browser-side envelope probe — a recording transport and a page URL carrying a sentinel
  query value — asserting sentinel absence on the serialized envelope. If it leaks, mirror a `beforeSend`
  scrubber in the client config.
