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
  /**
   * `long-video-confirmation.spec.ts` (Phase 4) — a SECOND `ok` transcript over the threshold, so the
   * spec can prove a quote does not transfer between videos. It has to be long as well: the assertion
   * is that switching the URL withdraws the confirmed price and the new video gets its own 409, which
   * a short video would answer by generating (and charging) instead.
   */
  longVideoSwitched: "e2elongvid2",
} as const;

/**
 * The ids above, as a type. `seedVideo.seed` accepts only this, so a typo or an invented id is a
 * compile error rather than a row nothing sweeps (impl-review F5).
 */
export type E2eYoutubeId = (typeof E2E_YOUTUBE_IDS)[keyof typeof E2E_YOUTUBE_IDS];

export const E2E_RESERVED_YOUTUBE_IDS: readonly E2eYoutubeId[] = Object.values(E2E_YOUTUBE_IDS);

/**
 * The same rule again, at runtime, because the type alone is not a safety property: a cast, a JS
 * caller, or an id built from a variable all slip past `tsc`, and the consequence is not a failed test
 * — it is a `transcript_cache` row under an id `global-setup.ts` does not sweep. After a hard kill that
 * row survives invisibly, and if the id happened to be a REAL YouTube id it can then answer a real
 * user's request with fabricated transcript text. Called before the first write, never after.
 */
export function assertReservedYoutubeId(youtubeId: string): asserts youtubeId is E2eYoutubeId {
  if (!(E2E_RESERVED_YOUTUBE_IDS as readonly string[]).includes(youtubeId)) {
    throw new Error(
      `e2e seed: "${youtubeId}" is not in E2E_YOUTUBE_IDS (registry.ts). Every seeded id must be ` +
        "registered there FIRST, because `global-setup.ts` sweeps only registered ids — an unregistered " +
        "row left by a hard-killed run is invisible to the next run, and a real YouTube id would put " +
        "fabricated transcript text under a real video. Add the id to E2E_YOUTUBE_IDS instead of " +
        `passing a literal. Registered: ${E2E_RESERVED_YOUTUBE_IDS.join(", ")}.`,
    );
  }
}

/**
 * Every e2e synthetic account's email starts with this. Distinct from `synthetic-db-int-` so the two
 * suites' stale-account sweeps see only their own leaks — see the file header.
 */
export const E2E_ACCOUNT_EMAIL_PREFIX = "synthetic-e2e-";
