# Phase 1 — Manual verification record

- **Change**: `browse-summary-list` (S-02)
- **Phase**: 1 — read path: `SummaryListItem` DTO, `listSummaries` service, `GET /api/summaries`
- **Date**: 2026-08-07
- **Environment**: **local only** — dev server on `localhost:4321` started on the reviewed commit
  `79e1102`, local Supabase stack on `127.0.0.1:54321`. Nothing deployed.
- **Accounts**: three local accounts — **A** (operator account), **B** (`verify-s09b@local.test`),
  **C** (`verify-s09@local.test`). A is the only one holding the two pre-S-08 null-metadata rows, so
  it carries criterion 1.4; B and C give two independent isolation counterparts rather than one.
- **Result**: **all four rows pass (1.3–1.6)**.

## Method

No summary was generated, so this pass **spent zero credits** — the whole phase is a read path.

Sessions were minted through the local GoTrue admin API (`admin/generate_link` → `verify`) and the
resulting session was serialized by `@supabase/ssr`'s own `createServerClient`, so the cookie the
requests carry is byte-identical to what a browser sign-in produces. Two reasons this over typing
passwords: no credential ends up in a transcript, and the cookie format is taken from the library the
app reads rather than hand-rolled, so a format drift would fail loudly instead of silently producing
a signed-out request that looks like a 401 bug.

Ground truth came from a direct service-role PostgREST read of `summaries` (16 rows across 4 users),
taken before the endpoint was called, and each response was diffed against it.

## Results

### 1.3 — Only the caller's own rows, newest first — **PASS**

| Account | Rows returned | Rows in DB for that user | `createdAt` descending |
|---|---|---|---|
| A | 5 | 5 | OK |
| B | 1 | 1 | OK |
| C | 7 | 7 | OK |

Every response is `200` with a single top-level `summaries` key. Each item carries exactly the 11
DTO fields — `id, character, content, createdAt, youtubeId, url, title, thumbnailUrlReported,
channelName, durationSeconds, publishedAt`. No telemetry (`cost_usd`, `model`, `generation_ms`) and
no `transcript_lang` appears, which is the shape the plan's "not doing" list requires. `url` is
non-null on all 13 rows, so the DTO's decision to keep it and `youtubeId` non-nullable holds against
real data.

Ordering was checked by comparing the returned `createdAt` sequence against its own reverse-sorted
copy, not by eyeballing — the C response has two rows 39 s apart on the same day, which a visual
scan would not have distinguished.

### 1.4 — Null-metadata rows present with their summary intact — **PASS**

Account A's response contains all three pre-S-08 rows:

| `youtubeId` | Character | Metadata | Content |
|---|---|---|---|
| `1zKTCcdVcGQ` | informational | all five fields null | 3351 chars |
| `dQw4w9WgXcQ` | educational | all five fields null | 1647 chars |
| `dQw4w9WgXcQ` | informational | all five fields null | 514 chars |

"All five null" means `title`, `thumbnailUrlReported`, `channelName`, `durationSeconds` and
`publishedAt` — while `youtubeId` and `url` are present. That is exactly the split the DTO assumes,
and it confirms `toListItem`'s throw-on-missing-embed guard is not being tripped by ordinary null
metadata: the video row exists, only its descriptive columns are empty.

The plan named two null-metadata *videos*; the read returns **three** null-metadata *summaries*,
because `dQw4w9WgXcQ` was summarized under both characters. That is the flat-list duplication the
plan explicitly accepts, not a defect — and Phase 2's criterion 2.4 already covers rendering it.

### 1.5 — No cross-account leakage — **PASS**

Intersecting the returned `id` sets pairwise: `A∩B = 0`, `A∩C = 0`, `B∩C = 0`. Sizes 5 / 1 / 7,
union 13 — no row is served to more than one account.

Note the read is doubly scoped: `listSummaries` filters on `user_id`, *and* the select runs on the
anon SSR client under the owner-scoped `summaries_select_authenticated` policy. This test exercises
both together and cannot by itself prove the RLS layer alone would hold — the explicit filter would
mask a policy regression. That is acceptable here because the policy is unchanged by this phase, but
it means a future change to those policies is not covered by this row.

### 1.6 — Signed out returns 401 — **PASS**

```
$ curl -i http://localhost:4321/api/summaries
HTTP/1.1 401 Unauthorized
content-type: application/json

{"error":"Unauthorized"}
```

No cookie, no body leakage, and the response is produced before any Supabase client is constructed
(`index.ts:20-24`), so an unauthenticated request never reaches the database.

## Not covered by this pass

- The `503` (Supabase unconfigured) and `500` (read failure) arms were not exercised. Neither is in
  the phase's criteria, and Phase 2's criterion 2.10 forces the failure path through the dashboard,
  which is where a user can actually observe it.
- The fourth local account (3 summaries) was not read; three accounts already cover the ownership,
  isolation and null-metadata cases.
