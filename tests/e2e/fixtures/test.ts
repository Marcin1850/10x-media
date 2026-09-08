import { expect } from "@playwright/test";
import { accountTest } from "./account";
import { adminClient } from "./admin";
import { deleteCacheRows, seedMetadataCache, seedTranscriptCache, youtubeWatchUrl } from "./seed-cache";
import type { SeedTranscriptOptions } from "./seed-cache";

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
   * `youtubeId` must come from `registry.ts` — `global-setup.ts` only sweeps ids listed there.
   */
  seed(youtubeId: string, options: SeedTranscriptOptions & { title?: string }): Promise<SeededVideo>;
}

export const test = accountTest.extend<{ seedVideo: VideoSeeder }>({
  seedVideo: async ({ account }, use) => {
    const admin = adminClient();
    const seeded: string[] = [];

    await use({
      async seed(youtubeId, { title = "Testowy film e2e", ...transcriptOptions }) {
        seeded.push(youtubeId);
        // Registered BEFORE the write, not after: a seed that throws half-way still has to be cleaned
        // up, and an id the teardown never heard of is a row the next run aborts on.
        account.trackYoutubeId(youtubeId);
        await seedTranscriptCache(admin, youtubeId, transcriptOptions);
        await seedMetadataCache(admin, youtubeId, title);
        return { youtubeId, url: youtubeWatchUrl(youtubeId), transcript: transcriptOptions.content };
      },
    });

    for (const youtubeId of seeded) {
      await deleteCacheRows(youtubeId);
    }
  },
});

export { expect };
