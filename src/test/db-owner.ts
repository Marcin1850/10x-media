import postgres from "postgres";
import { isLoopbackHostname } from "./integration-setup";

/**
 * A test-only connection to the local Postgres instance AS ITS OWNER, not through PostgREST as
 * `service_role`. `transcript_cache`, `metadata_cache`, and `credit_reservations` deliberately never
 * grant `service_role` ordinary table privileges (the app reaches them exclusively through `SECURITY
 * DEFINER` RPCs) — an earlier migration granted `service_role` direct SELECT/DELETE on those tables
 * (plus `supadata_calls`) solely so this test harness could reach past the RPCs, which permanently
 * widened what the production request-path secret can do. Removed for that reason (impl-review.md F2);
 * this owner connection reaches the same rows without touching any application role's privileges.
 *
 * `supabase start` always exposes the local Postgres instance on this exact connection string — fixed
 * and publicly documented, the same value the README's CI section already relies on for the local demo
 * keys — so no new secret is needed for the common case. `SUPABASE_DB_URL` only exists to override it
 * for a locally customized `supabase/config.toml`.
 */
const DEFAULT_LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let sql: ReturnType<typeof postgres> | undefined;

export function getDbOwnerConnection(): ReturnType<typeof postgres> {
  if (sql) return sql;

  const url = process.env.SUPABASE_DB_URL ?? DEFAULT_LOCAL_DB_URL;
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`SUPABASE_DB_URL ("${url}") is not a valid Postgres connection string.`);
  }
  if (!isLoopbackHostname(hostname)) {
    throw new Error(
      `SUPABASE_DB_URL ("${url}") does not resolve to loopback. This connection holds table-owner ` +
        "privileges and must only ever reach your local Supabase stack.",
    );
  }

  sql = postgres(url, { max: 5 });
  return sql;
}

/** Deliberately vitest-agnostic (this module is also imported by `integration-setup.ts`'s `globalSetup`, which runs outside any vitest hook context) — callers close the connection explicitly rather than via an `afterAll`. */
export async function closeDbOwnerConnection(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = undefined;
  }
}
