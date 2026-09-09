import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { isLoopbackHostname } from "./loopback-guard";
import { closeDbOwnerConnection } from "./db-owner";

/**
 * Fails the paid-vendor boundary CLOSED (test-plan §7, "no test ever spends real...credits") instead of
 * relying on each scenario's cache-hit setup to happen to stay away from it. Every integration test
 * starts with `fetch` replaced by this guard; a real-database test that regresses (a cache lookup, TTL,
 * or language-match bug) hits `throw`, not the live vendor. A stub-layer test that wants scripted vendor
 * responses still calls `vi.stubGlobal("fetch", ...)` itself (see `stubSupadataFetch`) — that simply
 * overrides this default for the current test; `afterEach` below re-installs the firewall rather than
 * leaving `vi.unstubAllGlobals()` fall through to the native, unguarded `fetch`.
 */
const nativeFetch = globalThis.fetch;

function firewalledFetch(input: RequestInfo | URL, init?: RequestInit): ReturnType<typeof fetch> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    throw new Error(`fetch-firewall: could not parse a hostname from fetch target "${rawUrl}"`);
  }

  if (isLoopbackHostname(hostname)) {
    return nativeFetch(input, init);
  }

  throw new Error(
    `fetch-firewall: blocked a non-loopback fetch to "${rawUrl}". Integration tests must never reach a ` +
      "live vendor — stub fetch explicitly (see stubSupadataFetch in __fixtures__/generation-harness.ts) " +
      "if this call is intentional.",
  );
}

/**
 * Vendor keys the real .env supplies are never allowed to reach an integration test's process.env —
 * even code paths this suite doesn't intend to exercise (a stray transcript/LLM call) then use garbage
 * credentials, on top of the firewall above blocking the network call outright. `astro:env/server` is
 * aliased to a stub that reads these off `process.env` at import time, so this must run before a test
 * file's own top-level imports — `setupFiles` execute before that file's code, so a bare module-scope
 * assignment here (not inside a hook) is early enough.
 */
process.env.SUPADATA_API_KEY = "firewalled-placeholder-supadata-key";
process.env.OPENROUTER_API_KEY = "firewalled-placeholder-openrouter-key";

beforeEach(() => {
  vi.stubGlobal("fetch", firewalledFetch);
});

afterEach(() => {
  vi.stubGlobal("fetch", firewalledFetch);
});

// A no-op for test files that never open one (`getDbOwnerConnection` is lazy) — closes the per-file
// owner pool (src/test/db-owner.ts) opened by tests that need direct table-owner access (F2).
afterAll(async () => {
  await closeDbOwnerConnection();
});
