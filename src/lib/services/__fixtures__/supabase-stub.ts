import { vi, type Mock } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The hermetic seam for the credit-ledger services (test-plan §6.1, layer 2).
 *
 * The seam is the **injected client**, not the vendor HTTP boundary — `beginGeneration`,
 * `chargeFailedTranscript` and `lookupRefusalReplay` are pure with respect to the admin client they
 * are handed, so a bare object exposing only `rpc` is a complete substitute. Nothing here mocks
 * `fetch`, Supabase's transport, or a paid vendor; API mocking stays out of this rollout phase.
 *
 * Three shapes, because the ledger services distinguish three failure worlds and conflating them is
 * exactly the bug the tests exist to catch:
 *
 * - `stubReturning(data)` — PostgREST answered: `{ data, error: null }`.
 * - `stubFailing(message)` — PostgREST returned a STRUCTURED error: `{ data: null, error }`. The RPC's
 *   statement raised inside its own transaction and rolled back, so this is the one shape that proves
 *   nothing was written.
 * - `stubRejecting(cause)` — the request promise REJECTED. A transport failure can happen after
 *   Postgres commits, so this proves nothing either way. It is first-class here rather than improvised
 *   per test precisely because the `ambiguous` outcome exists for it alone.
 */
export interface SupabaseStub {
  /** Pass where production expects the service-role admin client. */
  client: SupabaseClient;
  /** The same mock, exposed so a test can assert how the RPC was called. */
  rpc: RpcMock;
}

type RpcFn = (fn: string, params?: Record<string, unknown>) => Promise<unknown>;
type RpcMock = Mock<RpcFn>;

function stubFrom(rpc: RpcMock): SupabaseStub {
  // The production signatures take supabase-js's untyped default client (this repo has no generated
  // Database types), so the cast is at the boundary and no production type changes for the tests.
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

/** PostgREST answered successfully with `data`. */
export function stubReturning(data: unknown): SupabaseStub {
  return stubFrom(vi.fn<RpcFn>().mockResolvedValue({ data, error: null }));
}

/** PostgREST returned a structured error — the statement rolled back. */
export function stubFailing(message = "boom"): SupabaseStub {
  return stubFrom(vi.fn<RpcFn>().mockResolvedValue({ data: null, error: { message } }));
}

/** The request itself failed in transport — the statement may or may not have committed. */
export function stubRejecting(cause: unknown = new TypeError("fetch failed")): SupabaseStub {
  return stubFrom(vi.fn<RpcFn>().mockRejectedValue(cause));
}
