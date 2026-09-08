import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginGeneration,
  chargeFailedTranscript,
  lookupRefusalReplay,
  type BeginGenerationParams,
  type BeginGenerationResult,
  type ChargeFailedTranscriptParams,
  type ChargeFailedTranscriptResult,
} from "@/lib/services/credits";
import {
  stubFailing,
  stubRejecting,
  stubReturning,
  type SupabaseStub,
} from "@/lib/services/__fixtures__/supabase-stub";

/**
 * Risk #1 — who pays, and what the caller may claim about it.
 *
 * Oracle: the doc contracts on `ChargeFailedTranscriptResult` / `BeginGenerationResult` (which state
 * what each outcome MEANS to a user's money, not what the switch statement does) and roadmap S-09
 * phase 9 **D1**. Nothing below is read off the branch it covers — the assertions describe the
 * ledger's promises, so a switch rewritten to a lookup table keeps them green while a rewrite that
 * changes who pays does not.
 *
 * The four failure branches each `console.error` an operator marker. Those are silenced so a green run
 * stays readable, but the marker STRINGS are deliberately not asserted: they are log copy, not a
 * contract any consumer reads.
 *
 * **Mutation check** (`npx stryker run --mutate "src/lib/services/credits.ts"`, 2026-08-23): 98 killed,
 * 26 survived, 25 not covered. Every survivor was put to the question "would this change hurt a user or
 * the business?" and the answer was no on all three classes below — no assertion was added to raise a
 * number. The one class that answered YES was the `replay` payload guard (`credits.ts:149`), whose five
 * mutants are now killed by the one-field-at-a-time rows in "contract violations throw".
 *
 * Ignored, with the reason:
 *
 * 1. **Message and marker copy** (14 — every `console.error("")` / `throw new Error("")`, plus the
 *    three marker constants). Same reason as the paragraph above: operator log text. Nothing branches
 *    on it and no user sees it, so an assertion here would pin a string and nothing more.
 * 2. **The `if (error)` guard emptied or short-circuited** (`:128`, `:353`). supabase-js resolves an
 *    RPC error into `error` with `data` null, so the next guard catches the same shape and the caller
 *    observes the identical result. Killing these needs a response carrying an error AND a valid row
 *    at once — an input the client cannot produce, and inventing unreachable inputs is out of scope by
 *    the plan's own rule.
 * 3. **The `!data || data.length === 0` guard emptied or short-circuited** (`:134`, `:298`). Falling
 *    through reads `data[0]` on a missing row, and the observable outcome is unchanged either way:
 *    `beginGeneration` throws (a TypeError instead of its own Error, both landing the endpoint on the
 *    failure path that refunds the debit) and `chargeFailedTranscript`'s catch-all resolves the same
 *    `ambiguous`. The guards earn their place as documentation of a broken RPC contract, not as a
 *    branch anything downstream can distinguish.
 *
 * The 25 uncovered mutants are all in `getBalance` and `refundReservation` — outside this rollout
 * phase's scope, which names only the three functions below.
 *
 * **Re-run 2026-09-08** after adding the balance-presence table ("which outcomes know a balance at
 * all"): **98 killed / 26 survived / 25 uncovered — identical to the run above.** The new rows kill no
 * mutant the value tables were not already killing, and that is recorded rather than hidden: their
 * value is not extra mutation coverage. They state the presence rule as a rule across all five
 * outcomes, which is what `generate.ts`'s `refusalResponse` now branches on, and they use
 * `toHaveProperty` for the two absent cases — something `toEqual({ outcome: "notCharged" })` cannot
 * express, since it accepts an explicit `balance: undefined` beside it. `credits.ts` itself is
 * unchanged by that phase, so the identical score is the expected result, not a gap.
 */

const CHARGE_PARAMS: ChargeFailedTranscriptParams = {
  userId: "00000000-0000-4000-8000-000000000001",
  requestId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
  amount: 1,
  refusalReason: "unavailable",
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * What actually reaches the ledger — asserted before any outcome, because every test below this one
 * would stay green while the wrong thing was charged.
 *
 * Oracle: `ChargeFailedTranscriptParams.requestId`'s documented contract ("the request's OWN key,
 * never a freshly generated one — that is the single easiest way to get this wrong") and the SQL
 * signature in `20260731110000_charge_failed_transcript.sql:85-90`. The parameter names are read from
 * the migration, not from `credits.ts`, or this would assert nothing but its own mirror.
 */
describe("chargeFailedTranscript — what reaches the ledger", () => {
  // The seam the fee's idempotency rests on. A charge keyed with a FRESH uuid would miss the partial
  // unique index `credit_reservations_request_key`, so `replay` could never be reached and a client
  // retrying an ambiguous failure would be billed once per attempt — money leaving a user's account
  // for a submission they made once. The outcome tables above cannot see this: fed a `charged` row
  // they stay green no matter which key was sent.
  //
  // The NAMES matter as much as the values: PostgREST matches named arguments, so a rename on either
  // side is a runtime failure that TypeScript cannot catch — the RPC is untyped at this boundary.
  it("forwards the caller's own request key and fee under the names the SQL function declares", async () => {
    const stub = stubReturning([{ outcome: "charged", new_balance: 41 }]);

    await chargeFailedTranscript(stub.client, CHARGE_PARAMS);

    expect(stub.rpc).toHaveBeenCalledWith("charge_failed_transcript", {
      p_user_id: CHARGE_PARAMS.userId,
      p_request_id: CHARGE_PARAMS.requestId,
      p_amount: CHARGE_PARAMS.amount,
      p_refusal_reason: CHARGE_PARAMS.refusalReason,
    });
  });
});

/**
 * The half of the truth table where PostgREST ANSWERED: the call completed, the ledger reported what
 * it did, and the balance is therefore known. That is what these three outcomes have in common — each
 * carries a `balance`, so the caller can tell the user the truth about their account. The other half,
 * where exactly that knowledge is missing, is the next describe.
 *
 * **There is no starting balance in these tests, by design.** This function performs no arithmetic on
 * a balance: the debit happens inside the `charge_failed_transcript()` SQL function, so `new_balance`
 * arrives already computed and is passed straight through. The stub DICTATES what the database
 * answered, which puts the seam below the place a balance is ever calculated. Proving that a debit
 * really removes one credit needs a real database and belongs to rollout Phase 2 (test-plan §3).
 */
describe("chargeFailedTranscript — the answers that say what happened to the money", () => {
  // The balance figures below are deliberately OPAQUE — they are not derived from `amount`, and
  // nothing here computes them. They only have to be distinct from each other and from zero, so that
  // a mutation hardcoding a balance, or swapping it between branches, fails this table.
  const rows: [string, string, number | null, ChargeFailedTranscriptResult][] = [
    ["charged", "one credit taken for a refusal the operator paid for (D14)", 41, { outcome: "charged", balance: 41 }],
    // `replay` means this exact `(userId, requestId)` was ALREADY charged — by an earlier attempt whose
    // answer the client never received, so it retried with the same key (F22 idempotency). THIS attempt
    // takes nothing; the partial unique index on the key is what stops a second debit.
    //
    // It still reports `charged: true` (`generate.ts:292`), and that is the whole point: from the
    // user's side a credit really did leave their account for this submission. `charged: false` would
    // be a lie about money that moved; charging again would be a lie in the other direction. `replay`
    // says precisely "the fee exists, and it is not new".
    //
    // NOT the same `replay` as `beginGeneration`'s — same name, opposite end of the endpoint. That one
    // replays a finished SUMMARY and skips the paid LLM call ("we already delivered this"); this one
    // recognises a fee already collected ("we already charged for this").
    [
      "replay",
      "an earlier attempt on this key already paid the fee, so this retry takes nothing",
      17,
      { outcome: "replay", balance: 17 },
    ],
    // NOT an error: the 402 gate blocks a zero balance before any paid call, so arriving here short of
    // credit means the balance moved mid-request. Zero is not a sentinel like the two above — with a
    // one-credit fee it is the only balance that can fail to cover it.
    [
      "insufficient",
      "the balance moved mid-request and no longer covers the fee",
      0,
      { outcome: "insufficient", balance: 0 },
    ],
  ];

  it.each(rows)("maps a %s row to its documented result: %s", async (outcome, _why, newBalance, expected) => {
    const stub = stubReturning([{ outcome, new_balance: newBalance }]);

    await expect(chargeFailedTranscript(stub.client, CHARGE_PARAMS)).resolves.toEqual(expected);
  });

  // Here zero IS the rule, not a stand-in value: a user with no credits row has no credits. Asserted
  // because `beginGeneration` makes the same promise on its own `insufficient` and `replay` rows, and
  // because a balance left as `null` would reach the response body as a missing number.
  it("reads a null new_balance as zero, matching beginGeneration", async () => {
    const stub = stubReturning([{ outcome: "insufficient", new_balance: null }]);

    await expect(chargeFailedTranscript(stub.client, CHARGE_PARAMS)).resolves.toEqual({
      outcome: "insufficient",
      balance: 0,
    });
  });
});

describe("chargeFailedTranscript — the notCharged/ambiguous boundary", () => {
  // The one failure mode that PROVES no debit landed: reserve-and-settle is a single statement inside
  // the RPC, so a structured PostgREST error means it raised in its own transaction and rolled back.
  // This is the ONLY shape allowed to claim the user was not billed.
  it("reports notCharged only for a structured PostgREST error, which rolled back", async () => {
    const stub = stubFailing("relation does not exist");

    await expect(chargeFailedTranscript(stub.client, CHARGE_PARAMS)).resolves.toEqual({ outcome: "notCharged" });
  });

  // The headline of this phase. A transport failure can happen AFTER Postgres commits the debit, so a
  // rejected promise cannot rule out that the user was billed. Answering `notCharged` here would tell
  // a caller it is safe to assert `charged: false` about money that may well have moved.
  //
  // Asserted by `ambiguous`'s own shape, never as "not notCharged" — collapsing the two is precisely
  // the mistake the outcome exists to prevent, and a negation assertion would survive it.
  it("reports ambiguous when the request promise rejects, because a commit cannot be ruled out", async () => {
    const stub = stubRejecting(new TypeError("fetch failed"));

    await expect(chargeFailedTranscript(stub.client, CHARGE_PARAMS)).resolves.toEqual({ outcome: "ambiguous" });
  });

  // Every remaining failure shape answered WITHOUT an `error`, which means the statement executed
  // without raising — so the debit may have landed and the outcome is unknown, not disproven.
  const unknowable: [string, string, unknown][] = [
    ["an empty row set", "the RPC contract changed, but no error means the statement ran", []],
    ["a null data payload", "same reasoning as an empty row set", null],
    [
      "an unrecognised outcome",
      "a contract mismatch on a call that succeeded is not proof of no charge",
      [{ outcome: "settled", new_balance: 2 }],
    ],
  ];

  it.each(unknowable)("reports ambiguous for %s: %s", async (_label, _why, data) => {
    const stub = stubReturning(data);

    await expect(chargeFailedTranscript(stub.client, CHARGE_PARAMS)).resolves.toEqual({ outcome: "ambiguous" });
  });

  // The property that ties the whole function to risk #1: a refusal charge that cannot be collected
  // still owes the user their 422. A throw here would replace the answer they were owed with a 500,
  // costing them the reply in order to chase a fee they never see.
  it("never throws — every failure shape resolves", async () => {
    const stub = stubRejecting(new Error("connection reset"));

    await expect(chargeFailedTranscript(stub.client, CHARGE_PARAMS)).resolves.toBeDefined();
  });
});

/**
 * Which outcomes know a balance at all — the rule, stated once across all five.
 *
 * A different property from the tables above, not a restatement of them: those pin WHICH NUMBER each
 * row returns, this pins WHETHER there is a number to return. That is the rule the endpoint branches
 * on — `refuseAndCharge` forwards `result.balance` to `refusalResponse`, which emits
 * `creditsRemaining` on the 422 exactly when one arrived — so the presence rule is now a wire
 * contract, and a `notCharged` that started answering `balance: 0` would tell a user a credit left
 * their account while every value assertion above stayed green.
 *
 * Oracle: README §Summary credits ("it carries the resulting balance as `creditsRemaining` whenever
 * the server knows it") and `refusalResponse`'s documented contract, which supersedes roadmap S-09
 * **D14**'s "no balance field" — the qualitative half of that supersession shipped as `charged` in
 * S-06 phase 9 and the quantitative half lands with this rule. Read from those, not from the switch.
 *
 * Asserted with `toHaveProperty`, which the value tables cannot do for the two absent cases:
 * `toEqual({ outcome: "notCharged" })` accepts an explicit `balance: undefined` alongside it. Each row
 * stands on its own shape — `ambiguous` is "has no balance", never "is not `notCharged`" (§6.1).
 */
describe("chargeFailedTranscript — which outcomes know a balance at all", () => {
  const rows: [string, string, () => SupabaseStub, boolean][] = [
    // A real debit just happened and the RPC returned the balance it wrote.
    [
      "charged",
      "the debit landed here, so the post-charge balance is known",
      () => stubReturning([{ outcome: "charged", new_balance: 41 }]),
      true,
    ],
    // Nothing moved on THIS attempt, but the RPC still re-reads user_credits (the migration's `replay`
    // branch), so the number is just as authoritative — and the client is just as entitled to it.
    [
      "replay",
      "no debit this time, yet the RPC still read the current balance",
      () => stubReturning([{ outcome: "replay", new_balance: 17 }]),
      true,
    ],
    // The case that proves a balance is not a claim about a charge: nothing moved, and the balance is
    // reported anyway. Dropping this row would make `creditsRemaining` mean "you were charged".
    [
      "insufficient",
      "nothing moved, and the balance is reported regardless — it is not a charge signal",
      () => stubReturning([{ outcome: "insufficient", new_balance: 0 }]),
      true,
    ],
    // A rolled-back statement learned nothing about the balance. Reporting one here would be inventing
    // a number, which is worse than the staleness this whole rule exists to fix.
    [
      "notCharged",
      "a rolled-back statement read no balance, so there is none to report",
      () => stubFailing("relation does not exist"),
      false,
    ],
    // Same absence, opposite reason: the statement may well have committed, so any number we could
    // name might already be wrong by one credit.
    [
      "ambiguous",
      "the outcome is unknown, so any balance we named could already be stale",
      () => stubReturning([]),
      false,
    ],
  ];

  it.each(rows)("a %s outcome %s", async (_outcome, _why, makeStub, hasBalance) => {
    const result = await chargeFailedTranscript(makeStub().client, CHARGE_PARAMS);

    if (hasBalance) expect(result).toHaveProperty("balance", expect.any(Number));
    else expect(result).not.toHaveProperty("balance");
  });
});

const BEGIN_PARAMS: BeginGenerationParams = {
  userId: "00000000-0000-4000-8000-000000000001",
  requestId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
  amount: 1,
};

const RESERVATION_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SUMMARY_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

/** One `returns table(...)` row, defaulted to all-null so each case states only what it is about. */
function beginRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    reservation_id: null,
    new_balance: null,
    summary_id: null,
    video_id: null,
    content: null,
    model: null,
    cost: null,
    ...overrides,
  };
}

/**
 * What actually reaches the ledger on the DEBIT path — the same gap as above, on the call that moves
 * real money before the paid LLM run.
 *
 * Oracle: the SQL signature at `20260723130000_idempotent_generation.sql:78-82` and the null meanings
 * its own guards spell out — `amount` null IS the probe ("amount must be a positive integer or null
 * (probe)"), and a null `request` "skips straight to the debit". Neither null is a missing value; both
 * select which operation Postgres performs, so forwarding them UNCHANGED is the behaviour under test.
 *
 * Note the parameter names carry no `p_` prefix here, unlike `charge_failed_transcript`'s. The two
 * migrations chose different conventions — exactly the detail a copy-paste gets wrong, and one
 * TypeScript cannot catch because the RPC is untyped at this boundary.
 */
describe("beginGeneration — what reaches the ledger", () => {
  const calls: [string, string, BeginGenerationParams, Record<string, unknown>][] = [
    [
      "a real debit",
      "priced work, charged once the transcript is in hand",
      BEGIN_PARAMS,
      { target_user: BEGIN_PARAMS.userId, request: BEGIN_PARAMS.requestId, amount: 1 },
    ],
    // Coercing this null to a number would DEBIT ON THE PROBE. The endpoint probes before the paid
    // transcript fetch — it cannot price the work until it has the transcript — so the user would pay
    // up front for work that has not run and may never be delivered.
    [
      "a probe",
      "a null amount asks the identity question without charging",
      { ...BEGIN_PARAMS, amount: null },
      { target_user: BEGIN_PARAMS.userId, request: BEGIN_PARAMS.requestId, amount: null },
    ],
    // The pre-F22 fallback for a cached client that sends no key. Substituting a generated key here
    // would turn a deliberately unkeyed call into a keyed one, writing a `request_id` the client can
    // never repeat — so its retry would look like a new operation and debit again.
    [
      "a keyless call",
      "a null request disables deduplication and skips straight to the debit",
      { ...BEGIN_PARAMS, requestId: null },
      { target_user: BEGIN_PARAMS.userId, request: null, amount: 1 },
    ],
  ];

  it.each(calls)("forwards %s unchanged: %s", async (_label, _why, params, expected) => {
    const stub = stubReturning([beginRow({ outcome: "fresh" })]);

    await beginGeneration(stub.client, params);

    expect(stub.rpc).toHaveBeenCalledWith("begin_generation", expected);
  });
});

describe("beginGeneration — the six documented outcomes", () => {
  it("returns a reservation the caller can close", async () => {
    const stub = stubReturning([beginRow({ outcome: "reserved", reservation_id: RESERVATION_ID, new_balance: 4 })]);

    await expect(beginGeneration(stub.client, BEGIN_PARAMS)).resolves.toEqual({
      outcome: "reserved",
      reservationId: RESERVATION_ID,
      balance: 4,
    });
  });

  // The three outcomes that carry no ledger data. `in_progress` is renamed to `inProgress` at this
  // boundary, so the RPC's wire vocabulary is pinned separately from the caller's.
  const plain: [string, string, BeginGenerationResult][] = [
    ["fresh", "a probe found no prior attempt, so the expensive work may run", { outcome: "fresh" }],
    ["in_progress", "another attempt on this key is still running", { outcome: "inProgress" }],
    ["unavailable", "this key's debit was closed without producing a summary", { outcome: "unavailable" }],
  ];

  it.each(plain)("maps a %s row to its documented result: %s", async (outcome, _why, expected) => {
    const stub = stubReturning([beginRow({ outcome })]);

    await expect(beginGeneration(stub.client, BEGIN_PARAMS)).resolves.toEqual(expected);
  });

  // The OTHER `replay` — the counterpart to `chargeFailedTranscript`'s, and the one that returns work
  // rather than recognising a fee. Same trigger (a client retrying with the same key after losing an
  // answer), opposite payload: this key already produced a SUMMARY, so nothing is written or charged
  // and the caller answers with the original result instead of calling the paid LLM again. That is the
  // whole point of F22 — an ambiguous retry must not buy a second summary — which is why the entire
  // payload is asserted here rather than just the outcome: a replay that lost its content has nothing
  // to replay with.
  it("replays the original summary verbatim without charging again", async () => {
    const stub = stubReturning([
      beginRow({
        outcome: "replay",
        reservation_id: RESERVATION_ID,
        new_balance: 3,
        summary_id: SUMMARY_ID,
        video_id: "dQw4w9WgXcQ",
        content: "# Podsumowanie",
        model: "anthropic/claude-sonnet-5",
        cost: 2,
      }),
    ]);

    await expect(beginGeneration(stub.client, BEGIN_PARAMS)).resolves.toEqual({
      outcome: "replay",
      reservationId: RESERVATION_ID,
      balance: 3,
      cost: 2,
      summaryId: SUMMARY_ID,
      videoId: "dQw4w9WgXcQ",
      content: "# Podsumowanie",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("reports the caller's actual, unchanged balance when credits will not cover the work", async () => {
    const stub = stubReturning([beginRow({ outcome: "insufficient", new_balance: 2 })]);

    await expect(beginGeneration(stub.client, BEGIN_PARAMS)).resolves.toEqual({ outcome: "insufficient", balance: 2 });
  });
});

describe("beginGeneration — what a null ledger column means", () => {
  // A user with no credits row has no credits. Both outcomes make the same promise, so both are
  // asserted: a balance surfacing as `null` would reach the response body as a missing number.
  it.each([
    ["insufficient", beginRow({ outcome: "insufficient", new_balance: null })],
    [
      "replay",
      beginRow({
        outcome: "replay",
        reservation_id: RESERVATION_ID,
        new_balance: null,
        summary_id: SUMMARY_ID,
        video_id: "dQw4w9WgXcQ",
        content: "# Podsumowanie",
      }),
    ],
  ])("reads a null new_balance on a %s row as zero", async (_outcome, row) => {
    const stub = stubReturning([row]);
    const result = await beginGeneration(stub.client, BEGIN_PARAMS);

    expect(result).toMatchObject({ balance: 0 });
  });

  // A replay that lost its recorded price still costs what the base rule charges (README §Summary
  // credits: a summary spends 1 credit). Defaulting DOWN is the safe direction — the alternative
  // over-reports what an old attempt took from a user who cannot check.
  it("reads a null cost on a replay row as the base credit", async () => {
    const stub = stubReturning([
      beginRow({
        outcome: "replay",
        reservation_id: RESERVATION_ID,
        new_balance: 3,
        summary_id: SUMMARY_ID,
        video_id: "dQw4w9WgXcQ",
        content: "# Podsumowanie",
        cost: null,
      }),
    ]);

    await expect(beginGeneration(stub.client, BEGIN_PARAMS)).resolves.toMatchObject({ cost: 1 });
  });
});

describe("beginGeneration — contract violations throw, and that is the guard", () => {
  // The opposite direction from `chargeFailedTranscript` on purpose. A debit whose reservation id is
  // lost can never be settled or refunded: the user has paid and nothing can close the row. Returning
  // a reservation the caller cannot close would hide that; the throw sends the endpoint down its
  // failure path instead, where the debit is refunded or left `reserved` for reconciliation.
  const violations: [string, string, unknown][] = [
    [
      "a debited row with no reservation id",
      "unrecoverable — nothing could later settle or refund it",
      [beginRow({ outcome: "reserved", new_balance: 4 })],
    ],
    [
      "a debited row with no resulting balance",
      "a debit that reports no balance did not describe what it took",
      [beginRow({ outcome: "reserved", reservation_id: RESERVATION_ID })],
    ],
    [
      "a replay row with no summary",
      "there is nothing to return verbatim, so it is not a replay",
      [beginRow({ outcome: "replay", reservation_id: RESERVATION_ID, new_balance: 3 })],
    ],
    // One row per field the replay payload must carry, each missing exactly ONE of them. A replay
    // answers the client with the original result instead of calling the paid LLM, so a payload with
    // a hole is not a cheaper replay — it is a wrong answer to a request the user already paid for:
    // no `summary_id` and the client cannot open or revisit the summary it is being handed; no
    // `video_id` and the content is attributed to nothing; no `reservation_id` and the fee that was
    // already collected has no row the endpoint can point at.
    //
    // Asserted one-at-a-time deliberately. The all-null row above passes ANY guard that still checks
    // a single field, so on its own it cannot tell "all four are required" from "content is
    // required" — which is exactly the degradation that would ship a holed replay.
    [
      "a replay row with no reservation id",
      "the fee already collected has no ledger row behind it",
      [beginRow({ outcome: "replay", new_balance: 3, summary_id: SUMMARY_ID, video_id: "dQw4w9WgXcQ", content: "#" })],
    ],
    [
      "a replay row with no summary id",
      "the client is handed a summary it cannot open or revisit",
      [
        beginRow({
          outcome: "replay",
          reservation_id: RESERVATION_ID,
          new_balance: 3,
          video_id: "dQw4w9WgXcQ",
          content: "#",
        }),
      ],
    ],
    [
      "a replay row with no video id",
      "the replayed content is attributed to no video",
      [
        beginRow({
          outcome: "replay",
          reservation_id: RESERVATION_ID,
          new_balance: 3,
          summary_id: SUMMARY_ID,
          content: "#",
        }),
      ],
    ],
    [
      "a replay row with no content",
      "there is nothing to replay with, whatever else the row carries",
      [
        beginRow({
          outcome: "replay",
          reservation_id: RESERVATION_ID,
          new_balance: 3,
          summary_id: SUMMARY_ID,
          video_id: "dQw4w9WgXcQ",
        }),
      ],
    ],
    ["an empty row set", "the RPC contract changed and must not read as a silent success", []],
    ["an unrecognised outcome", "an outcome with no documented meaning", [beginRow({ outcome: "settled" })]],
  ];

  it.each(violations)("throws on %s: %s", async (_label, _why, data) => {
    const stub = stubReturning(data);

    await expect(beginGeneration(stub.client, BEGIN_PARAMS)).rejects.toThrow();
  });

  it("throws on a structured PostgREST error", async () => {
    const stub = stubFailing("permission denied for function begin_generation");

    await expect(beginGeneration(stub.client, BEGIN_PARAMS)).rejects.toThrow();
  });

  // The direction contrast stated outright, on the IDENTICAL failure shape. Here a throw protects the
  // user from paying for work that did not happen; there, resolving protects the reply the user is
  // owed. Assuming one convention across this module would assert the wrong direction on one of them.
  it("throws where chargeFailedTranscript resolves, given the same rejected request", async () => {
    const debit = stubRejecting(new TypeError("fetch failed"));
    const refusalFee = stubRejecting(new TypeError("fetch failed"));

    await expect(beginGeneration(debit.client, BEGIN_PARAMS)).rejects.toThrow();
    await expect(chargeFailedTranscript(refusalFee.client, CHARGE_PARAMS)).resolves.toEqual({ outcome: "ambiguous" });
  });
});

const LOOKUP_PARAMS = {
  userId: "00000000-0000-4000-8000-000000000001",
  requestId: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
};

/**
 * Oracle: the SQL signature at `20260731110000_charge_failed_transcript.sql:221-224` — `p_`-prefixed
 * here, like its sibling in the same migration and unlike `begin_generation`.
 *
 * Why it is worth an assertion: this lookup fails toward `null` on purpose, so asking about the WRONG
 * key is indistinguishable from asking about a key with no refusal on it. A mismatch would not error —
 * it would quietly return `null`, and the user retrying a caption-less submit would get a generic 409
 * instead of the caption-specific 422 they are owed. Silent, and invisible to every outcome test below.
 */
describe("lookupRefusalReplay — what reaches the ledger", () => {
  it("asks about the key it was given, under the names the SQL function declares", async () => {
    const stub = stubReturning("unavailable");

    await lookupRefusalReplay(stub.client, LOOKUP_PARAMS);

    expect(stub.rpc).toHaveBeenCalledWith("get_refusal_replay", {
      p_user_id: LOOKUP_PARAMS.userId,
      p_request_id: LOOKUP_PARAMS.requestId,
    });
  });
});

describe("lookupRefusalReplay — the reasons that have copy behind them", () => {
  // The set mirrors the `credit_reservations.refusal_reason` CHECK exactly, because the endpoint
  // reconstructs the 422 body from the stored value: a reason with no copy behind it is unanswerable.
  // Returned verbatim — this is an identity, and translating it here would desynchronise the lookup
  // from the column it reads.
  it.each([["unavailable"], ["empty"], ["whitespace"]])("returns %s verbatim", async (reason) => {
    const stub = stubReturning(reason);

    await expect(lookupRefusalReplay(stub.client, LOOKUP_PARAMS)).resolves.toBe(reason);
  });
});

describe("lookupRefusalReplay — fails toward null, the OPPOSITE direction of the charge path", () => {
  // Load-bearing, not a fallback. An operator-side settle writes a settled, summary-less row with NO
  // refusal reason; `begin_generation` answers `unavailable` on it and the endpoint returns 409 "start
  // a new generation". That 409 is what the row was written for, so a value outside the documented
  // three must keep it rather than be coerced into a replayed 422.
  const nulls: [string, string, unknown][] = [
    ["no row on this key", "nothing was closed by a refusal charge", null],
    ["a row that is not a refusal charge", "an operator-side settle leaves no reason — it keeps its 409", "settled"],
    ["an unrecognised reason", "there is no copy to reconstruct a 422 body from", "quota_exceeded"],
  ];

  it.each(nulls)("returns null for %s: %s", async (_label, _why, data) => {
    const stub = stubReturning(data);

    await expect(lookupRefusalReplay(stub.client, LOOKUP_PARAMS)).resolves.toBeNull();
  });

  // Here an error must NOT propagate and must NOT guess a reason: this lookup's only job is to IMPROVE
  // a reply that already exists, so failing toward today's 409 is right. The charge path above fails
  // the other way (toward `ambiguous`) because there the unknown is about money already moved.
  it.each([
    ["a structured PostgREST error", stubFailing("permission denied for function get_refusal_replay")],
    ["a rejected request", stubRejecting(new TypeError("fetch failed"))],
  ])("returns null on %s rather than throwing", async (_label, stub) => {
    await expect(lookupRefusalReplay(stub.client, LOOKUP_PARAMS)).resolves.toBeNull();
  });
});
