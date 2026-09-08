/**
 * Registry of synthetic identifiers the **e2e** suite reserves against the local database.
 *
 * Deliberately DISJOINT from `src/test/synthetic-fixtures.ts` and `SYNTHETIC_ACCOUNT_EMAIL_PREFIX`,
 * a consequence accepted at planning: `integration-setup.ts`'s sweep will never see an e2e leak, and
 * this file's sweep will never see an integration one. That is the point — the two suites can be run
 * in either order, or at the same time, without one aborting on state the other legitimately owns.
 * The cost is that a leak is only caught by the suite that caused it, which is also who should fix it.
 *
 * The one thing the e2e layer does NOT re-implement is the loopback guard: `global-setup.ts` imports
 * `assertLoopbackSupabaseUrl` from `src/test/integration-setup.ts`. Registries are separate on
 * purpose; the guard that makes either suite safe to run at all is shared on purpose.
 *
 * Every spec that seeds `transcript_cache` or `metadata_cache` must register its id here FIRST —
 * `global-setup.ts` checks these ids are absent before any spec runs, so a row left by a hard-killed
 * run aborts the next run instead of silently making a later spec's cache-hit assumption true for
 * the wrong reason.
 */

/**
 * Ids are synthetic, never a real YouTube id: seeding a cache under a real id would put fabricated
 * transcript text under a real video, and a leaked row would then answer a real user's request from
 * it (impl-review F1, `lessons.md`). They still have to satisfy `extractYoutubeId`'s
 * `^[a-zA-Z0-9_-]{11}$` — the endpoint rejects anything else before it ever reaches a cache.
 */
export const E2E_YOUTUBE_IDS = {
  /** `generate-summary.spec.ts` (Phase 2) — a short `ok` transcript: the happy flow, cost 1. */
  seedHappyPath: "e2eseed0001",
  /** `charged-refusal.spec.ts` (Phase 3) — a cached `unavailable` transcript: no caption track, charged 422. */
  refusalNoCaptions: "e2erefusal1",
  /** `charged-refusal.spec.ts` (Phase 3) — a cached `empty` transcript: captions with no words, charged 422. */
  refusalEmpty: "e2erefusal2",
  /** `long-video-confirmation.spec.ts` (Phase 4) — an `ok` transcript over `LONG_TRANSCRIPT_CHARS`: cost 2. */
  longVideo: "e2elongvid1",
} as const;

export const E2E_RESERVED_YOUTUBE_IDS: readonly string[] = Object.values(E2E_YOUTUBE_IDS);

/**
 * Every e2e synthetic account's email starts with this. Distinct from `synthetic-db-int-` so the two
 * suites' stale-account sweeps see only their own leaks — see the file header.
 */
export const E2E_ACCOUNT_EMAIL_PREFIX = "synthetic-e2e-";
