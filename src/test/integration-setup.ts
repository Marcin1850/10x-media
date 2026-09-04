import { createClient } from "@supabase/supabase-js";
import { RESERVED_YOUTUBE_IDS } from "./synthetic-fixtures";
import { SYNTHETIC_ACCOUNT_EMAIL_PREFIX } from "./synthetic-account";
import { closeDbOwnerConnection, getDbOwnerConnection } from "./db-owner";

/** Shared by both stale-row guards below — a service-role client against the (already loopback-checked) local stack. */
function getAdminClientOrThrow(checking: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set before the integration suite can ` +
        `check for ${checking} from a previous interrupted run.`,
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

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
 * `ci` job's `build` step uses `secrets.SUPABASE_URL`, which points at production. This suite creates
 * and deletes `auth.users` rows, so a copied-in env line would do that against production. Exported
 * separately from `setup` below so it can be exercised directly, without a database, by the smoke test.
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

/**
 * Catches a stale fixture row an earlier, interrupted run left behind. `transcript_cache` and
 * `metadata_cache` are user-agnostic (research.md §6) — no synthetic-account cleanup reaches them —
 * so a leftover row from a crashed run can silently make a later test's breaker-bypass assumption
 * true for the wrong reason. `RESERVED_YOUTUBE_IDS` is empty in Phase 2; this is a no-op until a
 * later phase seeds either cache and registers the id there.
 *
 * Reads via the table-owner connection (`db-owner.ts`), not `service_role` — those two tables
 * deliberately grant `service_role` no direct privileges (impl-review.md F2).
 */
async function assertNoStaleFixtureRows(): Promise<void> {
  if (RESERVED_YOUTUBE_IDS.length === 0) {
    return;
  }

  const sql = getDbOwnerConnection();
  const ids = [...RESERVED_YOUTUBE_IDS];
  const [transcriptRows, metadataRows] = await Promise.all([
    sql<{ youtube_id: string }[]>`select youtube_id from transcript_cache where youtube_id in ${sql(ids)}`,
    sql<{ youtube_id: string }[]>`select youtube_id from metadata_cache where youtube_id in ${sql(ids)}`,
  ]);

  const stale = [...new Set([...transcriptRows, ...metadataRows].map((row) => row.youtube_id))];
  if (stale.length > 0) {
    throw new Error(
      `Stale fixture row(s) survive from a previous run: ${stale.join(", ")}. transcript_cache and ` +
        "metadata_cache are user-agnostic, so an interrupted earlier run can leave rows behind. Delete " +
        "them by youtube_id before re-running: delete from transcript_cache where youtube_id in (...); " +
        "delete from metadata_cache where youtube_id in (...).",
    );
  }
}

/**
 * Catches a synthetic `auth.users` row an earlier, hard-killed run left behind.
 *
 * `synthetic-account.ts`'s `dispose()` runs in a test's `try/finally`, which protects against a normal
 * test failure (an assertion throws, an RPC errors) but NOT against the process being killed mid-flight
 * — a `SIGKILL` never runs pending `finally` code, so a run interrupted between account creation and
 * disposal can leave a row behind. Unlike the cache-row check above, there is no fixed registry of
 * expected emails to look for (each account's email is a fresh random UUID) — every account shares only
 * the `SYNTHETIC_ACCOUNT_EMAIL_PREFIX` prefix, so this sweeps `auth.users` by that prefix instead of an
 * exact-id list.
 */
async function assertNoStaleSyntheticAccounts(): Promise<void> {
  const admin = getAdminClientOrThrow("stale synthetic accounts");

  const stale: string[] = [];
  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`Could not check for stale synthetic accounts: ${error.message}`);
    }
    for (const user of data.users) {
      if (user.email?.startsWith(SYNTHETIC_ACCOUNT_EMAIL_PREFIX)) {
        stale.push(user.email);
      }
    }
    if (data.users.length < perPage) break;
  }

  if (stale.length > 0) {
    throw new Error(
      `Stale synthetic account(s) survive from a previous run: ${stale.join(", ")}. These are created by ` +
        "src/test/synthetic-account.ts and normally deleted by the same test's dispose() call — a " +
        "surviving row means an earlier run was killed before that cleanup ran. Delete them (Supabase " +
        "Studio's Auth panel, or `admin.auth.admin.deleteUser(id)`) before re-running.",
    );
  }
}

export default async function setup(): Promise<void> {
  assertLoopbackSupabaseUrl(process.env.SUPABASE_URL);
  try {
    await assertNoStaleFixtureRows();
    await assertNoStaleSyntheticAccounts();
  } finally {
    // globalSetup runs in its own short-lived process, outside any vitest hook context — close the
    // owner connection explicitly rather than relying on an afterAll (db-owner.ts has none).
    await closeDbOwnerConnection();
  }
}
