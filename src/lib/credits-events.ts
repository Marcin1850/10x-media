/**
 * The one-way channel from the React island that learns a new credit balance to the Astro markup
 * that renders it.
 *
 * The balance in the topbar and on the account page is server-rendered from `Astro.locals.credits`,
 * read once per request in `middleware.ts`. Nothing corrected it afterwards — not on a charged
 * refusal, and not on the success path either — so the header kept showing a number the request the
 * user had just made already changed, and could sit next to a form saying "you have no credits left"
 * while still reading 1.
 *
 * A DOM event is the seam because there is no other one: the header is server-rendered Astro and the
 * generation form is a React island, so they share no component tree to pass a prop through and no
 * store worth introducing for a single integer.
 *
 * **This module deliberately imports nothing.** It is loaded by an inline `<script>` in
 * `Topbar.astro`, which renders on every page — pulling the constant from `useGenerateSummary.ts`
 * instead would drag React and the whole copy table into that bundle site-wide, to move one number.
 */

/** Name shared by the dispatcher and the listener; a typo would fail silently and look like the bug this fixes. */
export const CREDITS_CHANGED_EVENT = "credits:changed";

/**
 * Announces a balance the server just reported.
 *
 * Guarded for the absence of `window` because the modules that call this are also imported by plain
 * unit tests, which run in Vitest's node environment and have no DOM.
 */
export function announceBalance(balance: number): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<number>(CREDITS_CHANGED_EVENT, { detail: balance }));
}

/**
 * Applies an announced balance to every element that renders one.
 *
 * Targets all `[data-credit-balance]` nodes rather than one id on purpose: the topbar and the account
 * page render the same number, and they must not be able to disagree with each other.
 *
 * When the balance was unavailable at request time the markup renders a skeleton with no such node,
 * and this updates nothing. That is correct rather than a gap — we never had a number to contradict,
 * and a figure that appeared mid-page would be the only one on screen with nothing corroborating it.
 */
export function startCreditsBalanceSync(): void {
  window.addEventListener(CREDITS_CHANGED_EVENT, (event) => {
    const balance = (event as CustomEvent<number>).detail;
    if (typeof balance !== "number") return;
    for (const node of document.querySelectorAll("[data-credit-balance]")) {
      node.textContent = String(balance);
    }
  });
}
