---
change_id: persist-video-metadata
title: "Persist video metadata: thumbnail, title, channel, length, date, language"
status: planned
created: 2026-07-25
updated: 2026-07-25
archived_at: null
---

## Notes

S-08 from roadmap

Source: `context/foundation/roadmap.md` §S-08 (renamed + rescoped 2026-07-25; scope notes there
carry the measured Supadata cost/rate-limit findings and the `persist_summary` RPC constraint).

Open item feeding the plan: whether YouTube auto-translated caption tracks enter Supadata's
`lang` / `availableLangs` pool — unresolved in the docs, settleable with a ~2-credit probe. The
user's decision is recorded: never trade the original transcript for a machine-translated one.

**Resolved during planning (2026-07-25):** no probe. The plan drops the `lang: "pl"` request
outright — it is the one setting that can ask for a machine-translated track — and persists
`transcript_lang` + `transcript_available_langs` so the question is answered by real traffic
instead of a paid one-off. Language is diagnostic only, never rendered; a card labelled
"language" would be false exactly when auto-translated tracks exist. See `plan-brief.md`
§Key Decisions.
