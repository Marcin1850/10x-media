import { describe, expect, it } from "vitest";
import { getDbOwnerConnection } from "./db-owner";

/**
 * Data-boundary authorization — the CATALOG half of test-plan risk #4 (plan.md Phase 1).
 *
 * The behavioural half lives in `cross-account-policy.int.test.ts`: two real sessions, unfiltered
 * reads. This file asserts the *shape of the schema itself* — every grant, policy, RLS flag and
 * default privilege that decides who can reach what — against a hand-written, default-deny roster
 * committed below.
 *
 * **Why a roster and not a snapshot.** A generated snapshot's oracle would be the current catalog,
 * and the fix for a red run would be `--update` — the vibe-test failure mode test-plan §6.1 rules
 * out. Each roster entry instead cites the source that justifies it: the PRD privacy guardrail
 * (`prd.md:37`, `prd.md:73`, `prd.md:92`) and each table's own migration intent. Adding a table
 * therefore forces a conscious edit here. That maintenance cost IS the deliverable: it is the
 * enforcement point the per-table tightening convention has never had
 * (`20260714140000_assert_least_privilege_functions.sql:36-40`, research.md §5).
 *
 * **The failure this exists to catch is a future migration, and it already happened once.**
 * `20260904130000_test_support_grants.sql` granted `service_role` direct SELECT/DELETE on four
 * internal tables so a test harness could bypass their `SECURITY DEFINER` RPCs. It shipped in
 * `d8f37f1` and was reverted in `e0fdb0d` by human impl-review — no test caught it. Invariant 8
 * would have.
 *
 * **Invariant 8 was environment-dependent until 2026-09-06, and closing that gap is what turned it
 * into coverage.** The cloud pass Phase 1 forced (plan.md, "Cloud verification pass", 2026-09-06)
 * found `service_role` holding all four DML verbs on all nine internal tables in production and none
 * locally. Cause: every internal table's migration revokes from `public, anon, authenticated` and
 * stops there, which suffices only against the local default of `Dxtm`; the cloud default hands
 * `service_role` `arwdDxtm`, so the privilege survived. Invariant 8 therefore passed here for a
 * reason that did not obtain there, and the intent recorded in `db-owner.ts:6-11` and test-plan §6.2
 * described the local stack only. `20260906120000_revoke_service_role_internal_tables.sql` closed
 * it. The assertion below did not change — it always asserted the right thing; what changed is that
 * production now satisfies it too, so a red run means the same thing in both environments. The rule
 * this shares with the implicit-ACL finding above: an invariant that holds because of a *default*
 * privilege pins only the environment it runs in, so the guarantee has to be carried by the
 * per-object assertions.
 *
 * **This test applies no privilege pressure of its own** — the mistake `d8f37f1` made. It reads
 * `pg_class` / `pg_policy` / `pg_proc` / `pg_default_acl` / `pg_namespace` through
 * `getDbOwnerConnection()` (`db-owner.ts:22`), and `pg_catalog` needs no grant. It creates nothing,
 * grants nothing, and needs no cleanup; `fetch-firewall.ts`'s `afterAll` closes the owner pool.
 *
 * **Effective privileges, not ACL arrays.** Every role assertion below goes through
 * `has_table_privilege` / `has_function_privilege` rather than `aclexplode(relacl)`. The two differ
 * exactly where it matters: a function created without an explicit `revoke` lands with
 * `proacl = NULL`, which means EXECUTE **to PUBLIC** — verified on this stack, and NOT visible to an
 * `aclexplode` query joined to `pg_roles`, because PUBLIC is grantee oid 0. All 24 current `public`
 * functions carry explicit ACLs, so invariant 5 is green today; it goes red the moment a migration
 * adds a function and forgets its `revoke all ... from public, anon, authenticated`.
 *
 * **Environment boundary — read this before trusting invariant 9.** Invariant 9 pins the *local*
 * default ACL only. Cloud diverges: `20260714140000:8-16` records that the cloud project grants
 * `authenticated` ALL on new tables while the local stack grants only `Dxtm`
 * (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN — no DML). Re-verified against the cloud project on
 * 2026-09-06 and recorded in `context/changes/testing-phase-3-data-boundary/plan.md`, "Cloud
 * verification pass" — where it turned out to be wider than the migration says: cloud also grants
 * `authenticated` EXECUTE on new *functions*, which local defaults do not. What makes that
 * gap tolerable is that invariants 1 and 4 are environment-independent: a table added without its
 * per-table tightening shows a stray `Dxtm` for `authenticated` locally and full CRUD on cloud, and
 * either way invariant 4 goes red. Note also that the local `pg_default_acl` carries a second,
 * *stronger* row — grantor `supabase_admin`, which grants `anon` ALL — that invariant 9 deliberately
 * ignores: migrations run as `postgres`, so only the `postgres` grantor's defaults apply to them.
 *
 * **Every function assertion is scoped to schema `public` — do not widen it.**
 * `graphql_public.graphql()` IS EXECUTE-able by `anon` and `authenticated` by design; that is how the
 * GraphQL endpoint the CLI exposes by default (`supabase/config.toml:13`) is reached at all. A query
 * without an `nspname = 'public'` filter goes red on invariants 3 and 5 for a reason that is not a
 * finding. The app uses no GraphQL, and pg_graphql resolves through the same `public` grants and RLS
 * — a second door onto the same room, with the same locks. The residual worth pinning is only that no
 * *object* appears in `graphql_public`, where `supabase_admin`'s default ACLs would grant
 * `anon`/`authenticated` ALL; invariant 9 covers that.
 */

// ---------------------------------------------------------------------------------------------------
// The roster — the oracle. Sourced from the PRD guardrail and each table's own migration, never from
// reading the current catalog.
// ---------------------------------------------------------------------------------------------------

/**
 * Tables a signed-in browser session may reach at all, with the exact verbs `authenticated` holds.
 * Each is additionally gated by an owner-scoped `auth.uid() = user_id` policy (invariants 6 and 7).
 * The INSERT/UPDATE halves were dropped deliberately — for provenance, not isolation
 * (`20260726120000_videos_single_writer.sql:11`, `20260731130000_summaries_single_writer.sql:9`).
 */
const CLIENT_READABLE: Record<string, readonly string[]> = {
  // `20260613145120_videos_and_summaries.sql:4`; narrowed to select+delete by `20260726120000:25-37`.
  videos: ["DELETE", "SELECT"],
  // `20260613145120_videos_and_summaries.sql:34`; narrowed to select+delete by `20260731130000:27-39`.
  summaries: ["DELETE", "SELECT"],
  // `20260712175240_user_credits.sql:5,13-19` — read-only by design; balance is written by RPC only.
  user_credits: ["SELECT"],
};

/**
 * Deny-by-privilege tables: RLS on, **zero policies**, and `revoke all ... from public, anon,
 * authenticated`. Strictly stronger than an owner-scoped policy — a client is refused at the
 * privilege layer and RLS is never consulted. Reached only through `SECURITY DEFINER` RPCs on the
 * service-role client (research.md §6). `authenticated` must hold NOTHING on these.
 */
const INTERNAL: readonly string[] = [
  "generation_locks", // 20260720133000_generation_locks.sql:23,25
  "credit_reservations", // 20260720160000_credit_reservations.sql:33,35
  "transcript_fetch_attempts", // 20260722130000_transcript_spend_guards.sql:25,26
  "transcript_quotes", // 20260722130000_transcript_spend_guards.sql:88,89
  "transcript_cache", // 20260728120000_generation_telemetry.sql:83,84
  "supadata_calls", // 20260728120000_generation_telemetry.sql:120,121
  "metadata_cache", // 20260731120000_metadata_cache.sql:70,71
  "supadata_budget", // 20260731150000_supadata_budget.sql:140,141
  "supadata_reservations", // 20260731150000_supadata_budget.sql:217,218
];

const ROSTER = [...Object.keys(CLIENT_READABLE), ...INTERNAL].sort();

/** Every table-level privilege PostgreSQL 17 knows. `MAINTAIN` is 17-only; `config.toml:36` pins 17. */
const TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
] as const;

/** The four verbs that move rows. The rest (`Dxtm`) is what the local defaults hand out — see invariant 8. */
const DML_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** `pg_policy.polcmd` codes. `*` is `for all`, which the roster deliberately has no shape for. */
const POLICY_COMMANDS: Record<string, string> = {
  r: "SELECT",
  a: "INSERT",
  w: "UPDATE",
  d: "DELETE",
  "*": "ALL",
};

/** The one thing every policy on a client-readable table must say (research.md §2). */
const OWNER_SCOPED_QUAL = "auth.uid()=user_id";

// ---------------------------------------------------------------------------------------------------
// Catalog reads. Anything that can carry a table privilege counts as a relation here — a view or
// materialized view in `public` would bypass RLS just as effectively as a table, so it must be
// classified in the roster too, not only base tables.
// ---------------------------------------------------------------------------------------------------

const sql = getDbOwnerConnection();

interface RelationRow {
  relname: string;
  relkind: string;
  relrowsecurity: boolean;
}

function publicRelations() {
  return sql<RelationRow[]>`
    select c.relname, c.relkind::text as relkind, c.relrowsecurity
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
    order by c.relname
  `;
}

/** Effective privileges per relation for one role — resolves PUBLIC grants and role membership. */
async function effectiveTablePrivileges(role: string): Promise<Map<string, string[]>> {
  const rows = await sql<{ relname: string; privilege: string }[]>`
    select c.relname, v.privilege
    from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      cross join unnest(${[...TABLE_PRIVILEGES]}::text[]) as v(privilege)
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and has_table_privilege(${role}, c.oid, v.privilege)
    order by c.relname, v.privilege
  `;

  const byRelation = new Map<string, string[]>();
  for (const row of rows) {
    const held = byRelation.get(row.relname) ?? [];
    held.push(row.privilege);
    byRelation.set(row.relname, held);
  }
  return byRelation;
}

/** Signatures of `public` functions the role can EXECUTE — including via an implicit PUBLIC grant. */
async function functionsExecutableBy(role: string): Promise<string[]> {
  const rows = await sql<{ signature: string }[]>`
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature
    from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
    where has_function_privilege(${role}, p.oid, 'EXECUTE')
    order by 1
  `;
  return rows.map((row) => row.signature);
}

interface PolicyRow {
  relname: string;
  polname: string;
  polcmd: string;
  roles: string[];
  qual: string | null;
}

function publicPolicies() {
  return sql<PolicyRow[]>`
    select c.relname,
           p.polname,
           p.polcmd::text as polcmd,
           coalesce(
             (select array_agg(r.rolname order by r.rolname) from pg_roles r where r.oid = any(p.polroles)),
             array['PUBLIC']
           ) as roles,
           pg_get_expr(p.polqual, p.polrelid) as qual
    from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    order by c.relname, p.polname
  `;
}

/** Whitespace- and parenthesis-insensitive form of a policy `using` clause. */
function normalizeQual(qual: string | null): string {
  if (qual === null) return "";
  let normalized = qual.replace(/\s+/g, "");
  while (normalized.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1);
  }
  return normalized;
}

// ---------------------------------------------------------------------------------------------------
// The invariants.
// ---------------------------------------------------------------------------------------------------

describe("public schema authorization invariants", () => {
  it("1. every relation in public is classified in the roster", async () => {
    const relations = await publicRelations();
    const actual = relations.map((relation) => relation.relname).sort();

    expect(
      actual,
      "A relation in `public` is not classified in this file's roster (or a classified one vanished). " +
        "Classify it: add it to CLIENT_READABLE with the exact verbs `authenticated` needs and an " +
        "owner-scoped policy, or to INTERNAL — and confirm its migration runs `revoke all on table " +
        "public.<name> from public, anon, authenticated`. This assertion is the enforcement point for " +
        "the per-table tightening convention (20260714140000:36-40): on cloud, a new table without that " +
        "revoke lands with full CRUD for `authenticated`.",
    ).toEqual(ROSTER);
  });

  it("2. row level security is enabled on every relation in public", async () => {
    const relations = await publicRelations();
    const withoutRls = relations.filter((relation) => !relation.relrowsecurity).map((r) => r.relname);

    expect(
      withoutRls,
      "Relation(s) in `public` have RLS disabled. A new table lands with RLS OFF in both environments — " +
        "add `alter table public.<name> enable row level security;` to its migration. This signal is " +
        "environment-independent, unlike the default-privilege half.",
    ).toEqual([]);
  });

  it("3. anon holds no privilege on any relation or function in public", async () => {
    const [tables, functions] = await Promise.all([effectiveTablePrivileges("anon"), functionsExecutableBy("anon")]);

    expect(
      Object.fromEntries(tables),
      "`anon` — the role an unauthenticated request runs as — holds a table privilege in `public`. " +
        "Every path in this app requires authentication (20260714140000:33-35). Revoke it in a " +
        "migration: `revoke all on table public.<name> from anon;`",
    ).toEqual({});

    expect(
      functions,
      "`anon` can EXECUTE a `public` function. A SECURITY DEFINER function runs as its owner and " +
        "bypasses RLS entirely, so one taking a user_id would be a direct cross-account read " +
        "(20260714140000:18-22). Note a function created with no explicit ACL is EXECUTE-able by " +
        "PUBLIC, which includes `anon` — add `revoke all on function public.<name>(...) from public, " +
        "anon, authenticated;` to its migration.",
    ).toEqual([]);
  });

  it("4. authenticated's effective table privileges equal the roster exactly", async () => {
    const held = await effectiveTablePrivileges("authenticated");

    const expected: Record<string, string[]> = {};
    for (const [table, privileges] of Object.entries(CLIENT_READABLE)) {
      expected[table] = [...privileges].sort();
    }

    const actual: Record<string, string[]> = {};
    for (const [table, privileges] of held) {
      actual[table] = [...privileges].sort();
    }

    expect(
      actual,
      "`authenticated`'s privileges diverge from the roster. A table listed in INTERNAL must show NO " +
        "entry at all. A stray `MAINTAIN/REFERENCES/TRIGGER/TRUNCATE` set means the migration that " +
        "created the table never ran its `revoke all ... from public, anon, authenticated` — locally " +
        "that grants no DML, but the SAME omission on the cloud project grants full CRUD " +
        "(20260714140000:8-16). Add the revoke, or, if the grant is intended, widen CLIENT_READABLE " +
        "here and give the verb a matching owner-scoped policy.",
    ).toEqual(expected);
  });

  it("5. authenticated can EXECUTE no function in public", async () => {
    const functions = await functionsExecutableBy("authenticated");

    expect(
      functions,
      "`authenticated` can EXECUTE a `public` function. No RPC is client-callable today — the last " +
        "three were dropped in 20260724120000_drop_legacy_rpcs.sql:15-20 — and every one of these " +
        "functions is SECURITY DEFINER, so a client-callable one bypasses RLS by construction. A " +
        "function created with no explicit ACL is EXECUTE-able by PUBLIC; add `revoke all on function " +
        "public.<name>(...) from public, anon, authenticated;` to its migration.",
    ).toEqual([]);
  });

  it("6. every verb granted to authenticated has exactly one matching policy, and no policy exists beyond them", async () => {
    const policies = await publicPolicies();

    const expected = Object.entries(CLIENT_READABLE)
      .flatMap(([table, privileges]) => privileges.map((verb) => `${table}:${verb}`))
      .sort();

    const actual = policies
      .map((policy) => {
        const command = POLICY_COMMANDS[policy.polcmd] ?? `UNKNOWN(${policy.polcmd})`;
        const roles = policy.roles.join("+");
        return roles === "authenticated" ? `${policy.relname}:${command}` : `${policy.relname}:${command}@${roles}`;
      })
      .sort();

    expect(
      actual,
      "Policies and grants have diverged. Each `${table}:${verb}` pair granted to `authenticated` needs " +
        "one policy `for` that command `to authenticated` — a granted verb with no policy reads/writes " +
        "unfiltered, and a policy for a verb nobody holds is dead weight that hides intent. An entry " +
        "carrying `@<roles>` is a policy targeted at something other than `authenticated` alone; an " +
        "`ALL` entry is a `for all` policy, which must be split per command so this roster can express " +
        "it. Fix the migration, or update CLIENT_READABLE if the grant itself changed.",
    ).toEqual(expected);
  });

  it("7. every policy's using clause is owner-scoped", async () => {
    const policies = await publicPolicies();
    const quals = Object.fromEntries(
      policies.map((policy) => [`${policy.relname}.${policy.polname}`, normalizeQual(policy.qual)]),
    );

    const expected = Object.fromEntries(Object.keys(quals).map((name) => [name, OWNER_SCOPED_QUAL]));

    expect(
      quals,
      "A policy's `using` clause is not `auth.uid() = user_id`. That expression IS the privacy " +
        "guardrail (prd.md:37, prd.md:73, prd.md:92) — it is what makes one account's rows invisible to " +
        "another. Anything broader (`true`, a subquery, a join) opens cross-account reads. Comparison " +
        "ignores whitespace and outer parentheses only.",
    ).toEqual(expected);
  });

  it("8. service_role holds no DML on the internal tables", async () => {
    const held = await effectiveTablePrivileges("service_role");

    const dml = Object.fromEntries(
      INTERNAL.map((table) => [
        table,
        (held.get(table) ?? []).filter((privilege) => (DML_PRIVILEGES as readonly string[]).includes(privilege)),
      ]),
    );

    const expected = Object.fromEntries(INTERNAL.map((table) => [table, []]));

    expect(
      dml,
      "`service_role` gained direct DML on an internal table. These are reached exclusively through " +
        "SECURITY DEFINER RPCs; a direct grant widens what the production request-path secret can do. " +
        "This is exactly what 20260904130000_test_support_grants.sql did for a test harness's " +
        "convenience (`d8f37f1`, reverted in `e0fdb0d`) — reach around the boundary with " +
        "`getDbOwnerConnection()` instead of widening it. Defence in depth, not the PRD guardrail: " +
        "`service_role` carries rolbypassrls anyway. Only SELECT/INSERT/UPDATE/DELETE are asserted — " +
        "`service_role` legitimately inherits MAINTAIN/REFERENCES/TRIGGER/TRUNCATE from the local " +
        "defaults on all nine (research.md §1, precision note), so a zero-privileges assertion would go " +
        "red today for the wrong reason. THIS INVARIANT ONLY BECAME ENVIRONMENT-INDEPENDENT ON " +
        "2026-09-06: until 20260906120000_revoke_service_role_internal_tables.sql it passed here for a " +
        "reason that did not obtain on cloud, where the default privileges had handed `service_role` " +
        "all four verbs on all nine tables and no migration's `revoke ... from public, anon, " +
        "authenticated` ever named it. A new internal table must revoke from `service_role` too.",
    ).toEqual(expected);
  });

  it("9. anon is excluded from public's default privileges and graphql_public is empty", async () => {
    const [defaults, relations, functions] = await Promise.all([
      sql<{ objtype: string; acl: string }[]>`
        select d.defaclobjtype::text as objtype, d.defaclacl::text as acl
        from pg_default_acl d
          join pg_namespace n on n.oid = d.defaclnamespace and n.nspname = 'public'
        where d.defaclrole = 'postgres'::regrole
        order by 1
      `,
      sql<{ relname: string }[]>`
        select c.relname
        from pg_class c
          join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'graphql_public'
        order by 1
      `,
      sql<{ signature: string }[]>`
        select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature
        from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'graphql_public'
        order by 1
      `,
    ]);

    const mentioningAnon = defaults.filter((row) => row.acl.includes("anon=")).map((row) => row.objtype);

    expect(
      mentioningAnon,
      "The schema-wide `anon` default-privilege revoke has been undone. " +
        "20260714140000:41-43 revokes tables, sequences and functions from `anon` for role `postgres` " +
        "(the role migrations run as) so the cloud defaults cannot re-grant ALL to `anon` on every " +
        "future object. Re-apply it in a migration. Scoped to grantor `postgres` on purpose: the " +
        "`supabase_admin` default ACLs in this schema do grant `anon` ALL, but they do not apply to " +
        "objects migrations create.",
    ).toEqual([]);

    expect(
      relations,
      "An object appeared in `graphql_public`. That schema's `supabase_admin` default ACLs grant " +
        "`anon` and `authenticated` ALL on anything created there, so it is not covered by any of the " +
        "`public`-scoped invariants above. Keep it empty, or close the exposure deliberately " +
        "(supabase/config.toml:13 — and mirror it in the cloud project's API settings, or it becomes " +
        "the local/cloud divergence this file exists to pin down).",
    ).toEqual([]);

    expect(
      functions,
      "`graphql_public`'s function surface changed. Exactly one function belongs there — pg_graphql's " +
        "entry point, which is EXECUTE-able by `anon`/`authenticated` by design and resolves through " +
        "the same `public` grants and RLS asserted above. Anything else is a new door.",
    ).toEqual([{ signature: 'graphql("operationName" text, query text, variables jsonb, extensions jsonb)' }]);
  });
});
