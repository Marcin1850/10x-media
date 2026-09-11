# Persist Video Metadata — Plan Brief

> Full plan: `context/changes/persist-video-metadata/plan.md`
> API reference: `context/changes/persist-video-metadata/docs/` (Supadata, captured 2026-07-25)
> Roadmap slice: `context/foundation/roadmap.md` §S-08

## What & Why

A saved summary currently records nothing about the video except its URL. This slice persists the thumbnail, title, channel, duration and upload date — plus two diagnostic columns recording which language the transcript actually came back in — so that S-02's summary list ships legible rather than being retrofitted, and so the watch/skip decision has the context the summary text alone doesn't carry.

## Starting Point

`videos.title` and `videos.thumbnail_url` have existed since F-01 and have never held a value. The cause is the RPC, not the application: `persist_summary()` hardcodes an insert of `(user_id, url, youtube_id)` and no code touches `videos` directly anymore. There are no columns at all for channel, duration, upload date or language. Meanwhile the transcript call already returns `lang` and `availableLangs` on every run and the endpoint throws both away.

## Desired End State

After a successful generation **on the fresh-transcript path**, the video's row carries all seven fields, with nulls only where Supadata genuinely had nothing or the metadata call failed. One accepted exception: a generation resumed from a cached quote (the `allowLong` confirmation path) leaves the two language columns null, because the quote cache stores no language fields — the five descriptive columns still populate there. `thumbnail_url` is renamed to `thumbnail_url_reported` along the way. The transcript request no longer asks for a Polish caption track, so the model works from whatever track Supadata considers first-available rather than a potentially machine-translated Polish one. Nothing renders yet — S-02 owns that.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Metadata source | Supadata `GET /v1/metadata` | Covers all five descriptive fields in one call on the key the app already holds; oEmbed lacks duration and upload date, the Data API needs a new quota. | Docs |
| Language column | Persist as diagnostics, never display | The available field is the *transcript's* language, not the video's — showing it as "language" would be false exactly when auto-translated tracks exist. | Plan |
| Column naming | `transcript_lang`, `transcript_available_langs` | The name has to make it impossible to mistake for the video's spoken language. | Plan |
| Thumbnail column | Rename `thumbnail_url` → `thumbnail_url_reported` | The column has been null since F-01 and has no readers, so the breaking rename is free now and expensive once S-02 renders it; the new name states the value is the vendor's last response, never repaired. | Plan |
| Transcript request | Drop `lang: "pl"`, warn on large pools | `lang: "pl"` is the one setting that actively requests a non-original track; the size of `availableLangs` then answers the open auto-translation question from real traffic. | Plan |
| UI scope | None | S-08 is a hard prerequisite of S-02 precisely so the list is not retrofitted; a card here would be rebuilt by S-02 anyway. | Plan |
| RPC widening | Drop + create in one migration | Avoids a period where two `persist_summary` overloads exist and PostgREST has to disambiguate — at the cost of a short deploy window. | Plan |
| Metadata failure | One targeted retry, then null | Decorative data must never discard a summary that OpenRouter was already paid for; only network errors and `limit-exceeded` are transient. | Plan |
| Call placement | After `summarize()` | Keeps the 402/413/409 paths from spending a credit on a generation that never happens, and keeps two Supadata calls off the same second. | Roadmap |
| Backfill | None | Each backfilled row costs a real credit from 71 remaining, and S-02 needs a null fallback regardless. | Plan |

## Scope

**In scope:** five new nullable columns on `videos` plus the `thumbnail_url` → `thumbnail_url_reported` rename; a widened `persist_summary`; a new `metadata.ts` service; dropping `lang` from the transcript request and capturing `availableLangs`; wiring both into the generation endpoint; production rollout.

**Out of scope:** any UI; backfilling existing rows; storing thumbnail images; repairing a dead thumbnail URL (the `hqdefault` fallback is S-02's, render-time only, never written back); a real "video language" field via the YouTube Data API; the Supadata cost guardrail (S-09); widening the transcript-quote cache.

## Architecture / Approach

```
transcript fetch ──► summarize() ──► /metadata fetch ──► persist_summary()
  (lang dropped;      (unchanged)      (new, 1 credit,      (widened signature,
   availableLangs                       best-effort)         coalescing upsert)
   captured)
```

The metadata call sits after the LLM call on purpose: the free plan allows 1 request/second, and every early-exit path (insufficient credits, transcript too long, long-video confirmation) must be able to return without having spent a credit.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema + widened persist path | Columns exist; thumbnail column renamed; RPC accepts metadata; nulls passed | The RPC swap is the one irreversible-in-order step — old Worker + new schema is a broken combination |
| 2. Transcript language signals | Two language columns populate; large-pool warning | Dropping `lang` changes what the model receives on the paid path; a Polish video with extra human tracks may now get the wrong one |
| 3. Supadata metadata fetch | Remaining four fields populate | A malformed vendor value in a typed column would abort persist and refund an already-paid summary |
| 4. Production rollout | Live on Cloudflare | `db push` and `wrangler deploy` must run back to back or generations 500 in between |

**Prerequisites:** S-01 shipped (done); local Supabase stack via Docker; Supadata credits available (71 at last check); Cloudflare deploy access.
**Estimated effort:** ~1–2 sessions across 4 phases; roughly 6 Supadata credits consumed in verification.

## Open Risks & Assumptions

- **Whether YouTube auto-translated tracks enter Supadata's language pool is still unverified.** This plan does not settle it — it makes it observable by recording `availableLangs`. Dropping `lang` is a probability improvement, not a guarantee, because "first available" has no documented ordering.
- **The auto-translation warning threshold is a first guess** (native sets run 1–3 tracks, auto-translation pools 100+). It should be revisited once real rows exist.
- **The deploy window is real but small.** If it is hit, the user is refunded and sees a 500; the OpenRouter spend for that generation is lost.
- **The `allowLong` confirmation path persists null language**, because the quote cache carries no transcript. Accepted, not fixed.
- **The stored thumbnail URL is not guaranteed to resolve.** Supadata returns `maxresdefault.jpg`, which is absent on videos never uploaded above 480p. S-08 records the vendor string unvalidated by design; S-02's fallback must therefore cover two cases — a null column *and* a stored URL that 404s — and must not write the fallback back.
- **The rename is not re-runnable.** `alter table ... rename column` has no `if not exists` form, so unlike the column additions it is correct exactly once, and a rollback must reverse it alongside restoring the eight-argument function.
- **This slice halves the monthly Supadata ceiling** from ~100 to ~50 native-transcript generations. Acceptable at MVP volume, but it is a halving, not a rounding error.
- **S-09 may relocate the metadata call.** If that slice picks the duration pre-gate lever, this call moves to the front of the pipeline and stops being decorative.

## Success Criteria (Summary)

- A generation writes all seven fields for a normal video, and writes the summary anyway when the metadata call fails.
- A non-Polish video records its own language in `transcript_lang` — not `pl` — while the summary itself is still Polish.
- Re-summarising a video with the other character never erases metadata captured on the first run.
- Exactly one `persist_summary` exists in `pg_proc` after the swap, and one native-transcript generation costs exactly 2 Supadata credits.
