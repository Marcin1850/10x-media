# Rollout Phase 3 — Data-boundary authorization — Plan Brief

> Full plan: `context/changes/testing-phase-3-data-boundary/plan.md`
> Research: `context/changes/testing-phase-3-data-boundary/research.md`

## What & Why

`test-plan.md` risk #4 — one account's summaries or video list becoming reachable by another, or a client
reaching the user-agnostic shared caches at all — is the PRD's **only** stated guardrail, and it has
**zero** automated coverage today. It is not theoretical: a migration widening `service_role` on four
shared tables shipped one day ago (`d8f37f1`) and was reverted by human impl-review (`e0fdb0d`), not by
any test. This phase closes that gap with two new integration files and one boundary case.

**It also grew a fifth phase mid-flight.** The catalog invariant forced a re-verification of the cloud
project's privileges, and that pass found a live production divergence — `service_role` holds full DML
on all nine internal tables on cloud and none locally, because every migration's `revoke` names
`public, anon, authenticated` and stops. Phase 4 closes it. The enforcement point found an un-tightened
role on its first run, which is the argument for building it.

## Starting Point

Research mapped the whole surface and **inverted the phase's stated premise**. The shared caches added by
S-07/S-09 are not the hole — each carries RLS plus `revoke all from public, anon, authenticated` and zero
policies, which is strictly stronger than an owner-scoped policy. The client-reachable surface is exactly
three tables (`summaries`, `videos`, `user_credits`, all owner-scoped) and **zero** functions. The real
exposure is a *future* migration: the guard on new tables is a documented convention with **no
enforcement point**, and the local stack's default privileges hide a forgotten revoke that production
would expose. Nine test files exist; none asserts isolation, privileges, or policy behaviour.

## Desired End State

`npm run test:integration` — and the CI job `deploy` depends on — goes red when a migration adds an
unclassified table, drops a policy, widens a grant to `anon`/`authenticated`/`service_role`, exposes a
`public` function to a client role, or undoes the schema-wide `anon` default revoke. And a signed-in
account provably cannot list, read by id, or delete another account's rows — including through the
production embed shape and including two accounts submitting the same `requestId`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| "New table" half | Catalog invariant, not a behavioural probe | Locally an untightened table denies for the *wrong* reason while staying wide open on cloud, so only the catalog can express the property | Research |
| Oracle shape | Default-deny, hand-written roster | A generated snapshot takes its oracle from the implementation and is fixed with `--update` — the vibe-test failure mode §6.1 rules out | Plan |
| Roster completeness | A new table fails the suite even if correctly tightened | Forcing a conscious classification edit *is* the enforcement point the convention has never had | Plan |
| `service_role` DML | Assert none on the nine internal tables | The exact assertion that would have caught `20260904130000`; marked defence-in-depth since `service_role` bypasses RLS | Plan |
| `Dxtm` handling | Fails for `authenticated`, tolerated for `service_role` | It is the forgotten-revoke signal for one role and inherited local default for the other — asserting "zero privileges" would go red today | Research |
| Cloud divergence | Accept the gap + one-off manual prod read, recorded and dated | The per-table roster is environment-independent, but the 2026-07-14 claim the risk rests on deserves re-dating | Plan |
| Where the cloud record lives | Inline in `plan.md` ("Cloud verification pass"), not a separate file | A one-off verification with no consumer of its own belongs where the decisions it feeds already live | Implementation |
| Role assertions | `has_table_privilege` / `has_function_privilege`, not `aclexplode` | A function with no explicit ACL is EXECUTE-able by `PUBLIC` (grantee oid 0), which the ACL-array form cannot see — invariants 3 and 5 would have passed against the very regression they exist to catch | Implementation |
| The `service_role` divergence | Fix it in this change (Phase 4), not defer to a follow-up | Otherwise invariant 8 passes locally for a reason that does not obtain in production, and the coverage is illusory | Implementation |
| RLS session seam | Built per test from the cookie header via the app's own `createClient` | Round-trips through the real `parseCookieHeader`, so the session under test is production's; `synthetic-account.ts` stays unchanged | Plan |
| `readStoredSummary` | One boundary test, not a group | The only place application code, not RLS, is the trust boundary — an argument replaced by evidence | Research |
| `graphql_public` | Assert the schema holds no user objects | Exposed only by CLI default and used by nothing in the app; verified during planning as zero relations plus one non-extension-owned function, so no maintained exclusion list is needed | Plan |
| Migration changes | One, in Phase 4 only | Phases 1-3 add no SQL — harness needs must not widen production privileges; Phase 4's migration is the opposite, *narrowing* `service_role` to match documented intent, and no test needs it to pass | Implementation |

## Scope

**In scope:** a catalog-invariant test over `pg_class`/`pg_policy`/`pg_proc`/`pg_default_acl`; a
two-account policy probe with unfiltered reads through real sessions; one cross-account replay boundary
case; a dated cloud default-privilege record, inline in `plan.md`; one migration revoking `service_role`
on the nine internal tables; `test-plan.md` §6.3 + §6.6 + §6.2 correction + status; `CLAUDE.md` /
`AGENTS.md` / `README.md`; Linear MAR-21.

**Out of scope:** e2e and Playwright (test-rollout Phase 4); mutation testing (no application code under
test); every migration *except* Phase 4's `service_role` revoke — in particular revoking the
`authenticated` default schema-wide and dropping the `graphql_public` exposure both stay out; a test that
creates a table to observe default-privilege inheritance; changing `listSummaries` / `getBalance`;
refreshing `test-plan.md` §2 (already backported 2026-09-05).

## Architecture / Approach

```
        catalog layer                          behavioural layer
  ┌───────────────────────────┐        ┌──────────────────────────────────┐
  │ getDbOwnerConnection()    │        │ createSyntheticAccount(admin) ×2  │
  │   → pg_catalog (no grant) │        │   → cookieHeader                  │
  │                           │        │   → app's own createClient(...)   │
  │ committed roster:         │        │      = a real `authenticated`     │
  │   CLIENT_READABLE ∪       │        │        session, RLS applies       │
  │   INTERNAL                │        │                                   │
  │        = every public tbl │        │ seed rows via OWNER connection    │
  └───────────────────────────┘        │ assert via SESSION, UNFILTERED    │
      catches the NEXT migration       └──────────────────────────────────┘
                                            catches a policy regression
```

The two layers are complementary, not redundant: the catalog test cannot see whether a policy actually
filters, and the probe cannot see a table that does not exist yet.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Catalog invariant ✅ | `authorization-invariants.int.test.ts` + dated cloud record | The roster decays into a mirror of the catalog if entries lose their source citations |
| 2. Two-account policy probe | `cross-account-policy.int.test.ts` | Accidentally asserting through `listSummaries`/`getBalance`, whose `.eq("user_id", …)` masks the very regression under test |
| 3. Replay boundary case | One case in `generate.db.int.test.ts` | Two accounts in the paid-path harness — the first double-account teardown, where a leaked `auth.users` row aborts the *next* run |
| 4. `service_role` revoke | One migration + invariant 8's message | A **production** schema change whose local run proves nothing — the whole verification is `db push` plus a re-read of the cloud grants and one real generation |
| 5. Cookbook + docs + sync | §6.3, §6.6, §6.2 correction, status, `CLAUDE.md`/`AGENTS.md`/`README.md`, MAR-21 | `CLAUDE.md` and `AGENTS.md` silently diverging |

**Prerequisites:** local Supabase stack running (`npx supabase start`); all five env keys set; access to
the cloud project's SQL editor for Phase 1's manual step, and push rights for Phase 4.
**Estimated effort:** ~2 sessions across 5 phases; Phases 1 and 2 are the bulk, Phase 3 is one test,
Phase 4 is one statement with a real deploy behind it, Phase 5 is documentation.

## Open Risks & Assumptions

- **The roster costs a test edit per new table.** That is the deliverable, not a defect — but if it is
  ever treated as friction to route around, the phase's value goes with it.
- **The cloud half is verified once, by hand, and then goes stale.** The per-table roster is the
  environment-independent guard; a direct change to cloud default privileges outside a migration is not
  covered by anything.
- **The cloud read did find a divergence** (2026-09-06): `service_role` holds full DML on the nine
  internal tables in production. Not a guardrail breach — `service_role` bypasses RLS anyway and is
  server-only — but the defence-in-depth property `db-owner.ts` and §6.2 both assert has never held on
  cloud. Phase 4 closes it; until it lands, invariant 8 is environment-dependent.
- **Phase 4's migration is assumed behaviour-neutral on the strength of a static reading** — no
  `.from(<internal table>)` anywhere in `src/`/`scripts/`, and `SECURITY DEFINER` executes as the owner.
  A path research missed would fail only in production, which is why a real generation run is a manual
  criterion rather than a nicety.
- **Two concurrent synthetic accounts are unexercised today.** Nothing blocks them (fresh UUID email,
  per-call cookie jar), but Phase 2 is the first user, so double teardown is new ground.
- The `graphql_public` `graphql` function is assumed stable across pg_graphql upgrades on the strength of
  it not being extension-owned locally; a Supabase platform upgrade could still move it.
- **`graphql_public` stays exposed.** The app uses no GraphQL, so removing it from `config.toml` would
  break nothing — but that is a separate change requiring the cloud project's API settings to be updated
  in step, and is deliberately not folded into a testing phase.

## Success Criteria (Summary)

- A migration that adds a table, widens a client-role grant, or drops an owner-scoped policy fails CI
  instead of relying on a reviewer noticing — the `e0fdb0d` class of regression is caught by a test.
- A signed-in account provably cannot list, read by id, or delete another account's rows, proven through
  unfiltered reads on a real session rather than through a service function that filters anyway.
- `test-plan.md` §6.3 stops reading "TBD" and the next data-access test is written from the cookbook.
