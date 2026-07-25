<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Persist Video Metadata Implementation Plan

- **Plan**: `context/changes/persist-video-metadata/plan.md`
- **Mode**: Deep
- **Date**: 2026-07-25
- **Verdict**: REVISE
- **Findings**: 1 critical, 3 warnings, 3 observations
- **Addendum**: 2026-07-25 — targeted re-check of thumbnail storage (F5–F7)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | WARNING |
| Lean Execution | PASS |
| Architectural Fitness | FAIL |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

9/9 existing paths ✓, 5/5 symbols ✓, 2/2 explicit new paths correctly absent ✓, brief↔plan ✓, Progress↔phases ✓.

The skill's referenced `.claude/skills/10x-plan-review/references/progress-format.md` is absent. The Progress scan used the complete mechanical rules embedded in `SKILL.md`; the plan passes them.

**Addendum grounding (2026-07-25, thumbnail re-check):** `thumbnail_url` confirmed present as `text` at `supabase/migrations/20260613145120_videos_and_summaries.sql:10`, `src/lib/services/summaries.ts:10`, `src/types.ts:12` ✓. Binary-storage exclusion confirmed at `plan.md:41` ✓. YouTube CDN variants probed live against `i.ytimg.com` ✓ (results in F5).

## Findings

### F1 — The RPC outage window is avoidable

- **Severity**: CRITICAL
- **Impact**: HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architectural Fitness
- **Location**: Critical Implementation Details, Phase 1, Phase 4, Migration Notes
- **Detail**: The plan hard-swaps the eight-argument RPC for a fifteen-argument version, guaranteeing an incompatibility window: DB-first breaks the current eight-argument Worker, while Worker-first breaks against the current database. Running deployments “back to back” cannot eliminate deployment time. The premise for accepting that outage is incorrect: PostgREST supports overloaded functions with different argument counts, and the proposed signatures have eight versus fifteen arguments. The current caller sends eight arguments at `src/lib/services/summaries.ts:192-200`; the current function and grants target the eight-argument identity at `supabase/migrations/20260723120000_atomic_persist_summary.sql:45-54,136-139`. Existing repository precedent preserves old shapes during rollout at `supabase/migrations/20260723120000_atomic_persist_summary.sql:28-32` and removes them later at `supabase/migrations/20260724120000_drop_legacy_rpcs.sql:1-13`. The rollback at plan line 308 is incomplete too: executing the old migration recreates the eight-argument identity but does not remove the fifteen-argument identity, and an already-recorded migration is not normally rerun by `supabase migration up`. Official reference: https://docs.postgrest.org/en/latest/references/api/functions.html#overloaded-functions
- **Fix A ⭐ Recommended**: Use expand/contract with both arities. Create the fifteen-argument overload, deploy the new Worker, wait for old in-flight requests to drain, then drop the eight-argument overload in a later migration.
  - Strength: Matches official PostgREST support and this repository's rollout precedent while eliminating the intentional 500 window.
  - Tradeoff: Requires an extra contract migration and temporarily duplicates the function body.
  - Confidence: HIGH — exact argument counts, callers, PostgREST version, and repository precedents were verified.
  - Blind spot: Confirm local PostgREST schema-cache reloading during migration testing.
- **Fix B**: Introduce `persist_summary_v2`, deploy its caller, then remove the old RPC later.
  - Strength: Avoids overload concerns and makes API versioning explicit.
  - Tradeoff: Adds a renamed contract and later cleanup work.
  - Confidence: HIGH — both deployment states remain independently valid.
  - Blind spot: Operational tooling referencing the old RPC should be checked before removal.
- **Decision**: PENDING

### F2 — Transport failure is missing from verification

- **Severity**: WARNING
- **Impact**: MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3 — Metadata service and generation endpoint
- **Detail**: Metadata runs after the debit and paid LLM call but before the existing persistence `try`/`catch` at `src/pages/api/summaries/generate.ts:347-384`. Therefore `fetchVideoMetadata()` being total is load-bearing: an unexpected rejection can escape without an immediate refund and leave the reservation for later reconciliation. The invalid-key manual test exercises a structured `SupadataError`, not a raw network rejection. The installed SDK lets fetch-level rejection escape as the underlying error, and its typed error enum at `node_modules/@supadata/js/dist/index.d.ts:41-50` does not include the plan's `forbidden` value.
- **Fix**: Specify a narrowly typed failure boundary: catch the entire retry operation, retry only `limit-exceeded` or a recognized transport error, and add verification for a rejected transport promise. Consider a defensive call-site fallback to `null` because this decorative call occurs after paid work.
  - Strength: Proves the failure mode most likely to bypass structured provider handling.
  - Tradeoff: Requires a small injection seam or focused test mechanism.
  - Confidence: HIGH — the installed SDK and endpoint control flow were verified.
  - Blind spot: The SDK exposes no request signal, so a cancellable timeout may require direct fetch or a non-cancelling deadline.
- **Decision**: PENDING

### F3 — Desired end state contradicts the accepted long-video path

- **Severity**: WARNING
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Desired End State, Key Discoveries, out-of-scope boundaries
- **Detail**: The Desired End State says every successful generation has nulls only when Supadata lacks data or metadata fails. The plan later accepts null language columns on every cached `allowLong` generation because the quote stores no language fields, and explicitly excludes widening that cache. The code confirms the cache holds only content and `resolvedVia` at `src/lib/services/transcript-guard.ts:50-53`.
- **Fix**: Qualify the Desired End State as applying to fresh-transcript generations and name cached long-video confirmation as the accepted language-null exception.
- **Decision**: PENDING

### F4 — Phase 3 miscounts descriptive fields

- **Severity**: OBSERVATION
- **Impact**: LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 overview and manual failure criterion
- **Detail**: Phase 3 twice says “four” descriptive metadata fields, but its contract maps five: title, thumbnail, channel, duration, and publication date.
- **Fix**: Replace “four” with “five” in the Phase 3 overview and forced-failure criterion.
- **Decision**: PENDING

---

## Addendum — thumbnail storage re-check (2026-07-25)

Scope: what the slice persists as a thumbnail (URL vs. binary), whether the image is fetchable from YouTube, and whether the column name is self-descriptive.

**Two of the three questions resolve as no-change:**

- **URL, not binary — correct as planned.** `plan.md:41` already excludes a storage copy. A binary copy would require a Supabase Storage bucket with its own RLS, a fetch + upload after the paid LLM call (2 more subrequests against the budget tracked at `plan.md:75`), and a change to S-04 erasure — `user_id`'s `on delete cascade` reaches table rows, not storage objects. Nothing in the MVP justifies that.
- **`thumbnail_url` is self-descriptive — no rename.** The `_url` suffix answers the URL-vs-binary question at the schema level and is consistent with the sibling `videos.url`. The column predates this slice (F-01), so a rename is a breaking change to the table, the `Video` entity and the RPC signature for no gain.

The fetchability question surfaced three findings.

### F5 — Persisted thumbnail URL can 404; verification will not catch it

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 3 (§Metadata service, manual criterion at `plan.md:224`), Migration Notes (`plan.md:309`)
- **Detail**: Supadata's documented response returns `maxresdefault.jpg` (`docs/supadata-metadata.md:27`), which does not exist for videos never uploaded above 480p. Probed live against `i.ytimg.com` on 2026-07-25:

  | video | maxresdefault | sddefault | hqdefault | mqdefault |
  |---|---|---|---|---|
  | `dQw4w9WgXcQ` (2009, HD) | 200 | 200 | 200 | 200 |
  | `jNQXAC9IVRw` (2005, 240p) | **404** | **404** | 200 | 200 |

  The plan persists the vendor string unvalidated. Phase 3's only check is "the thumbnail URL loads in a browser" on a single video, and Migration Notes tells S-02 to handle *null* metadata only — a live-but-dead URL renders as a broken image, which no planned fallback covers. Hotlinking itself is not a problem: `i.ytimg.com` needs no key, no referrer, and no CORS for `<img>`.
- **Fix A ⭐ Recommended**: Store Supadata's URL as-is; add an old low-resolution video to Phase 3's deliberate edge-case runs (`plan.md:292-296`), and record in Migration Notes that S-02's fallback for **both** null and 404 is the derived `https://i.ytimg.com/vi/<youtube_id>/hqdefault.jpg`.
  - Strength: Zero runtime cost, keeps the best-available resolution, and gives S-02 a real image instead of a placeholder even for the un-backfilled existing rows.
  - Tradeoff: Correctness lands in S-02 rather than this slice; a broken row exists in the DB until rendered.
  - Confidence: HIGH — CDN behaviour verified directly for both variants.
  - Blind spot: Not confirmed that Supadata always passes `maxresdefault` through rather than picking the best existing variant itself; the edge-case run settles it.
- **Fix B**: Normalise in `fetchVideoMetadata` — rewrite any `i.ytimg.com` URL to `hqdefault.jpg` before returning.
  - Strength: Every stored URL is guaranteed to resolve; no downstream fallback logic needed.
  - Tradeoff: Caps every thumbnail at 480×360 even where `maxresdefault` exists.
  - Confidence: HIGH — `hqdefault` returned 200 for both probes, including the 2005 240p upload.
  - Blind spot: Assumes Supadata never returns a non-`i.ytimg.com` host for a YouTube video.
- **Decision**: PENDING

### F6 — Plan never records why a derivable value is stored

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 1 §Migration, `docs/supadata-metadata.md:40`
- **Detail**: `thumbnail_url` is fully reconstructible from `youtube_id`, which `videos` already stores. Persisting it is still the right call — it arrives free in a metadata call made anyway and carries the best-available resolution rather than a fixed guess — but nothing in the plan says so, leaving a future reader to read the column as redundant.
- **Fix**: Add one line to Phase 1's migration intent stating that the column is derivable but persisted because the value is free in a call already made and carries the best-available variant.
- **Decision**: PENDING

### F7 — Reference doc names a column the plan forbids

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: `context/changes/persist-video-metadata/docs/supadata-metadata.md:44`
- **Detail**: The field→column mapping table still lists `language text (new)`, while `plan.md:42` explicitly rules that column out in favour of `transcript_lang` / `transcript_available_langs` precisely so it cannot be mistaken for the video's spoken language. An implementer reading the referenced doc gets the rejected name.
- **Fix**: Replace the `language text (new)` row with the two actual columns and their source (`Transcript.lang` / `Transcript.availableLangs`).
- **Decision**: PENDING
