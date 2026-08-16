import { defineMiddleware } from "astro:middleware";
import { createClient } from "@/lib/supabase";
import { getBalance } from "@/lib/services/credits";

const PROTECTED_ROUTES = ["/summaries", "/account"];

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

  return next();
});
