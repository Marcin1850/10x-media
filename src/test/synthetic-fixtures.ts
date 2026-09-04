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
 * it here first. Empty in Phase 2 — no test yet seeds either cache.
 */
export const RESERVED_YOUTUBE_IDS: readonly string[] = [];
