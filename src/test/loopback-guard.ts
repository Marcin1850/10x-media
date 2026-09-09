/**
 * The guard that makes every database-touching test layer safe to run at all, in the smallest module
 * that can hold it.
 *
 * **Why it lives on its own rather than in `integration-setup.ts`.** It is imported from four places
 * with very different appetites for dependencies: Vitest's `globalSetup`, `db-owner.ts`,
 * `fetch-firewall.ts`, and — since impl-review F1 — `playwright.config.ts` itself, which Playwright
 * evaluates BEFORE it starts `webServer`. That last one is the constraint: `integration-setup.ts`
 * pulls in `@supabase/supabase-js` and a Postgres pool, and paying for that graph just to parse a
 * hostname at config load would be absurd. This file imports nothing.
 *
 * `integration-setup.ts` re-exports both functions, so the path `test-plan.md` §6.2 documents keeps
 * working. There is still exactly ONE implementation — a second hand-written copy is the one piece of
 * this harness that must never be allowed to drift.
 */

/**
 * WHATWG `new URL(...).hostname` reports an IPv6 literal WITH its brackets (`"[::1]"`, not `"::1"`) —
 * verified against Node's URL implementation. Shared by `assertLoopbackSupabaseUrl` below and
 * `fetch-firewall.ts`, so both guards recognize the same loopback shapes.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/**
 * The one irreversible failure mode in this phase (plan.md, "Critical Implementation Details"): the
 * `ci` job's `build` step uses `secrets.SUPABASE_URL`, which points at production. The integration and
 * e2e suites create and delete `auth.users` rows, so a copied-in env line would do that against
 * production. Exported separately from `integration-setup.ts`'s `setup` so it can be exercised
 * directly, without a database, by the smoke test.
 */
export function assertLoopbackSupabaseUrl(rawUrl: string | undefined): void {
  if (!rawUrl) {
    throw new Error(
      "SUPABASE_URL is unset. The integration suite creates and deletes auth.users rows and refuses " +
        "to run without a URL this guard can verify is local. Start the local stack (`npx supabase " +
        "start`) and set SUPABASE_URL to the printed API URL, e.g. http://127.0.0.1:54321.",
    );
  }

  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    throw new Error(
      `SUPABASE_URL ("${rawUrl}") is not a valid URL. Point it at your local Supabase stack, e.g. ` +
        "http://127.0.0.1:54321.",
    );
  }

  if (!isLoopbackHostname(hostname)) {
    throw new Error(
      `SUPABASE_URL ("${rawUrl}") does not resolve to loopback. The integration suite creates and ` +
        "deletes auth.users rows — running it against anything but your local stack (including " +
        "production, reached via secrets.SUPABASE_URL in CI's `ci` job) would do that for real. Point " +
        "SUPABASE_URL at your local stack instead (`npx supabase start`), e.g. http://127.0.0.1:54321.",
    );
  }
}
