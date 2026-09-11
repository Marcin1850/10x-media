---
change_id: persist-video-metadata
title: "Persist video metadata: thumbnail, title, channel, length, date, language"
status: archived
created: 2026-07-25
updated: 2026-09-11
archived_at: 2026-09-11T00:07:16Z
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

**Corrected and FIXED during impl-review triage (2026-07-27):** the paragraph above concluded
"S-08 cannot prevent it" and "needs a follow-up against S-01/S-02". Both were wrong — S-01 is
complete and S-02 covers only summary-list display, so no slice was waiting to receive it, and the
probe the plan declined to run turned out to be the thing that unblocked it.

The ~2-credit probe finally ran (3 credits). Two results. `lang` **selects** among existing caption
tracks and never requests a translation — Supadata translates only via a separate, explicitly-called
endpoint — so `lang: "pl"` was never "the one setting that can ask for a machine-translated track",
and the planning-time rationale for dropping it does not hold. And decisively: re-fetching
`jNQXAC9IVRw` with `lang: "en"` returned the genuine English original, while the no-`lang` call
returned `de` **despite `en` being listed first in `availableLangs`**. *Omitting `lang` was the
exposure, not the protection.*

The fetch now requests `lang: "en"` (F9), the quote cache carries both language fields so the
diagnostics stop skewing toward short videos (F10), and the pool-size warning was removed rather than
retuned, since the question it proxied for is now answered (F11). The user's recorded decision is
honoured as far as the vendor permits: no in-vendor lever can identify the original track
(`/v1/metadata` carries no language field at all), so the residual case — a Polish-original video
that also carries an English track — is measured by the diagnostic columns rather than prevented.
See `reviews/impl-review.md` F9–F11 and `docs/supadata-transcript.md` §Language selection.

**Manual verification complete (2026-07-26):** all 18 manual rows executed, 27/27 Progress rows
green, review verdict moved to APPROVED. One caveat on 4.3 — the production run took the
`allowLong` path, so the two language columns are proven locally but not yet on production.

**Re-verification complete (2026-07-27):** the F9 and F11 fixes changed transcript-path behaviour
that three manual rows had certified, so those rows were re-settled the same day. Rows **2.3** and
**2.5** were re-run against the local stack (2 generations, credits 9 → 7, both reservations
`settled`): `jNQXAC9IVRw` moved `de` → **`en`** and `iG9CE55wbtY` `af` → **`en`**, and the German
wording is gone from the delivered summary — it now reads "trąby" (from the English "trunks") where
the earlier run said "Rüssel". Row **2.6** is struck, not re-run: the warning it verified was removed.
Progress **27/27**, verdict APPROVED.

Coverage gap worth carrying forward: every language observation so far is English-source. The
residual risk F9 leaves open — a Polish-original video that also carries an English track, where
requesting `en` would take the translation — has never been exercised, because no Polish-language
video has gone through the pipeline. The diagnostic columns will surface it if it occurs.

Neither the new migration nor the Worker has been pushed to production yet.

**Plan review triaged (2026-07-25):** 7 findings — 6 fixed in the plan, 1 accepted. Accepted:
the `persist_summary` hard-swap keeps its deployment window (F1), judged a non-issue at this
stage rather than worth an expand/contract pair. The largest fix widened scope slightly: F6 turned
into a breaking rename of the empty, unread `videos.thumbnail_url` to
`thumbnail_url_reported`, taken now because the column has no readers and never will be
cheaper to rename. See `reviews/plan-review.md` for every decision.
