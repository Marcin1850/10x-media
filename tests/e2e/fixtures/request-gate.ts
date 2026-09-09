import type { Page } from "@playwright/test";

/**
 * Holds one in-flight request open so a spec can assert a TRANSIENT ui state while it is still true.
 *
 * **The problem it solves** (impl-review F6). The e2e LLM is a fake that resolves immediately, so the
 * whole generate round-trip finishes in a few hundred milliseconds. The pending card therefore exists
 * for a very short window, and a web-first assertion cannot recover a state that has already passed:
 * `expect(...).toContainText(...)` retries until the condition becomes true, which never happens if
 * the condition WAS true and stopped being true before the first poll. That is a race with no sleep in
 * it — the failure mode `waitForTimeout` is usually blamed for, arriving by a different road.
 *
 * **Why it is not a mock.** The gate delays the request and then lets the REAL one continue to the real
 * endpoint (`route.fallback()`); it never supplies a response, a status, or a body. What the app
 * receives, and what the ledger records, is exactly what an ungated run would produce — the spec only
 * chooses WHEN the answer is allowed to arrive. Faking the response here would delete the very thing
 * the spec exists to check.
 *
 * **Scope.** The pattern is matched against one URL, so unrelated page requests (documents, assets,
 * the follow-up `GET /api/summaries`) are never held.
 */
export interface RequestGate {
  /** Resolves once the browser has actually issued the gated request, which is then held open. */
  waitUntilRequested(): Promise<void>;
  /** Lets the held request continue to the real endpoint, and stops intercepting. */
  release(): Promise<void>;
}

export async function gateRequest(page: Page, urlPattern: string): Promise<RequestGate> {
  let markRequested: () => void;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });

  let openTheGate: () => void;
  const gateOpened = new Promise<void>((resolve) => {
    openTheGate = resolve;
  });

  await page.route(urlPattern, async (route) => {
    markRequested();
    await gateOpened;
    // `fallback`, not `fulfill`: the request carries on to the real endpoint untouched. The handler is
    // still registered at this point, so `unroute` below happens after the request is safely on its way.
    await route.fallback();
  });

  return {
    waitUntilRequested: () => requested,
    async release() {
      openTheGate();
      await page.unroute(urlPattern);
    },
  };
}
