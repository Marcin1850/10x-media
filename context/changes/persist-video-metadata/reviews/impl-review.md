<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Persist Video Metadata Implementation Plan

- **Plan**: `context/changes/persist-video-metadata/plan.md`
- **Scope**: All implementation work, Phases 1–4 of 4
- **Date**: 2026-07-26
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 4 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Verification

- `npm.cmd run lint` — PASS. ESLint completed with only the repository's existing `astro-eslint-parser` project-service notices.
- `npm.cmd run build` — PASS. Astro's Cloudflare SSR build completed successfully; the sitemap integration repeated its existing missing-`site` warning.
- `npx.cmd supabase migration up` — PASS against the local database (`Migrations applied`, with no pending migration left to apply).
- `npx supabase db push` and `npx wrangler deploy` — not rerun because they mutate production. Commit `0a67e40` records both commands run back to back and Worker version `52657520-eac9-47fe-85a4-19f726db4f79`, but Git cannot independently prove their ordering or current remote state.
- Progress is **9/27 (33%)**: all nine automated rows are checked; all eighteen manual rows remain pending.

## Findings

### F1 — Decorative metadata requests have no deadline

- **Severity**: ⚠️ WARNING
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/metadata.ts:77`
- **Detail**: Both metadata attempts await `supadata.metadata()` without a deadline. The installed `@supadata/js@1.4.0` ultimately calls `fetch(url, options)` without an `AbortSignal`. A stalled decorative request occurs after the debit and paid LLM call, so it can keep the generation lease, reservation, and HTTP response open indefinitely or until an external platform timeout. This conflicts with the bounded-provider-call pattern in `src/lib/services/llm.ts:69-96`.
- **Fix A ⭐ Recommended**: Use a direct typed `fetch` for `/v1/metadata` with `AbortSignal.timeout()` on each attempt.
  - Strength: Actually cancels the stalled subrequest and makes the total-operation guarantee time-bounded.
  - Tradeoff: Duplicates a small part of the SDK's URL, headers, response parsing, and error mapping.
  - Confidence: HIGH — the runtime already uses `AbortSignal.timeout()` successfully for the LLM call.
  - Blind spot: The direct response/error mapping needs one integration check against Supadata.
- **Fix B**: Race each SDK call against a timeout promise and return null on timeout.
  - Strength: Keeps the SDK's typed endpoint and requires a smaller code change.
  - Tradeoff: Does not cancel the underlying fetch, so the subrequest and possible vendor credit may continue after the function proceeds.
  - Confidence: MEDIUM — it bounds application waiting but not the actual upstream operation.
  - Blind spot: Cloudflare's handling of the orphaned fetch has not been verified.
- **Decision**: PENDING

### F2 — Finite duration values are not necessarily PostgreSQL-safe

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/metadata.ts:50`
- **Detail**: `normaliseDuration()` accepts every finite number, including negatives and values outside PostgreSQL `integer` range. A malformed vendor value such as `3_000_000_000` reaches `p_duration_seconds integer` and aborts the atomic persist after the paid LLM call, contradicting the plan's column-safe normalization requirement.
- **Fix**: Round first, then return the value only when it is between `0` and `2_147_483_647`; otherwise return null.
- **Decision**: PENDING

### F3 — Authenticated clients can forge vendor-reported metadata

- **Severity**: ⚠️ WARNING
- **Impact**: 🔴 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260725120000_video_metadata.sql:27`
- **Detail**: The new columns are described as vendor-reported and the plan says the persist path is their only writer, but existing policy and grants still allow authenticated users to `INSERT` and `UPDATE` every column on their own `videos` rows (`20260613145120_videos_and_summaries.sql:22-28`, `20260712182527_grant_table_privileges.sql:11-13`). A direct PostgREST client can therefore forge or overwrite title, thumbnail provenance, channel, duration, publication date, and language, including persisting the explicitly forbidden derived thumbnail fallback. Cross-user isolation still holds; this is provenance/data-integrity risk, not privilege escalation.
- **Fix A ⭐ Recommended**: Revoke authenticated `INSERT`/`UPDATE` on `videos` and remove the corresponding write policies, retaining authenticated `SELECT`/`DELETE` while service-role RPCs own creation and metadata writes.
  - Strength: Enforces the documented single-writer architecture; repository search finds no current client-side `videos` insert/update call.
  - Tradeoff: Any legacy or external client not present in this repository would lose direct video writes.
  - Confidence: HIGH — the current application persists videos only through the service-role `persist_summary` RPC.
  - Blind spot: External consumers of the Supabase API have not been inventoried.
- **Fix B**: Replace table-wide write privileges with column-level grants limited to the legacy client-owned columns.
  - Strength: Preserves a constrained direct-write path if an external client still needs one.
  - Tradeoff: More complex privilege maintenance; every future column must be classified correctly.
  - Confidence: MEDIUM — PostgreSQL supports the shape, but the required external compatibility is unknown.
  - Blind spot: No evidence currently identifies which columns an external client would legitimately own.
- **Decision**: PENDING

### F4 — Retry classification treats every unknown failure as transport-level

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/lib/services/metadata.ts:34`
- **Detail**: The plan requires retrying `limit-exceeded` or a recognized transport rejection and returning null for unrecognized failures. `isRetryable()` instead returns true for every non-`SupadataError`, so arbitrary strings, programmer errors, or unexpected runtime failures trigger a second paid metadata attempt.
- **Fix**: Return true only for `SupadataError` with `limit-exceeded` or a positively recognized fetch/transport error (for this runtime, a fetch-rejection `TypeError`); return false for unknown values.
- **Decision**: PENDING

### F5 — The shared metadata DTO is structurally duplicated

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/lib/services/summaries.ts:180`
- **Detail**: `VideoMetadata` crosses the metadata service, endpoint, and persistence service, but `PersistSummaryParams.metadata` repeats its structure instead of importing a shared type. This conflicts with the repository convention that shared DTOs live in `src/types.ts` and allows the two shapes to drift silently.
- **Fix**: Move `VideoMetadata` to `src/types.ts` and import it in both services, or at minimum import the existing type from `metadata.ts` into `summaries.ts`.
- **Decision**: PENDING

### F6 — All behavioral and production success criteria remain pending

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `context/changes/persist-video-metadata/plan.md:363`
- **Detail**: All eighteen Manual Progress rows are unchecked. The unverified behavior includes real seven-field persistence, non-Polish language capture, the large-pool warning, invalid-key and raw transport failure totality, coalescing on a second generation, the two-credit delta, the deployed production row, Worker logs, and reservation settlement. The roadmap discloses this accurately, so this is missing evidence rather than rubber-stamping.
- **Fix**: Complete the manual checklist before archive and record evidence, prioritizing the transport-rejection/settlement, second-generation coalesce, production row, and production reservation checks because they cover the highest data-safety risk.
- **Decision**: PENDING

### F7 — Linear phase-4 synchronization is not verifiable

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: N/A (`MAR-14`)
- **Detail**: Phase 4 requires moving the Linear issue and adding a completion comment, reinforced by two accepted lessons. Commit `0a67e40` references `MAR-14` but contains no evidence of the issue state or comment, and no Linear connector is available in this session to inspect it.
- **Fix**: Inspect MAR-14, set the lifecycle-appropriate state, and add a concise phase-completion plus implementation-review comment if either is missing.
- **Decision**: PENDING

### F8 — Roadmap frontmatter was not refreshed with the rollout

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `context/foundation/roadmap.md:6`
- **Detail**: Phase 4 updated all three S-08 status surfaces with 2026-07-26 rollout information, but the roadmap frontmatter still says `updated: 2026-07-25`.
- **Fix**: Set the roadmap frontmatter `updated` field to `2026-07-26`.
- **Decision**: PENDING
