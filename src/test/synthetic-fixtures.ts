/**
 * Registry of synthetic identifiers the integration suite reserves against the local database.
 *
 * `transcript_cache` and `metadata_cache` are user-agnostic (keyed by video id, no owner column —
 * research.md §6), so nothing scopes cleanup to a single test run the way a synthetic account does.
 * `integration-setup.ts`'s `globalSetup` checks these ids are absent before any test runs, catching
 * rows an earlier interrupted run left behind before a later test's breaker-bypass assumptions (a
 * cache hit skips the budget check entirely — research.md §6) get built on a false premise.
 *
 * Every phase that seeds `transcript_cache` or `metadata_cache` with a synthetic video id must add
 * it here first. Populated in Phase 5 — one id per `generate.db.int.test.ts` scenario, each of which
 * seeds and then cleans up both caches for its own id (never shared across tests).
 *
 * Conversely, a synthetic id that never reaches either cache does NOT belong here — the omission is
 * the correct state, not an oversight. `cross-account-policy.int.test.ts`'s `xacct*` ids are the
 * standing example: they exist only on per-user `videos`/`summaries` rows, which leave with
 * `dispose()`'s `auth.users` cascade, so a guard keyed on them would watch a table they never touch.
 */
export const DB_LAYER_YOUTUBE_IDS = {
  success: "sdbtest0001",
  llmFailure: "sdbtest0002",
  persistFailure: "sdbtest0003",
  insufficientLong: "sdbtest0004",
  replay: "sdbtest0005",
  chargedRefusalReplay: "sdbtest0006",
  exit34SweepRefunded: "sdbtest0007",
  exit34OperatorSettled: "sdbtest0008",
  exit34AlreadyPersisted: "sdbtest0009",
  crossAccountReplay: "sdbtest0010",
  chargedRefusalBalance: "sdbtest0011",
} as const;

export const RESERVED_YOUTUBE_IDS: readonly string[] = Object.values(DB_LAYER_YOUTUBE_IDS);
