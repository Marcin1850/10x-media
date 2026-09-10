import { test as base } from "@playwright/test";

/**
 * The observable half of the browser's no-outbound promise (S-13 Phase 3 §5).
 *
 * Three guards already stop a DSN from reaching an e2e run — `playwright.config.ts` refuses to start
 * when `SENTRY_DSN` or `PUBLIC_SENTRY_DSN` is set, `webServer.env` pins both to `""`, and the client
 * value is a BUILD input so the bundle would have to be rebuilt to acquire one. All three are about
 * the input. This one is about the consequence: it watches the wire.
 *
 * That matters because the browser is the one runtime nothing else can see. `src/test/fetch-firewall.ts`
 * throws on a non-loopback `fetch`, but it lives in the integration project's process; under
 * Playwright the app is a different process and the page is a different process again, so a browser
 * bundle that had somehow acquired a DSN would report to Sentry with nothing in this repository
 * noticing. An e2e run is not an incident and must never file one against the operator's project.
 *
 * ABORT, don't fulfil: a stubbed 200 would let a regression sit here indefinitely looking healthy.
 * The count is what fails the test — the abort only makes sure nothing leaves the machine first.
 */

/**
 * Sentry's ingest lives on per-org `*.ingest.*.sentry.io` hosts, and the SDK also talks to
 * `sentry.io` itself. Matching the registrable domain covers both, plus a self-hosted relay would be
 * a deliberate configuration change that should update this list with it.
 */
const SENTRY_HOST_PATTERN = /^https?:\/\/([^/]+\.)?sentry\.io(:\d+)?\//;

interface NoSentryFixtures {
  /**
   * Auto — every test gets it, including ones that never touch the top-up affordance. The promise is
   * "no e2e run reports", not "the one spec that clicks the button does not report".
   */
  sentryIngestGuard: undefined;
}

export const noSentryTest = base.extend<NoSentryFixtures>({
  sentryIngestGuard: [
    async ({ context }, use) => {
      const attempted: string[] = [];

      // Routed on the CONTEXT rather than the page: it covers popups, iframes and any request the
      // page opens later, and it is installed before the test body navigates anywhere.
      await context.route(SENTRY_HOST_PATTERN, async (route) => {
        attempted.push(route.request().url());
        await route.abort();
      });

      await use(undefined);

      if (attempted.length > 0) {
        throw new Error(
          `The browser attempted ${attempted.length} Sentry ingest request(s) during an e2e run, which ` +
            "means the client bundle carried a DSN. The run was blocked from reaching Sentry, but the " +
            "build is wrong: check that `PUBLIC_SENTRY_DSN` was unset when `webServer` built the app " +
            `(playwright.config.ts pins it to ""). Attempted: ${attempted.join(", ")}`,
        );
      }
    },
    { auto: true },
  ],
});
