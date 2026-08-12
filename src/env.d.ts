declare namespace App {
  interface Locals {
    user: import("@supabase/supabase-js").User | null;
    /**
     * Display-only balance for the topbar, resolved once per page request. `null` means unknown —
     * unconfigured Supabase, a missing row, or a failed read — and renders as the shimmering
     * "Unknown" slot, never `0`. This is never the enforcement gate; that lives in the generation
     * endpoint, which reads its own balance and keeps throwing on failure.
     */
    credits: number | null;
  }
}
