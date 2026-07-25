# Library / API reference — persist-video-metadata (S-08)

Supadata API reference captured while scoping S-08 (video metadata) and S-09 (transcript cost guardrail). Fetched via **Context7** (`/llmstxt/supadata_ai_llms_txt`) on **2026-07-25**, plus one live `GET /v1/me` call against the project's own key. See `context/foundation/roadmap.md` §S-08 / §S-09 for the decisions these files back; the files themselves are the raw API reference to code against.

| File | API surface | Role |
| --- | --- | --- |
| [`supadata-metadata.md`](./supadata-metadata.md) | `GET /v1/metadata` | The new call S-08 adds — title, channel, duration, upload date, thumbnail |
| [`supadata-transcript.md`](./supadata-transcript.md) | `GET /v1/transcript` | The call the app already makes; `mode` and `lang` semantics behind S-09 and S-08's language question |
| [`supadata-account-limits.md`](./supadata-account-limits.md) | `GET /v1/me`, plans, rate limits, errors | Budget/rate-limit envelope both slices have to fit inside |

## Relationship to the F-02 docs

`../../transcript-llm-probe/docs/supadata.md` (fetched 2026-07-05) covers the same vendor from the transcript angle and is **still accurate on mechanics** — SDK usage, REST shape, the three `mode` values, and per-credit transcript pricing. These files extend it rather than replace it: the metadata endpoint, the `lang` selection semantics, the account/rate-limit envelope, and the discrepancies noted below are new here.

> ⚠️ **Provenance correction worth knowing:** the "2 credits/min for generated transcripts" figure that motivates S-09 was **already recorded in the F-02 docs on 2026-07-05** (`../../transcript-llm-probe/docs/supadata.md:43`). What happened on 2026-07-25 was not discovering the price — it was doing the arithmetic against the 100-credit plan and noticing nothing in the code bounds it. The fact was captured and never turned into a guardrail, which is the more useful lesson.

## Reliability caveats

- **Plan pricing is unreliable in both sources and should be re-checked live.** F-02's doc says Basic $5 → 300 credits, Pro $17 → 3,000. This session's Context7 extraction says Basic free/100, Pro **$9** → 1,000, up to Supa $897 → 1,000,000 — and contradicts *itself* on throughput (one snippet says 100 req/s for Supa, another says 500 req/s for Giga). Either pricing changed between July 5 and July 25 or the extraction is lossy. Treat `GET /v1/me` and supadata.ai/pricing as the only authorities; per-credit costs (1 native / 2-per-min generated / 1 metadata) were consistent across sources and are the numbers the slices reason with.
- **One question is genuinely unanswered by these docs:** whether YouTube *auto-translated* or *auto-generated* caption tracks enter the `lang` / `availableLangs` pool. See `supadata-transcript.md` §Language selection. It matters for S-08's recorded decision (never feed the model a machine-translated transcript in place of the original) and is settleable only empirically.
