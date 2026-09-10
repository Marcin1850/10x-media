import * as Sentry from "@sentry/cloudflare";
import type { ReportedEvent, ReportingSink } from "./reporting";

/**
 * The WORKER arm of the seam's runtime split. Reached only through `reporting.ts`'s dynamic
 * `import()` under `import.meta.env.SSR`, never statically — see that module for why.
 *
 * The client it publishes through is the one `worker.ts` set up inside `withSentry`. There is no
 * `init` here and there cannot be: `@sentry/cloudflare` exports none, because a Worker's DSN is a
 * per-request binding rather than a module-load constant. With no DSN bound (local dev, both Vitest
 * projects, an e2e run, the `ci`/`e2e` CI jobs) there is no active client and `captureMessage` is a
 * no-op — silence by absence, not by a flag.
 */

/**
 * THE PURITY SENTINEL. `dist/_astro/` must never contain this string and `dist/server/` must always
 * contain it — the plan's Phase 3 criterion greps for it in BOTH directions, because an absence-only
 * grep passes just as happily against a misspelling.
 *
 * It has to be a sentinel the APPLICATION owns rather than a package name: Rollup rewrites and drops
 * package specifiers, so `grep "@sentry/cloudflare" dist/_astro/` can come back clean from a bundle
 * that contains the whole Worker SDK. Same reasoning as the existing `E2E_FAKE_SUMMARIZER` proof.
 *
 * It is referenced below as a real event tag rather than parked in a dead constant, so no minifier
 * can drop it and so an operator can tell the two transports apart in Sentry.
 */
export const SENTRY_WORKER_SINK = "SENTRY_WORKER_SINK";

export const sentryWorkerSink: ReportingSink = (event: ReportedEvent): void => {
  Sentry.captureMessage(event.message, {
    level: event.level,
    // Spread: Sentry's option is a mutable `string[]`, and the seam's is readonly on purpose.
    fingerprint: [...event.fingerprint],
    tags: { sink: SENTRY_WORKER_SINK },
    contexts: { report: event.context },
  });
};
