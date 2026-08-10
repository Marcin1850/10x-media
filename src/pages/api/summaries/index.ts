import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";
import { listSummaries } from "@/lib/services/summary-list";

export const prerender = false;

/**
 * The caller's own summaries, newest first, joined to their video metadata.
 *
 * Read-only and RLS-scoped: the id comes from `context.locals.user` (server-resolved from the session
 * cookie) and the select runs on the anon SSR client, so a user can only ever observe their own rows
 * even if the filter were dropped. No service-role client is involved and no paid path is touched.
 *
 * No query parameters — the character filter is client-side (see `SummaryList`), so there is no
 * server-side filtering surface to keep in sync with it. The dashboard server-renders the same list
 * via `listSummaries` directly; this endpoint exists for the client re-read after a generation, and
 * is deliberately shaped so S-03 (delete) can reuse it unchanged.
 */
export const GET: APIRoute = async (context) => {
  if (!context.locals.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return Response.json({ error: "Supabase is not configured" }, { status: 503 });
  }

  try {
    // createClient returns supabase-js's default untyped client (no generated Database types yet), so
    // passing it where the service expects its explicit shapes is an unavoidable `any` gap — same as
    // the dashboard's getBalance call.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const summaries = await listSummaries(supabase, context.locals.user.id);
    return Response.json({ summaries }, { status: 200 });
  } catch (error) {
    // Mask the provider's message behind a stable generic 500, matching generate.ts and
    // account/delete.ts — the browser never sees raw Supabase details.
    // eslint-disable-next-line no-console
    console.error("GET /api/summaries failed:", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
};
