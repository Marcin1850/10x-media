# Library / API reference — persist-time-and-cost (S-07)

Vendor reference captured during **plan review** of S-07, to settle finding F1: the proposed ledger (`operation` / `outcome` / `resolved_via`) cannot produce the exact-credit and Whisper-fallback numbers the plan promises S-09. Fetched via **Context7** (`/llmstxt/supadata_ai_llms_txt`, `/supadata-ai/js`) on **2026-07-28**, plus direct inspection of the installed `@supadata/js@1.4.0` bundle.

| File | API surface | Role |
| --- | --- | --- |
| [`supadata-billable-requests.md`](./supadata-billable-requests.md) | `x-billable-requests` response header | The per-request credit figure F1's fix persists as `billable_credits`; why the SDK can't hand it over and which in-repo pattern can |

## Relationship to the S-08 docs

`../../persist-video-metadata/docs/` (fetched 2026-07-25, extended 2026-07-27) covers the same vendor across `/v1/transcript`, `/v1/metadata` and `/v1/me`, and remains the authority on **per-credit prices**, `mode` semantics, `lang` selection, and rate limits. This file extends it with one thing those docs never covered: how to observe what a *single* request was actually billed.

## Open at capture time

Two things the vendor docs leave open, both settled by Phase 5's `GET /v1/me` reconciliation rather than by more reading:

1. **Unit.** The header is named `x-billable-requests` but documented as the way to monitor *credit usage*. A 3-minute Whisper job is 1 request and 6 credits — so if it reports a count, `resolved_via` + `duration_seconds` stay load-bearing for costing. Must be checked on a `job`-path video; a native short video reads 1 either way and proves nothing.
2. **Coverage.** "Included in every API response" says nothing about the `202` job-accepted response, the free job-status polls, or 4xx/5xx.

Phase 3 records whatever arrives (nullable, verbatim) so neither unknown blocks implementation — see the two §"⚠️ Unverified" sections in the file.
