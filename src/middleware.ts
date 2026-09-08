import { defineMiddleware } from "astro:middleware";
import { createClient } from "@/lib/supabase";
import { getBalance } from "@/lib/services/credits";

const PROTECTED_ROUTES = ["/summaries", "/account"];

/**
 * Routes that only make sense signed OUT, redirected to `/summaries` for a user who already has a
 * session — the mirror of `PROTECTED_ROUTES`, which until now redirected in one direction only.
 *
 * Noticed while verifying the credit-balance fix (change `testing-phase-4-critical-flow-e2e`,
 * Phase 0): a signed-in user landing on `/auth/signin` got the sign-in form rendered underneath
 * their own topbar, credit balance and account menu — which reads like the app leaking someone
 * else's number to a signed-out visitor, and cost a round of investigation to rule out. It never was
 * a leak (`Topbar.astro` renders the balance only inside its `user ?` branch, and `locals.credits`
 * stays null without a user), but a page that invites that reading is worth not shipping.
 *
 * `/auth/callback` is deliberately absent: it is the endpoint that EXCHANGES an email-confirmation
 * code for a session, so it legitimately runs while a session is being established and redirecting it
 * would break the confirmation link. `/auth/confirm-email` is absent for a related reason — it is the
 * "check your inbox" page, and a user can plausibly reach it with a stale session from another
 * account still in the jar.
 */
const SIGNED_OUT_ONLY_ROUTES = ["/auth/signin", "/auth/signup"];

export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createClient(context.request.headers, context.cookies);

  if (supabase) {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    context.locals.user = user ?? null;
  } else {
    context.locals.user = null;
  }

  // The topbar shows credits globally, so the balance is read once per request here rather than
  // per component — but only for a signed-in user on a page route. API routes must not pay for a
  // display-only read.
  context.locals.credits = null;
  if (supabase && context.locals.user && !context.url.pathname.startsWith("/api/")) {
    try {
      // createClient returns supabase-js's default untyped client (no generated Database types
      // yet), so passing it where the service expects its explicit shapes is an unavoidable `any`
      // gap — same as the read this replaces (`dashboard.astro`).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      context.locals.credits = await getBalance(supabase, context.locals.user.id);
    } catch (err) {
      // Display-only: this balance is never the enforcement gate (that lives in the generation
      // endpoint, where getBalance must keep throwing), so a DB blip must not fail the request.
      // eslint-disable-next-line no-console
      console.error("middleware: credit balance read failed", err);
    }
  }

  if (PROTECTED_ROUTES.some((route) => context.url.pathname.startsWith(route))) {
    if (!context.locals.user) {
      return context.redirect("/auth/signin");
    }
  }

  if (context.locals.user && SIGNED_OUT_ONLY_ROUTES.some((route) => context.url.pathname.startsWith(route))) {
    return context.redirect("/summaries");
  }

  return next();
});
