import { describe, expect, it } from "vitest";

import { interpretResult, type ResultInput } from "./result.js";
import { reviewOutput } from "./test-fixtures.js";

// Hand-built from the SDK's documented result message shape (docs/messages-and-errors.md), not from result.ts.
const common = {
  type: "result",
  total_cost_usd: 0.0123,
  duration_ms: 4200,
  session_id: "session-abc",
  num_turns: 1,
} as const;

const validOutput = reviewOutput();

const expectedMeta = { costUsd: 0.0123, durationMs: 4200, sessionId: "session-abc", numTurns: 1 };

function success(overrides: Partial<Extract<ResultInput, { subtype: "success" }>>): ResultInput {
  return { ...common, subtype: "success", is_error: false, terminal_reason: "completed", result: "", ...overrides };
}

describe("interpretResult", () => {
  it("returns ok with the parsed output and meta for a success with valid structured_output", () => {
    expect(interpretResult(success({ structured_output: validOutput }))).toEqual({
      kind: "ok",
      output: validOutput,
      meta: expectedMeta,
    });
  });

  it.each([
    [
      "schema-violating structured_output",
      success({ structured_output: { ...validOutput, scores: { correctness: { score: 11, rationale: "" } } } }),
    ],
    ["no structured_output", success({})],
  ])("returns invalid-output for a success with %s", (_label, message) => {
    const outcome = interpretResult(message);
    expect(outcome.kind).toBe("invalid-output");
    expect(outcome.kind === "invalid-output" && outcome.issues.length).toBeGreaterThan(0);
    expect(outcome.meta).toEqual(expectedMeta);
  });

  it.each(["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"] as const)(
    "returns agent-error carrying subtype and cost for %s",
    (subtype) => {
      const outcome = interpretResult({
        ...common,
        subtype,
        is_error: true,
        errors: ["limit reached"],
        terminal_reason: "max_turns",
      });
      expect(outcome).toEqual({
        kind: "agent-error",
        subtype,
        terminalReason: "max_turns",
        errors: ["limit reached"],
        meta: expectedMeta,
      });
    },
  );

  it("returns agent-error for a success whose final API call failed, even with valid-looking output", () => {
    const outcome = interpretResult(
      success({
        is_error: true,
        terminal_reason: "api_error",
        result: "API Error: 400 invalid request",
        structured_output: validOutput,
      }),
    );
    // The failure text lives only in `result` for this shape; dropping it leaves the operator an empty error line.
    expect(outcome).toMatchObject({
      kind: "agent-error",
      subtype: "success",
      terminalReason: "api_error",
      errors: ["API Error: 400 invalid request"],
    });
    expect(outcome.meta.costUsd).toBe(0.0123);
  });
});
