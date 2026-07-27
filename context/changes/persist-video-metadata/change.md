---
change_id: persist-video-metadata
title: "Persist video metadata: thumbnail, title, channel, length, date, language"
status: impl_reviewed
created: 2026-07-25
updated: 2026-07-26
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

**Open item ANSWERED by real traffic (2026-07-26):** the manual verification suite settled the
auto-translation question the plan deliberately left to observation. Supadata's `mode: "auto"`
does **not** return the original track: an English video with a `{en, de}` pool came back `de`,
and an English TED talk with a 61-language pool came back `af`. The German captions visibly
leaked into the summary, which described the elephants' "Rüssel". So the plan's design choice
was right — dropping `lang: "pl"` removed the *worst* lever, but it did not stop the vendor
handing back a machine-translated track anyway, and there is no API to ask for the original.
This directly contradicts the recorded user decision "never trade the original transcript for a
machine-translated one": that trade is happening, silently, and S-08 cannot prevent it. Needs a
follow-up against S-01/S-02. Pool sizes observed were 2 / 5 / 61, so
`LARGE_LANG_POOL_THRESHOLD = 15` currently flags human-translated catalogues (TED) rather than
auto-translation. Full write-up in `plan.md` §Manual Verification Findings.

**Manual verification complete (2026-07-26):** all 18 manual rows executed, 27/27 Progress rows
green, review verdict moved to APPROVED. One caveat on 4.3 — the production run took the
`allowLong` path, so the two language columns are proven locally but not yet on production.

**Plan review triaged (2026-07-25):** 7 findings — 6 fixed in the plan, 1 accepted. Accepted:
the `persist_summary` hard-swap keeps its deployment window (F1), judged a non-issue at this
stage rather than worth an expand/contract pair. The largest fix widened scope slightly: F6 turned
into a breaking rename of the empty, unread `videos.thumbnail_url` to
`thumbnail_url_reported`, taken now because the column has no readers and never will be
cheaper to rename. See `reviews/plan-review.md` for every decision.
