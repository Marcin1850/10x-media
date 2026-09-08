import { createClient } from "@supabase/supabase-js";

/**
 * The service-role client the e2e harness uses for the two things it cannot do as a normal user:
 * create/delete synthetic `auth.users` rows, and write the transcript/metadata caches through their
 * `SECURITY DEFINER` RPCs.
 *
 * Deliberately NOT annotated with an explicit return type: `createClient`'s generic defaults differ
 * from a bare `SupabaseClient`'s, and pinning the wider one is what produced an `no-unsafe-return`
 * here. `AdminClient` names whatever it actually returns, so every consumer agrees with it by
 * construction — the same shape `generate.db.int.test.ts` gets from its own inferred `const admin`.
 *
 * The URL is NOT re-checked for loopback here; `global-setup.ts` has already refused to let the suite
 * run against anything else, and a second copy of that guard is the one thing `registry.ts` argues
 * must never exist.
 */
export function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "e2e: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set. `npm run test:e2e` loads them " +
        "from `.env` — start the local stack (`npx supabase start`) and fill it in.",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export type AdminClient = ReturnType<typeof adminClient>;
