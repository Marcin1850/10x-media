import { expect, type Page } from "@playwright/test";

/**
 * Waits until every Astro island on the page has hydrated.
 *
 * **Why this is needed, and why nothing user-facing can replace it.** These pages are server-rendered
 * HTML with `client:load` React islands on top, so after `goto` resolves the form is on screen, fully
 * interactive-*looking*, and not yet wired. Typing into it in that window does not merely get ignored
 * — it corrupts the island: React installs its value tracker at hydration from whatever the DOM holds,
 * so it comes up believing the input's value is already the pre-typed string while its own state is
 * empty. Every later `fill()` of that same string is then a no-op (React fires `onChange` only when
 * the tracked value CHANGES), the submit button never leaves its disabled state, and the failure reads
 * like a broken form rather than a race. Retrying the interaction does not recover from it.
 *
 * **The one deliberate exception to "never locate by DOM".** There is no user-visible signal for
 * "hydrated" — that is precisely what makes the window dangerous. `<astro-island ssr>` is Astro's own
 * hydration contract (its client runtime removes the `ssr` attribute once a component mounts), not
 * this app's markup, so it survives every refactor of the pages themselves. It is confined to this
 * one helper so no spec ever writes a selector, and it is a readiness WAIT, never an element a test
 * acts on.
 */
export async function awaitIslandsHydrated(page: Page): Promise<void> {
  await expect(page.locator("astro-island[ssr]")).toHaveCount(0);
}
