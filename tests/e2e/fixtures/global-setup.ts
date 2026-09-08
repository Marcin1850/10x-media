import { assertLoopbackSupabaseUrl } from "@/test/integration-setup";
import { closeDbOwnerConnection, getDbOwnerConnection } from "@/test/db-owner";
import { adminClient } from "./admin";
import { E2E_ACCOUNT_EMAIL_PREFIX, E2E_RESERVED_YOUTUBE_IDS } from "./registry";

/**
 * The e2e suite's `globalSetup` (`playwright.config.ts`). It gives this layer the same two guarantees
 * `src/test/integration-setup.ts` gives the integration suite, over the e2e registry:
 *
 *  1. **Refuse to run against anything but a loopback Supabase.** Specs create and delete `auth.users`
 *     rows; a copied-in production URL would do that for real.
 *  2. **Abort on state a hard-killed prior run left behind**, rather than silently reusing it — a
 *     surviving `transcript_cache` row makes a later spec's "no vendor call happened" assumption true
 *     for the wrong reason, and a surviving account is a leak nothing else will ever attribute.
 *
 * The loopback guard is IMPORTED, never re-implemented. The registries are deliberately separate
 * (`registry.ts` explains why); the guard that makes either suite safe to run at all deliberately is
 * not — a second hand-written copy is the one piece here that must never be allowed to drift.
 */
export default async function globalSetup(): Promise<void> {
  assertLoopbackSupabaseUrl(process.env.SUPABASE_URL);
  try {
    await assertNoStaleFixtureRows();
    await assertNoStaleE2eAccounts();
  } finally {
    // `globalSetup` runs in its own process, outside any worker — close the owner connection
    // explicitly rather than leaving an open socket holding the event loop (`db-owner.ts` has no
    // `afterAll` of its own; the same reason `integration-setup.ts` closes it here too).
    await closeDbOwnerConnection();
  }
}

/**
 * `transcript_cache` and `metadata_cache` are user-agnostic — keyed by video id, with no owner column
 * — so no account cleanup ever reaches them. A row an interrupted run left behind would silently make
 * the NEXT run's cache-hit assumption true without the spec having seeded anything, which is the one
 * failure that turns "no vendor was contacted" from a proof into a coincidence.
 *
 * Read through the table-owner connection (`db-owner.ts`), never `service_role`: both tables
 * deliberately grant `service_role` no direct privileges (impl-review.md F2).
 */
async function assertNoStaleFixtureRows(): Promise<void> {
  const sql = getDbOwnerConnection();
  const ids = [...E2E_RESERVED_YOUTUBE_IDS];
  const [transcriptRows, metadataRows] = await Promise.all([
    sql<{ youtube_id: string }[]>`select youtube_id from transcript_cache where youtube_id in ${sql(ids)}`,
    sql<{ youtube_id: string }[]>`select youtube_id from metadata_cache where youtube_id in ${sql(ids)}`,
  ]);

  const stale = [...new Set([...transcriptRows, ...metadataRows].map((row) => row.youtube_id))];
  if (stale.length > 0) {
    throw new Error(
      `e2e: stale cache row(s) survive from a previous run: ${stale.join(", ")}. transcript_cache and ` +
        "metadata_cache are user-agnostic, so a killed run leaves them behind. Delete them by " +
        "youtube_id before re-running:\n" +
        `  delete from transcript_cache where youtube_id in ('${stale.join("', '")}');\n` +
        `  delete from metadata_cache where youtube_id in ('${stale.join("', '")}');`,
    );
  }
}

/**
 * Catches an e2e synthetic `auth.users` row a hard-killed run left behind. Each account's email is a
 * fresh UUID, so there is no fixed list to check — every one shares only `E2E_ACCOUNT_EMAIL_PREFIX`,
 * and this sweeps by that prefix. It deliberately does NOT see `synthetic-db-int-` accounts: those
 * belong to the integration suite, which has its own guard for them.
 */
async function assertNoStaleE2eAccounts(): Promise<void> {
  const admin = adminClient();

  const stale: string[] = [];
  const perPage = 200;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`e2e: could not check for stale synthetic accounts: ${error.message}`);
    }
    for (const user of data.users) {
      if (user.email?.startsWith(E2E_ACCOUNT_EMAIL_PREFIX)) {
        stale.push(user.email);
      }
    }
    if (data.users.length < perPage) break;
  }

  if (stale.length > 0) {
    throw new Error(
      `e2e: stale synthetic account(s) survive from a previous run: ${stale.join(", ")}. These are created ` +
        "by the `account` fixture (tests/e2e/fixtures/account.ts) and normally deleted by the same test's " +
        "teardown — a survivor means a run was killed before that ran. Delete them (Supabase Studio's Auth " +
        "panel, or `admin.auth.admin.deleteUser(id)`) before re-running.",
    );
  }
}
