import { createClient } from "@supabase/supabase-js";
import { RESERVED_YOUTUBE_IDS } from "./synthetic-fixtures";

interface CacheRow {
  youtube_id: string;
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

  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (!isLoopback) {
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
 */
async function assertNoStaleFixtureRows(): Promise<void> {
  if (RESERVED_YOUTUBE_IDS.length === 0) {
    return;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set before the integration suite can " +
        "check for stale fixture rows from a previous interrupted run.",
    );
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const ids = [...RESERVED_YOUTUBE_IDS];
  const [transcript, metadata] = await Promise.all([
    admin.from("transcript_cache").select("youtube_id").in("youtube_id", ids),
    admin.from("metadata_cache").select("youtube_id").in("youtube_id", ids),
  ]);
  if (transcript.error || metadata.error) {
    throw new Error(`Could not check for stale fixture rows: ${(transcript.error ?? metadata.error)?.message}`);
  }

  const rows = [...(transcript.data as CacheRow[]), ...(metadata.data as CacheRow[])];
  const stale = [...new Set(rows.map((row) => row.youtube_id))];
  if (stale.length > 0) {
    throw new Error(
      `Stale fixture row(s) survive from a previous run: ${stale.join(", ")}. transcript_cache and ` +
        "metadata_cache are user-agnostic, so an interrupted earlier run can leave rows behind. Delete " +
        "them by youtube_id before re-running: delete from transcript_cache where youtube_id in (...); " +
        "delete from metadata_cache where youtube_id in (...).",
    );
  }
}

export default async function setup(): Promise<void> {
  assertLoopbackSupabaseUrl(process.env.SUPABASE_URL);
  await assertNoStaleFixtureRows();
}
