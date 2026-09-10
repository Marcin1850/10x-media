import * as Sentry from "@sentry/astro";
import type { ReportedEvent, ReportingSink } from "./reporting";

/**
 * The BROWSER arm of the seam's runtime split. Reached only through `reporting.ts`'s dynamic
 * `import()` when `import.meta.env.SSR` is false, never statically — see that module for why.
 *
 * The client it publishes through is the one `sentry.client.config.ts` initialised, which the
 * `@sentry/astro` integration injects into every page. With no `PUBLIC_SENTRY_DSN` inlined at build
 * time that config never calls `init`, so there is no active client and `captureMessage` is a no-op.
 * The `e2e` CI job and every local build are silent for exactly that reason.
 */

/**
 * The browser half of the purity pair. `SENTRY_WORKER_SINK` is the one the Phase 3 criterion greps
 * for; this one exists so the two sinks are symmetrical and so an event's `sink` tag names its
 * transport in Sentry.
 */
export const SENTRY_BROWSER_SINK = "SENTRY_BROWSER_SINK";

export const sentryBrowserSink: ReportingSink = (event: ReportedEvent): void => {
  Sentry.captureMessage(event.message, {
    level: event.level,
    // Spread: Sentry's option is a mutable `string[]`, and the seam's is readonly on purpose.
    fingerprint: [...event.fingerprint],
    tags: { sink: SENTRY_BROWSER_SINK },
    contexts: { report: event.context },
  });
};
