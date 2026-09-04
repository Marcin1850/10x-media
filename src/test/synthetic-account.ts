import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDbOwnerConnection } from "./db-owner";

/**
 * Synthetic-account harness for the real-database layer (plan Phase 5).
 *
 * Every identifier here is synthetic — a fresh `auth.users` row created and deleted within one test,
 * never a real address or id (`lessons.md`, "Never commit account identifiers from a real-environment
 * pass"). The account starts with whatever `on_auth_user_created` grants (5 credits,
 * `20260712175240_user_credits.sql:36`) — callers must NOT set the initial balance by hand, or the
 * test stops proving the documented starting value. A scenario that needs a DIFFERENT balance (the
 * insufficient-credit case) adjusts it explicitly afterward, which is a distinct, later step.
 *
 * Signs in through the SAME `createServerClient` the app's own `@/lib/supabase.ts` uses, against a
 * real in-memory cookie jar, so the resulting Cookie header round-trips through the app's real cookie
 * parsing (`parseCookieHeader`) exactly as a browser's would — this is what makes the real-database
 * layer prove the RLS-scoped `getBalance` read, not an injected stand-in for it.
 */

/**
 * Every synthetic account's email starts with this. Shared with `integration-setup.ts`'s stale-account
 * guard so the two can never drift apart — a hard-killed run's orphaned `auth.users` row is only
 * findable if the guard looks for exactly the prefix accounts are actually created with.
 */
export const SYNTHETIC_ACCOUNT_EMAIL_PREFIX = "synthetic-db-int-";

export interface SyntheticAccount {
  userId: string;
  /** `name=value; name2=value2` — feed this to a request's `Cookie` header. */
  cookieHeader: string;
  /**
   * Deletes `supadata_calls` rows for the given youtube ids FIRST (`on delete set null` means they
   * would otherwise survive the account and orphan into the ledger — research.md §5, plan's "Critical
   * Implementation Details"), then deletes the `auth.users` row, whose cascade removes everything else
   * per-user (`user_credits`, `credit_reservations`, `videos`, `summaries`, generation locks/limits).
   * The `supadata_calls` delete goes through the table-owner connection (`db-owner.ts`), not
   * `service_role` — that table deliberately grants `service_role` no direct privileges (impl-review.md F2).
   */
  dispose: (youtubeIds?: readonly string[]) => Promise<void>;
}

interface CookieJarEntry {
  name: string;
  value: string;
}

/**
 * Creates one synthetic account, signs it in, and returns what a test needs to drive the endpoint as
 * that user. `admin` must be a real service-role client against the local stack — the guard in
 * `integration-setup.ts` has already refused to run this suite against anything else.
 */
export async function createSyntheticAccount(admin: SupabaseClient): Promise<SyntheticAccount> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "synthetic-account: SUPABASE_URL and SUPABASE_KEY must both be set (the real local-stack values, " +
        "not the stub layer's placeholders) to sign a synthetic account in.",
    );
  }

  const email = `${SYNTHETIC_ACCOUNT_EMAIL_PREFIX}${crypto.randomUUID()}@local.test`;
  const password = crypto.randomUUID();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) {
    throw new Error(`synthetic-account: failed to create user: ${createError.message}`);
  }
  const userId = created.user.id;

  let jar: CookieJarEntry[] = [];
  const signInClient = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => jar,
      setAll: (cookiesToSet) => {
        for (const { name, value } of cookiesToSet) {
          jar = jar.filter((entry) => entry.name !== name);
          if (value) jar.push({ name, value });
        }
      },
    },
  });

  const { error: signInError } = await signInClient.auth.signInWithPassword({ email, password });
  if (signInError) {
    await admin.auth.admin.deleteUser(userId);
    throw new Error(`synthetic-account: failed to sign in as ${email}: ${signInError.message}`);
  }
  if (jar.length === 0) {
    await admin.auth.admin.deleteUser(userId);
    throw new Error("synthetic-account: sign-in produced no session cookies to build a Cookie header from");
  }

  const cookieHeader = jar.map(({ name, value }) => `${name}=${value}`).join("; ");

  return {
    userId,
    cookieHeader,
    async dispose(youtubeIds = []) {
      if (youtubeIds.length > 0) {
        const sql = getDbOwnerConnection();
        const ids = [...youtubeIds];
        await sql`delete from supadata_calls where youtube_id in ${sql(ids)}`;
      }
      await admin.auth.admin.deleteUser(userId);
    },
  };
}
