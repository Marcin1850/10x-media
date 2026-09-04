import { describe, expect, it } from "vitest";
import * as generateEndpoint from "@/pages/api/summaries/generate";
import { assertLoopbackSupabaseUrl } from "./integration-setup";

/**
 * Proves the harness before anything depends on it (plan.md Phase 2, item 5). Oracle: research.md
 * §2.2 — the `astro:env/server` alias makes the endpoint importable under a plain `vitest/config`
 * with no adapter involvement — and the "Critical Implementation Details" guard requirement.
 */
describe("integration harness", () => {
  it("imports the generation endpoint and exposes a non-prerendered POST handler", () => {
    expect(typeof generateEndpoint.POST).toBe("function");
    expect(generateEndpoint.prerender).toBe(false);
  });

  it("rejects a non-loopback SUPABASE_URL", () => {
    expect(() => {
      assertLoopbackSupabaseUrl("https://production-project.supabase.co");
    }).toThrow(/does not resolve to loopback/);
  });

  it("rejects an unset SUPABASE_URL", () => {
    expect(() => {
      assertLoopbackSupabaseUrl(undefined);
    }).toThrow(/is unset/);
  });

  it("accepts a loopback SUPABASE_URL", () => {
    expect(() => {
      assertLoopbackSupabaseUrl("http://127.0.0.1:54321");
    }).not.toThrow();
  });
});
