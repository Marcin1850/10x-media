---
change_id: testing-phase-4-critical-flow-e2e
title: Critical-flow e2e — test-plan Phase 4
status: implementing
created: 2026-09-07
updated: 2026-09-09
archived_at: null
---

## Notes

Open a change folder for rollout Phase 4 of context/foundation/test-plan.md: "Critical-flow e2e".
Risks covered: #6 — a UI refactor silently misreports paid work, a card that does not match what was actually charged or saved (roadmap S-02 Phase 3 "no behaviour change by design"; S-06 shipped a `charged` signal on three 422 bodies while scoped as presentational; hot-spot dir `src/components/summaries/` — 46 commits/30d) — plus cross-cutting flow coverage. Test types planned: e2e (Playwright).
Scope note: Phase 4's gate half (typecheck in CI, husky pre-commit/pre-push) shipped early and out of phase order on 2026-09-04. **What remains is the e2e half only** (test-plan.md:69).
Risk response intent: prove the flow works end to end — what a card claims about charge and outcome matches what the request actually did. Challenge the assumption that "no behaviour change by design" means no behaviour changed. Anti-pattern to avoid: snapshot tests — they break on every design tweak and catch none of this.
Scope decisions taken at research scoping: layer scope deferred to research (research recommends **e2e only** — see research.md Finding 1); all four flows in scope (generate→see summary, auth + credit balance, long-video confirmation, charged refusal exits); vendor faking to assume cache pre-seeding works and research the LLM gap (assumption **verified**, holds — Finding 2b).

**Scope addition — Phase 0, decided 2026-09-07 (user).** Research surfaced a defect that would otherwise be normalised by the tests written on top of it: after a charged 422 refusal the header credit balance stays stale until reload, because the refusal body carries no balance and `setCredits` runs only on the success path. This is the unfinished half of S-06 Phase 9's supersession of roadmap D14 consequence (2) — the qualitative `charged` signal shipped, the quantitative balance never did. **The plan opens with a non-e2e Phase 0** that passes `chargeFailedTranscript`'s already-computed balance through the 422 body as `creditsRemaining`, updates the hook, and narrows README:261 (which still claims the UI shows the ambiguous case). Covered by unit + integration per §1's cost×signal rule, not e2e. No e2e phase asserting a balance may start before it lands.

Rulings taken during research (2026-09-07, user): English refusal copy is **intentional** (roadmap S-06; e2e asserts the English server string). `ambiguousCharge` rendering nothing is **intentional** (spec asserts absence of both charge lines). Logging without alerting — no Sentry, Cloudflare Workers Logs only — is **acceptable for now**.

**Two rulings revised during Phase 0 implementation, 2026-09-08 (user), after reviewing the phase's own manual pass.**

1. **The English refusal copy ruling is REVERSED — refusal copy is now Polish.** Seeing `This video has no captions…` in a Polish UI, the user reopened the 2026-09-07 decision. The client used to prefer the server's English `error` over its per-status Polish table for a real reason (one status, several causes; the table had one entry per status), so the fix is a **cause code**, not a translation: the endpoint sends `code` beside `error`, and `copy.errors.codes` localises it — which keeps every distinction the English string carried. Applied to the transcript/credit refusals: the three 422 refusal reasons, the transient 422, and both 402s. **Consequence for later phases: specs assert the POLISH string, not the English server one** — the opposite of what Phases 2–4 were written against.
2. **The header credit balance now syncs client-side** (`src/lib/credits-events.ts`). Phase 0 made the form's gate truthful while the server-rendered topbar kept its pre-request number, so one page could read `Kredyty 1` beside "Nie masz już kredytów". The plan had scoped this out on the grounds that the header never syncs on *any* path; the user's call is that a page contradicting itself is worse than one uniformly stale, so the seam was built. It fixes the success path too. **Consequence for later phases: a header assertion no longer requires a navigation** — the plan's "every header assertion follows a reload" rule is now obsolete.

Not reopened, and worth restating because they look similar: the `Za tę operację pobrano kredyt.` line stays (it is S-06's shipped signal, README §Summary credits, and the ledger confirms the charge is real); `ambiguousCharge` still renders nothing.

**Extended the same day, on the user's follow-up**, to every remaining generate-endpoint exit — 400, 429, 500, 503 and the "already processed" 409 — so nothing the card can render is English. Codes are shared where several `return`s say the same thing to a user and kept separate where they do not; the two 502s and the 401 carry no code because their per-status Polish message is already correct.

3. **Signed-in users are redirected away from `/auth/signin` and `/auth/signup`** (`SIGNED_OUT_ONLY_ROUTES` in `src/middleware.ts`). Noticed during the same manual pass and reported as a suspected credit leak: the sign-in form rendered under a signed-in user's own topbar and balance. Verified it was **not** a leak — a genuinely signed-out session shows "Zaloguj się / Zarejestruj się" and zero balance nodes — but the page invited the reading, so the redirect closes it. `/auth/callback` and `/auth/confirm-email` are deliberately excluded; see the constant's doc comment.

**Ruling taken during Phase 1 implementation, 2026-09-08 (user).**

4. **No `setup` project and no `storageState` — auth is injected by a per-test account fixture.** The
plan's Phase 1 config contract named a Playwright `setup` project, and "What We're NOT Doing" said auth
arrives via `storageState`; Phase 2's own contract meanwhile injects it through a per-test `test.extend`
fixture, which leaves a `setup` project with nothing to produce. Raised before the config was written.
The user's call is the per-test fixture, because the dimension the specs vary is the credit **balance**,
and the balance is state the specs themselves spend — Phase 3 wants 1 credit, Phase 4 wants 2+, and each
oracle is a delta read for its own `user_id`, so one shared session stops being deterministic under the
`--repeat-each=2` the plan requires. The rule that mattered is untouched: the sign-in form is still never
driven, cookies are minted server-side by `createSyntheticAccount`.

Not a ruling but recorded with them, because it reverses something the plan asserted: **the LLM seam
could not be a `vite.resolve.alias` entry**, nor the array-form fallback the plan named. Astro contributes
its own `@/*` alias from a plugin `config()` hook, Vite merges plugin aliases ahead of user ones by
design, and the first match wins — so the entry was never consulted and `E2E_FAKE_LLM=1 npm run build`
kept bundling the real module. The seam is an `enforce: "post"` plugin instead. Caught by the plan's own
build-output check rather than by reading the config, which is exactly what that check was for.

**Ruling taken during impl-review triage of Phases 1-2, 2026-09-09 (user).**

5. **The e2e suite runs against a built `preview` in every environment, never a reused server.** The
plan had `npm run dev` locally for the fast loop with `reuseExistingServer`, which the review found
could spend real vendor credit: a bare `npm run dev` in another terminal is reused as-is, without the
fake-LLM alias, so the first spec calls OpenRouter for real. Fixing that exposed a second fact only
measurement could reveal — **the e2e vendor keys cannot be passed through `webServer.env` at all**,
because @astrojs/cloudflare re-reads the fixed-name `.dev.vars` into `process.env` and the developer's
real keys win. A worker-side probe confirmed it both ways. The keys therefore arrive as a wrangler
environment: `CLOUDFLARE_ENV=e2e` selects a **committed** `.dev.vars.e2e` holding the Supabase CLI's
public local demo keys plus deliberate non-credentials for Supadata and OpenRouter — and that file only
reaches the app under `preview`, which is the second reason the local runner changed. The cost the user
accepted is a ~30 s build in front of every run; the same change also removed the cold-start flake that
made the seed spec fail on a clean dev server.

**Ruling taken during Phase 3 implementation, 2026-09-09 (user).**

6. **The transient `failed`/`timeout` 422 is dropped from the e2e layer — it is not browser-reachable.**
The plan's Phase 3 contract paired the two charged refusals with this one uncharged exit, which is the
only producer of the card's `Nie pobrano kredytu za tę operację.` line. It cannot be reached without a
real vendor call: the exit sits in the cache-**MISS** branch after a live `fetchTranscript`, those two
outcomes are never cached by design, `failed` comes only from a Supadata job the vendor reports failed
and `timeout` only from the poll loop expiring, and the non-credential key in `.dev.vars.e2e` yields a
401 that throws to a **502** rather than to this 422. A transcript seam mirroring `E2E_FAKE_LLM` was
weighed and rejected — it is Phase-1-shaped work landing in Phase 3, and it dissolves the documented
"Supadata falls to data, OpenRouter falls to code" split. Substituting the 402 insufficient-credits
refusal was also rejected: the card says "not charged" there by *silence*, not by the line. The gap is
recorded in `test-plan.md` §6.4 beside `ambiguous`, with its consequence stated — that line's rendering
has no coverage at any layer; the server-side contract stays pinned at the integration layer.
**Consequence: Phase 3 ships the two charged causes**, and the distinction between them is asserted on
BOTH sides — the Polish copy the card resolves from the server's `code`, and the `refusal_reason` the
ledger actually recorded.

Linear: MAR-22.
