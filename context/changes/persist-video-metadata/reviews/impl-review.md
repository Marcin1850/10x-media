<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Persist Video Metadata Implementation Plan

- **Plan**: `context/changes/persist-video-metadata/plan.md`
- **Scope**: All implementation work, Phases 1–4 of 4
- **Date**: 2026-07-26
- **Verdict**: NEEDS ATTENTION at review time → **APPROVED** after remediation (2026-07-26)
- **Findings**: 0 critical, 4 warnings, 4 observations
- **Triage**: complete 2026-07-26 — F1, F2, F3, F4, F5, F8 fixed; F7 resolved by inspection (+ review comment posted); **F6 re-opened and executed** (was SKIPPED). Lint + build + `supabase migration up` green after the fixes. No outstanding items: the `20260726120000_videos_single_writer.sql` push was confirmed already applied to production, and all 27 Progress rows are now verified.

## Verdicts

| Dimension | At review | After remediation |
|-----------|-----------|-------------------|
| Plan Adherence | WARNING | PASS — F4, F7 closed |
| Scope Discipline | PASS | PASS |
| Safety & Quality | WARNING | PASS — F1, F2, F3 closed |
| Architecture | PASS | PASS |
| Pattern Consistency | WARNING | PASS — F5, F8 closed |
| Success Criteria | WARNING | PASS — 27/27 rows verified |

## Verification

- `npm.cmd run lint` — PASS. ESLint completed with only the repository's existing `astro-eslint-parser` project-service notices.
- `npm.cmd run build` — PASS. Astro's Cloudflare SSR build completed successfully; the sitemap integration repeated its existing missing-`site` warning.
- `npx.cmd supabase migration up` — PASS against the local database (`Migrations applied`, with no pending migration left to apply).
- `npx supabase db push` and `npx wrangler deploy` — **both independently confirmed 2026-07-26**, closing the gap this section originally flagged. `npx supabase migration list` shows every migration through `20260726120000` present remotely; `npx wrangler deployments list` shows version `52657520-eac9-47fe-85a4-19f726db4f79` deployed at 12:50:00Z, and a live `wrangler tail` reports that same version serving production traffic. Commit `0a67e40`'s record is accurate.
- Progress was **9/27 (33%)** at review time. After the 2026-07-26 manual run it is **27/27 (100%)**: all nine automated rows and all eighteen manual rows, local and production. One row (4.3) carries a documented caveat rather than a clean pass — see F6.

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
- **Decision**: FIXED via Fix A — `supadata.metadata()` replaced by a direct `GET /v1/metadata` (`requestMetadata()`) carrying `AbortSignal.timeout(10_000)`, mirroring the SDK's request shape and `SupadataError` mapping so retry classification is unchanged. Lint passes.

### F2 — Finite duration values are not necessarily PostgreSQL-safe

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/lib/services/metadata.ts:50`
- **Detail**: `normaliseDuration()` accepts every finite number, including negatives and values outside PostgreSQL `integer` range. A malformed vendor value such as `3_000_000_000` reaches `p_duration_seconds integer` and aborts the atomic persist after the paid LLM call, contradicting the plan's column-safe normalization requirement.
- **Fix**: Round first, then return the value only when it is between `0` and `2_147_483_647`; otherwise return null.
- **Decision**: FIXED — `normaliseDuration()` now rounds, then range-checks against `[0, PG_INT_MAX]` and returns null outside it.

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
- **Decision**: FIXED via Fix A — new migration `supabase/migrations/20260726120000_videos_single_writer.sql` revokes all on `public.videos` from `anon, authenticated`, re-grants only `select, delete` to `authenticated`, and drops the `videos_insert_authenticated` / `videos_update_authenticated` policies. **Closed in production, verified 2026-07-26**: `npx supabase migration list` shows `20260726120000` present on both local and remote, and `\d+ public.videos` locally confirms only the `select`/`delete` policies survive. The earlier "not yet pushed" note was wrong — the push had already landed.

### F4 — Retry classification treats every unknown failure as transport-level

- **Severity**: ⚠️ WARNING
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/lib/services/metadata.ts:34`
- **Detail**: The plan requires retrying `limit-exceeded` or a recognized transport rejection and returning null for unrecognized failures. `isRetryable()` instead returns true for every non-`SupadataError`, so arbitrary strings, programmer errors, or unexpected runtime failures trigger a second paid metadata attempt.
- **Fix**: Return true only for `SupadataError` with `limit-exceeded` or a positively recognized fetch/transport error (for this runtime, a fetch-rejection `TypeError`); return false for unknown values.
- **Decision**: FIXED (user-adjusted) — `isRetryable()` is now an allow-list: `limit-exceeded`, a fetch-rejection `TypeError`, or a `TimeoutError` (checked by name). Everything else is non-retryable. Per the user's call, `TimeoutError` stays retryable and `METADATA_TIMEOUT_MS` stays at 10s, so the worst-case operation remains ~21s — judged acceptable.

### F5 — The shared metadata DTO is structurally duplicated

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `src/lib/services/summaries.ts:180`
- **Detail**: `VideoMetadata` crosses the metadata service, endpoint, and persistence service, but `PersistSummaryParams.metadata` repeats its structure instead of importing a shared type. This conflicts with the repository convention that shared DTOs live in `src/types.ts` and allows the two shapes to drift silently.
- **Fix**: Move `VideoMetadata` to `src/types.ts` and import it in both services, or at minimum import the existing type from `metadata.ts` into `summaries.ts`.
- **Decision**: FIXED — `VideoMetadata` now lives in `src/types.ts`; `metadata.ts` and `summaries.ts` both import it, and `PersistSummaryParams.metadata` is `VideoMetadata | null`. Lint + build pass.

### F6 — All behavioral and production success criteria remain pending

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟡 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: `context/changes/persist-video-metadata/plan.md:363`
- **Detail**: All eighteen Manual Progress rows are unchecked. The unverified behavior includes real seven-field persistence, non-Polish language capture, the large-pool warning, invalid-key and raw transport failure totality, coalescing on a second generation, the two-credit delta, the deployed production row, Worker logs, and reservation settlement. The roadmap discloses this accurately, so this is missing evidence rather than rubber-stamping.
- **Fix**: Complete the manual checklist before archive and record evidence, prioritizing the transport-rejection/settlement, second-generation coalesce, production row, and production reservation checks because they cover the highest data-safety risk.
- **Decision**: **RE-OPENED AND EXECUTED 2026-07-26** (superseding the earlier SKIPPED). The manual suite was run rather than deferred. **14 of 18 rows verified**; the four Phase-4 production-behaviour rows are covered separately below.

  Run against the local stack on a dedicated throwaway account (`s08-manual-test@example.com`, created via the admin API so no existing account's quote cache or credit balance was disturbed). Six real generations, 8 Supadata credits, ledger reconciled exactly (29 → 37).

  | Row | Result | Evidence |
  |---|---|---|
  | 1.4 | PASS | `jNQXAC9IVRw` returned 200 with a Polish summary in 25s |
  | 1.5 | PASS | `\d+ public.videos` — five new columns, `thumbnail_url_reported` renamed, rationale comment attached |
  | 1.6 | PASS | `pg_proc` — exactly one `persist_summary`, `pronargs` 15 |
  | 1.7 | PASS | reservation `settled`, amount 1 |
  | 2.3 | PASS | `de` / `en` / `af` across three videos — never the removed hardcoded `pl` |
  | 2.4 | PASS | `text[]` reads back; `array_length` 2 / 5 / 61 |
  | 2.5 | PASS | Polish output from German and Afrikaans transcripts |
  | 2.6 | PASS | warning fired on the 61-language pool with URL, lang and size |
  | 3.3 | PASS | title/channel/duration/date all match the real video (19s, 2005-04-23) |
  | 3.4 | PASS | both thumbnails HTTP 200 — but see the plan correction, the predicted 404 did not occur |
  | 3.5 | PASS | invalid key + cached quote → 200, five nulls, `Unauthorized` classified non-retryable |
  | 3.6 | PASS | injected `TypeError` → 200, null metadata, reservation `settled` not `reserved` |
  | 3.7 | PASS | second run with null metadata left all seven fields intact — `coalesce` proven |
  | 3.8 | PASS | 29 → 31 for one native-transcript generation |

  Three results are worth more than a tick. **3.6 and 3.7 were run as one test** — regenerating with metadata forced to null is the strict form of the coalesce check, since a healthy second fetch would merely rewrite identical values and prove nothing. **3.5 confirmed the plan's cost claim independently**: the cached-quote resubmit spent zero transcript credits, visible as a flat segment in the Supadata ledger. And the `allowLong` edge case behaved as documented — both language columns null, no crash.

  **Phase 4 (production), verified 2026-07-26** — the remaining four rows, run against the deployed Worker on version `52657520-eac9-47fe-85a4-19f726db4f79` under a live `wrangler tail`. This was the **first generation ever run on production since S-08 shipped**: before it, prod `videos` held two pre-S-08 rows with all-null metadata and `credit_reservations` was empty, so nothing about the new path had been exercised in production at all.

  | Row | Result | Evidence |
  |---|---|---|
  | 4.3 | PASS (with caveat) | `TVA738-ERqg` — title, HISTORIA REALNA, 4523s, 2026-07-22, `maxresdefault.jpg` HTTP 200 / 305 KB |
  | 4.4 | PASS | both POSTs `outcome: ok`, zero exceptions, no error logs |
  | 4.5 | PASS | reservation `ea718a97`, amount 2, `settled` |
  | 4.6 | PASS | 37 → 39 (+2); 61 of 100 remain ≈ 30 further generations post-halving |

  The 4.3 caveat, accepted by the user rather than papered over: the production run happened to take the **`allowLong` long-video path** (75-minute video, 409 then confirmed resubmit), and that path nulls `transcript_lang` and `transcript_available_langs` by design because the quote cache carries no language fields. So production proves five of seven columns; the two language columns are proven locally (2.3, 2.4) but have never been written on production. Worth knowing for S-02: the first real production rows may legitimately carry null language data.

  Two findings contradict plan assumptions and are written up in `plan.md` §Manual Verification Findings: Supadata returned a **working** `hqdefault` for the low-res video instead of the 404-ing `maxresdefault` the plan predicted, and `mode: "auto"` returned a **translated** caption track rather than the original on two of three videos — the German wording visibly leaked into one summary. The second is a content-fidelity risk for S-01/S-02 with no fix inside S-08, and is the strongest argument yet for the diagnostic columns this slice added.

### F7 — Linear phase-4 synchronization is not verifiable

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: N/A (`MAR-14`)
- **Detail**: Phase 4 requires moving the Linear issue and adding a completion comment, reinforced by two accepted lessons. Commit `0a67e40` references `MAR-14` but contains no evidence of the issue state or comment, and no Linear connector is available in this session to inspect it.
- **Fix**: Inspect MAR-14, set the lifecycle-appropriate state, and add a concise phase-completion plus implementation-review comment if either is missing.
- **Decision**: RESOLVED BY INSPECTION + FIXED — the Linear MCP server was available this session. MAR-14 moved to **In Progress** at 2026-07-26 12:52 and the phase-4 completion comment landed the same minute, so the sync did happen; only the commit lacked evidence of it. State is lifecycle-correct and unchanged (manual checks still gate completion). Added the missing implementation-review comment covering all eight findings and their decisions.

### F8 — Roadmap frontmatter was not refreshed with the rollout

- **Severity**: ℹ️ OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: `context/foundation/roadmap.md:6`
- **Detail**: Phase 4 updated all three S-08 status surfaces with 2026-07-26 rollout information, but the roadmap frontmatter still says `updated: 2026-07-25`.
- **Fix**: Set the roadmap frontmatter `updated` field to `2026-07-26`.
- **Decision**: FIXED — `context/foundation/roadmap.md` frontmatter now reads `updated: 2026-07-26`.
