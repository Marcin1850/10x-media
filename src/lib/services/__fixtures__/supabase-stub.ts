import { vi, type Mock } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppSupabaseClient } from "@/lib/services/summaries";

/**
 * The hermetic seam for the services that are pure with respect to an injected Supabase client
 * (test-plan §6.1, layer 2).
 *
 * The seam is the **injected client**, not the vendor HTTP boundary — `beginGeneration`,
 * `chargeFailedTranscript`, `lookupRefusalReplay` and `deleteSummary` are pure with respect to the
 * client they are handed, so a bare object exposing the calls they make is a complete substitute.
 * Nothing here mocks `fetch`, Supabase's transport, or a paid vendor; API mocking stays out of this
 * rollout phase.
 *
 * Two seams live here, because the services reach the database two different ways:
 *
 * - **`rpc`** — the credit-ledger services, which call `SECURITY DEFINER` functions.
 * - **the query builder** (`.from().delete().eq().select()`) — `deleteSummary` (S-03), a plain
 *   RLS-scoped statement with no RPC behind it. See `stubDeleting` and friends at the bottom.
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

/**
 * The query-builder seam: `.from(table).delete().eq(column, value).select(columns)`.
 *
 * Each link is its own mock, so a test can assert **which table** and **which id** the service asked
 * for — and, just as importantly, that it asked for nothing else. `eq` receiving exactly one call is
 * what pins `deleteSummary`'s "no `user_id` predicate" property, which keeps the RLS policy rather
 * than the query as the trust boundary (`test-plan.md` §6.3 rule 3).
 *
 * The chain terminates at `select`, which resolves the `{ data, error }` envelope PostgREST returns.
 * Same three shapes as the RPC seam above, for the same reason: a structured error means the
 * statement rolled back, while a rejected promise proves nothing either way.
 */
export interface QueryStub {
  /** Pass where production expects an RLS-scoped `AppSupabaseClient`. */
  client: AppSupabaseClient;
  from: Mock<(table: string) => unknown>;
  delete: Mock<() => unknown>;
  eq: Mock<(column: string, value: unknown) => unknown>;
  select: Mock<(columns?: string) => Promise<unknown>>;
}

function queryStubFrom(select: Mock<(columns?: string) => Promise<unknown>>): QueryStub {
  const eq = vi.fn<(column: string, value: unknown) => unknown>().mockReturnValue({ select });
  const del = vi.fn<() => unknown>().mockReturnValue({ eq });
  const from = vi.fn<(table: string) => unknown>().mockReturnValue({ delete: del });
  // Same boundary cast as `stubFrom`: production takes supabase-js's client type, and this repo has
  // no generated Database types, so the shape is asserted here rather than in production code.
  return { client: { from } as unknown as AppSupabaseClient, from, delete: del, eq, select };
}

/** PostgREST answered successfully — `rows` is what `.select()` reported as affected. */
/**
 * `null` is a distinct shape from `[]`, not a synonym for it: it is what PostgREST answers when no
 * representation was requested — a `DELETE` whose `.select()` was dropped. Both must read as "nothing
 * was deleted", so the caller's `?? []` fallback needs a stub that can produce it.
 */
export function stubDeleting(rows: { id: string }[] | null): QueryStub {
  return queryStubFrom(vi.fn<(columns?: string) => Promise<unknown>>().mockResolvedValue({ data: rows, error: null }));
}

/** PostgREST returned a structured error — the DELETE rolled back, nothing was removed. */
export function stubDeleteFailing(message = "boom"): QueryStub {
  return queryStubFrom(
    vi.fn<(columns?: string) => Promise<unknown>>().mockResolvedValue({ data: null, error: { message } }),
  );
}

/** The request itself failed in transport — the DELETE may or may not have committed. */
export function stubDeleteRejecting(cause: unknown = new TypeError("fetch failed")): QueryStub {
  return queryStubFrom(vi.fn<(columns?: string) => Promise<unknown>>().mockRejectedValue(cause));
}

/**
 * The UPDATE sibling of the query-builder seam: `.from(table).update(payload).eq(column, value).select(columns)`
 * — `setWorthWatching` (S-14). `update` is its own mock so a test can assert the payload is exactly
 * `{ worth_watching }`: the column grant (20260914120000) refuses any other column, and a service that
 * sent one would turn every mark into a 500.
 */
export interface UpdateQueryStub {
  /** Pass where production expects an RLS-scoped `AppSupabaseClient`. */
  client: AppSupabaseClient;
  from: Mock<(table: string) => unknown>;
  update: Mock<(payload: Record<string, unknown>) => unknown>;
  eq: Mock<(column: string, value: unknown) => unknown>;
  select: Mock<(columns?: string) => Promise<unknown>>;
}

function updateStubFrom(select: Mock<(columns?: string) => Promise<unknown>>): UpdateQueryStub {
  const eq = vi.fn<(column: string, value: unknown) => unknown>().mockReturnValue({ select });
  const update = vi.fn<(payload: Record<string, unknown>) => unknown>().mockReturnValue({ eq });
  const from = vi.fn<(table: string) => unknown>().mockReturnValue({ update });
  return { client: { from } as unknown as AppSupabaseClient, from, update, eq, select };
}

/** PostgREST answered successfully — `rows` is what `.select()` reported as updated (`null`: no representation). */
export function stubUpdating(rows: { id: string }[] | null): UpdateQueryStub {
  return updateStubFrom(vi.fn<(columns?: string) => Promise<unknown>>().mockResolvedValue({ data: rows, error: null }));
}

/** PostgREST returned a structured error — the UPDATE rolled back. */
export function stubUpdateFailing(message = "boom"): UpdateQueryStub {
  return updateStubFrom(
    vi.fn<(columns?: string) => Promise<unknown>>().mockResolvedValue({ data: null, error: { message } }),
  );
}

/** The request itself failed in transport — the UPDATE may or may not have committed. */
export function stubUpdateRejecting(cause: unknown = new TypeError("fetch failed")): UpdateQueryStub {
  return updateStubFrom(vi.fn<(columns?: string) => Promise<unknown>>().mockRejectedValue(cause));
}
