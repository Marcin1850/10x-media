import { expect } from "@playwright/test";
import { accountTest } from "./account";
import { adminClient } from "./admin";
import { deleteCacheRows, seedMetadataCache, seedTranscriptCache, youtubeWatchUrl } from "./seed-cache";
import type { SeedTranscriptOptions } from "./seed-cache";
import { assertReservedYoutubeId, type E2eYoutubeId } from "./registry";

/**
 * The spec entry point: `import { test, expect } from "./fixtures/test"`.
 *
 * Composes the two fixtures every e2e spec needs — a signed-in per-test account (`./account`) and
 * pre-seeded transcript/metadata caches (`./seed-cache`) — so a spec declares what it needs and gets
 * setup, injection and cleanup for free, in the right order.
 *
 * **The ordering is not incidental.** `seedVideo` depends on `account`, so Playwright tears it down
 * FIRST: cache rows are deleted, and only then is the `auth.users` row dropped. The reverse order
 * would leave `supadata_calls` rows (`on delete set null`) orphaned into the ledger that risk #2 sums.
 */

export interface SeededVideo {
  youtubeId: string;
  /** The watch URL to type into the capture bar. */
  url: string;
  /** The exact transcript the fake summarizer will fingerprint — a spec computes its expected card text from this. */
  transcript: string;
}

export interface VideoSeeder {
  /**
   * Makes both Supadata checkpoints cache hits for one registry id, and registers it for cleanup.
   * `youtubeId` is restricted to `E2eYoutubeId` — `global-setup.ts` only sweeps ids listed in
   * `registry.ts`, so an id from anywhere else is a row nothing cleans up. Enforced twice: here at
   * compile time, and again at runtime inside `seed` for the callers a type cannot reach.
   */
  seed(youtubeId: E2eYoutubeId, options: SeedTranscriptOptions & { title?: string }): Promise<SeededVideo>;
}

export const test = accountTest.extend<{ seedVideo: VideoSeeder }>({
  seedVideo: async ({ account }, use) => {
    const admin = adminClient();
    const seeded: string[] = [];

    await use({
      async seed(youtubeId, { title = "Testowy film e2e", ...transcriptOptions }) {
        // Before ANY write and before tracking: an id that is about to be rejected must not reach the
        // database, and an id that never reached the database must not enter the cleanup list.
        assertReservedYoutubeId(youtubeId);
        seeded.push(youtubeId);
        // Registered BEFORE the write, not after: a seed that throws half-way still has to be cleaned
        // up, and an id the teardown never heard of is a row the next run aborts on.
        account.trackYoutubeId(youtubeId);
        await seedTranscriptCache(admin, youtubeId, transcriptOptions);
        await seedMetadataCache(admin, youtubeId, title);
        return { youtubeId, url: youtubeWatchUrl(youtubeId), transcript: transcriptOptions.content };
      },
    });

    // Same rule as `deleteCacheRows` itself, one level up: every seeded id is cleaned up even after an
    // earlier one fails, because a skipped id is a row that aborts the next run (impl-review F7). The
    // failures are still loud — they are collected and thrown together once nothing is left to try.
    const cleanupFailures: unknown[] = [];
    for (const youtubeId of seeded) {
      try {
        await deleteCacheRows(youtubeId);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        `seedVideo teardown: cleanup failed for ${cleanupFailures.length} of ${seeded.length} seeded video(s)`,
      );
    }
  },
});

export { expect };
