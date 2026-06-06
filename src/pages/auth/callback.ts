import type { APIRoute } from "astro";
import { createClient } from "@/lib/supabase";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const url = new URL(context.request.url);
  const code = url.searchParams.get("code");
  // Supabase appends error details on the query string when a link is invalid
  // or expired (e.g. otp_expired). Surface them on the sign-in page.
  const errorDescription = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (errorDescription) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent(errorDescription)}`);
  }

  if (!code) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent("Missing confirmation code")}`);
  }

  const supabase = createClient(context.request.headers, context.cookies);
  if (!supabase) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent("Supabase is not configured")}`);
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return context.redirect(`/auth/signin?error=${encodeURIComponent(error.message)}`);
  }

  return context.redirect("/");
};
