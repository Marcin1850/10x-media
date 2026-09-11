<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Transcript Cost Guardrail

- **Plan**: `context/changes/transcript-cost-guardrail/plan.md`
- **Scope**: Phase 4 of 7
- **Date**: 2026-08-04
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | WARNING |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — Authenticated users can forge metadata provenance

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `supabase/migrations/20260731120000_metadata_cache.sql:174`
- **Detail**: Adding `summaries.metadata_via` automatically exposes the column through the table's existing authenticated `INSERT` and `UPDATE` grants and owner-scoped RLS policies. The local catalogue confirms both write privileges and both policies remain active. A signed-in caller can therefore forge or erase `metadata_via` on its own summaries, corrupting the D10 provenance/cost telemetry. This conflicts with the repository's `videos` single-writer precedent (`20260726120000_videos_single_writer.sql`), and the source scan found no first-party code path that writes `summaries` directly; `persist_summary` is the intended writer.
- **Fix A ⭐ Recommended**: Make `summaries` single-writer by revoking authenticated `INSERT`/`UPDATE` and dropping the corresponding policies, while retaining owner-scoped `SELECT`/`DELETE`.
  - Strength: Matches the existing `videos` provenance pattern and closes forgery for all current and future telemetry columns.
  - Tradeoff: Any external client that writes summaries directly, outside this repository, would stop working.
  - Confidence: HIGH — repository code uses `persist_summary` as the sole writer and already applies this model to `videos`.
  - Blind spot: External consumers not represented in this repository were not inspected.
- **Fix B**: Replace table-wide write grants with column-level grants that exclude server-owned provenance and telemetry columns.
  - Strength: Preserves a controlled direct-write path if client-side summary editing is an unstated requirement.
  - Tradeoff: More complex and easier to drift as new server-owned columns are added.
  - Confidence: MEDIUM — PostgreSQL supports the shape, but the required client-write column set is not documented.
  - Blind spot: No current direct-write use case was found to validate the exact allowed column list.
- **Decision**: FIXED via Fix A — added `supabase/migrations/20260731130000_summaries_single_writer.sql`, mirroring `20260726120000_videos_single_writer.sql`. Applied locally; catalogue now shows `authenticated` holding only `SELECT`/`DELETE` on `summaries`, with `summaries_insert_authenticated` and `summaries_update_authenticated` dropped.

### F2 — The RPC swap creates a non-atomic production outage window

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Architecture
- **Location**: `supabase/migrations/20260731120000_metadata_cache.sql:201`
- **Detail**: The migration drops the live 23-argument `persist_summary` before the 24-argument Worker is deployed. The plan acknowledges the interval, but running `db push` and `wrangler deploy` back to back does not make the rollout atomic: traffic in the gap fails persistence after paid LLM work, and a slow or failed Worker deployment extends the outage indefinitely. Phase 7 has not deployed this migration yet, so the risk is still avoidable.
- **Fix**: Use an expand/deploy/contract rollout: add a versioned 24-argument RPC, deploy and health-check the Worker against it, then remove the 23-argument RPC in a later migration.
  - Strength: Eliminates the known paid-work failure window and makes deployment failure recoverable without a database rollback.
  - Tradeoff: Temporarily duplicates the function body and requires a follow-up contract migration.
  - Confidence: HIGH — both caller versions can coexist under distinct RPC names without PostgREST overload ambiguity.
  - Blind spot: The production traffic level and existing deployment rollback automation were not measured.
- **Decision**: SKIPPED — the in-place RPC swap stands; the deploy gap is accepted for this change.

### F3 — `fetched` is documented as billed even when failures cost zero

- **Severity**: OBSERVATION
- **Impact**: 🟢 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: `src/types.ts:21`
- **Detail**: On every cache miss, the endpoint sets `metadata_via = 'fetched'` before calling `fetchVideoMetadata`, and it retains that value when the helper returns `null` after a failed request (`generate.ts:758-776`). That behavior correctly means “a vendor request was attempted,” but the type comment, migration column comment, and endpoint comment describe the value as necessarily billed. The same implementation states that failed metadata calls are billed 0. Treating the marker itself as billing truth would therefore overcount failures; exact billing belongs to `supadata_calls`.
- **Fix**: Rewrite the three comments to define `fetched` as “vendor request attempted; consult `supadata_calls` for exact billing.”
- **Decision**: FIXED differently — rather than resolve the ambiguity in prose, the outcome moved into the marker. Added `supabase/migrations/20260731140000_metadata_via_fetch_failed.sql` widening `summaries_metadata_via_check` to `('fetched', 'fetch_failed', 'stored', 'skipped_budget')` and rewriting the column comment; `MetadataVia` in `src/types.ts:28` gained `"fetch_failed"` with both doc comments reworded; `generate.ts` now stamps the marker AFTER the call (`metadata === null ? "fetch_failed" : "fetched"`) instead of before it. `supadata_calls` is named as billing truth in all three places. Not backfilled — pre-existing `'fetched'` rows are not retroactively separable. Plan D10 updated with a matching addendum. Verified: migration applied locally, constraint reads the four values, `npm run lint` and `npm run build` pass.

## Verification

- `npx.cmd supabase migration up` — PASS. The local database reported no pending migrations (`applied: []`).
- Catalogue assertions — PASS. `persist_summary` has exactly one overload with 24 arguments; `metadata_cache` has RLS enabled and zero policies; `summaries_metadata_via_check` admits only null, `fetched`, `stored`, or `skipped_budget`; `get_metadata_cache`, `save_metadata_cache`, and `persist_summary` are executable by `service_role` only among API roles.
- `npm.cmd run lint` — PASS. ESLint exited 0; only the existing `astro-eslint-parser` project-service notices were emitted.
- `npm.cmd run build` — PASS. Astro SSR/Cloudflare build completed; the existing missing-`site` sitemap warning remains.
- Manual criteria 4.6–4.9 — PASS with observable evidence in `reviews/manual-verification-phase-4.md`: cold fetch/cache write, cross-account zero-credit cache hit with a populated `videos` row, and a 31-day-expired row refreshing. The recorded vendor delta (4) equals the per-outcome ledger total (4). Paid vendor scenarios were not repeated during this review.

## Scope Notes

- Commit `0142ead` changes exactly the five planned implementation files. Its three additional paths are the expected `plan.md`, `change.md`, and manual-verification bookkeeping.
- No metadata failure caching, historical backfill, pipeline restructuring, or premature `skipped_budget` write was introduced.
- The working-tree-only `plan.md` edit appends `0142ead` to completed Phase 4 automated rows and was preserved.
