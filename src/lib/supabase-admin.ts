import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "astro:env/server";

/**
 * Server-only Supabase client authenticated with the service-role key.
 *
 * The service-role key bypasses RLS, so this client is omnipotent — it must
 * NEVER be imported into a React island or `.astro` frontmatter that reaches
 * the browser. It is deliberately isolated from the cookie-based SSR client
 * (`@/lib/supabase`): it never reads or writes the user's session cookies.
 *
 * Returns `null` when either secret is unset so callers can fail-safe (503).
 */
export function createAdminClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
