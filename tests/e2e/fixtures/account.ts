import { createSyntheticAccount } from "@/test/synthetic-account";
import { adminClient, type AdminClient } from "./admin";
import { closeDbOwnerConnection } from "@/test/db-owner";
import { noSentryTest as base } from "./no-sentry";
import { E2E_ACCOUNT_EMAIL_PREFIX } from "./registry";

/**
 * Auth for the e2e layer: a fresh signed-in account per test, without ever driving the sign-in form.
 *
 * **Why per-test and not `storageState`** (user decision, 2026-09-08). The obvious Playwright pattern
 * — sign in once in a `setup` project, share the session file — does not fit, because the dimension
 * these specs vary is the credit BALANCE, and the balance is state the specs themselves spend. Phase 3
 * wants an account at 1 credit, Phase 4 at 2+, and each oracle is a ledger DELTA for its own
 * `user_id`; one shared account gives one balance, mutated by whichever spec ran first, which stops
 * being deterministic the moment a second spec — or a second `--repeat-each` iteration — debits it.
 *
 * The rule that actually mattered is kept: the sign-in FORM is never driven. `createSyntheticAccount`
 * signs in from the Node process through the app's own `createServerClient`, and the resulting cookies
 * go to the browser context via `addCookies` — the same cookies a real sign-in would have set. The
 * cost is two loopback round-trips per test (bcrypt-dominated), not a browser session.
 */

export interface E2eAccount {
  readonly userId: string;
  /**
   * Sets an EXACT balance, for a spec that needs one. Deliberately a separate, explicit step rather
   * than a creation parameter: the account's initial 5 comes from the `on_auth_user_created` trigger
   * (`20260712175240_user_credits.sql`), and a spec that silently overwrote it would stop proving the
   * documented starting value. The pattern is `generate.db.int.test.ts:314-318`'s.
   */
  setBalance(balance: number): Promise<void>;
  /**
   * Registers a youtube id this test touched, so teardown deletes `supadata_calls` rows for it BEFORE
   * the `auth.users` row. That column is `on delete set null`, so a row deleted in the other order
   * survives the account and orphans into exactly the ledger the test-plan's risk #2 sums. Called for
   * you by the `seedVideo` fixture — a spec seeding a cache by hand must call it itself.
   */
  trackYoutubeId(youtubeId: string): void;
}

export interface E2eAccountOptions {
  /**
   * Balance to force before the test body runs, or `null` (default) to leave the trigger's grant of 5
   * untouched. Set per file or per describe with `test.use({ accountCredits: 1 })`.
   */
  accountCredits: number | null;
}

interface WorkerFixtures {
  /**
   * Closes the table-owner Postgres connection when the worker finishes. `db-owner.ts` is deliberately
   * runner-agnostic (it is also imported by two `globalSetup`s that run outside any hook context), so
   * every consumer closes it explicitly; without this the worker would exit holding an open socket.
   */
  dbOwnerConnectionLifecycle: undefined;
}

/**
 * The auth layer of the spec fixture stack. Specs do not import this directly — they import the
 * composed `test` from `./test`, which adds cache seeding on top.
 *
 * It extends `noSentryTest` rather than Playwright's own `test`, so the "no e2e run reports to
 * Sentry" watch is on every spec in the suite by construction — there is no opt-in step a new spec
 * can forget.
 */
export const accountTest = base.extend<E2eAccountOptions & { account: E2eAccount }, WorkerFixtures>({
  accountCredits: [null, { option: true }],

  dbOwnerConnectionLifecycle: [
    // Playwright parses this parameter's destructuring pattern to work out a fixture's dependencies
    // and rejects anything else ("First argument must use the object destructuring pattern"), so an
    // empty pattern is how "depends on nothing" is spelled here.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(undefined);
      await closeDbOwnerConnection();
    },
    { scope: "worker", auto: true },
  ],

  account: async ({ context, baseURL, accountCredits }, use) => {
    const admin = adminClient();
    const account = await createSyntheticAccount(admin, E2E_ACCOUNT_EMAIL_PREFIX);
    const touchedYoutubeIds = new Set<string>();

    // The `try` opens HERE, not just before `use` — the `auth.users` row exists from the line above, so
    // every step after it is already cleanup-relevant. Cookie injection and `setBalance` can both
    // reject, and a rejection between creation and the old `try` left the row behind for the NEXT run's
    // stale-account guard to find, long after the run that caused it (impl-review F4). Matches the
    // integration helpers, which open their `try` immediately after creation for the same reason.

    try {
      /**
       * Two cookie facts have to be right SIMULTANEOUSLY or the session silently does not exist — the
       * app just renders signed-out and the failure looks like a routing bug:
       *
       *  - The cookie NAME derives from the SUPABASE hostname, not the app's: `@supabase/ssr` defaults
       *    to `sb-${hostname.split(".")[0]}-auth-token`, so a local stack at `127.0.0.1:54321` produces
       *    `sb-127-auth-token`. Nothing here hardcodes that — the names come from the jar the app's own
       *    client just filled, which is the only copy that cannot be wrong. Values above ~3180 chars
       *    arrive CHUNKED as `.0`, `.1`, …, and every chunk is a separate cookie that must be added;
       *    iterating the jar gets that right for free.
       *  - The cookie carries NO `domain`, so it is scoped to the host the browser navigates —
       *    `localhost:4321`, not the Supabase host. Passing `url` lets Playwright derive domain and path
       *    from `baseURL` rather than restating them.
       */
      if (!baseURL) throw new Error("e2e account fixture: `use.baseURL` must be set in playwright.config.ts.");
      await context.addCookies(
        account.cookies.map(({ name, value }) => ({
          name,
          value,
          url: baseURL,
          sameSite: "Lax" as const,
          httpOnly: false,
        })),
      );

      if (accountCredits !== null) {
        await setBalance(admin, account.userId, accountCredits);
      }

      await use({
        userId: account.userId,
        setBalance: (balance) => setBalance(admin, account.userId, balance),
        trackYoutubeId: (youtubeId) => touchedYoutubeIds.add(youtubeId),
      });
    } finally {
      // `dispose()` throws by design (impl-review F3) and this deliberately does NOT swallow it: a
      // swallowed failure leaks an `auth.users` row that only the NEXT run's stale-account guard
      // notices, by which point the run that caused it is long gone.
      await account.dispose([...touchedYoutubeIds]);
    }
  },
});

async function setBalance(admin: AdminClient, userId: string, balance: number): Promise<void> {
  const { error } = await admin.from("user_credits").update({ balance }).eq("user_id", userId);
  if (error) throw new Error(`e2e account fixture: failed to set balance to ${balance}: ${error.message}`);
}
