---
change_id: persist-video-metadata
title: "Persist video metadata: thumbnail, title, channel, length, date, language"
status: plan_reviewed
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

**Plan review triaged (2026-07-25):** 7 findings — 6 fixed in the plan, 1 accepted. Accepted:
the `persist_summary` hard-swap keeps its deployment window (F1), judged a non-issue at this
stage rather than worth an expand/contract pair. The largest fix widened scope slightly: F6 turned
into a breaking rename of the empty, unread `videos.thumbnail_url` to
`thumbnail_url_reported`, taken now because the column has no readers and never will be
cheaper to rename. See `reviews/plan-review.md` for every decision.
