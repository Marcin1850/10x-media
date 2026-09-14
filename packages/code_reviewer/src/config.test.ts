import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const KEY = { ANTHROPIC_API_KEY: "sk-ant-test" };

describe("loadConfig", () => {
  it.each([
    ["the diff argument is missing", [], KEY, /diff file argument/],
    ["the API key is missing", ["change.diff"], {}, /ANTHROPIC_API_KEY/],
    ["the API key is an empty string", ["change.diff"], { ANTHROPIC_API_KEY: "" }, /ANTHROPIC_API_KEY/],
  ])("fails when %s", (_label, argv, env, message) => {
    const config = loadConfig(argv, env);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.message).toMatch(message);
  });

  it("carries REVIEW_MODEL when it is set", () => {
    expect(loadConfig(["change.diff"], { ...KEY, REVIEW_MODEL: "claude-opus-5" })).toMatchObject({
      ok: true,
      diffPath: "change.diff",
      model: "claude-opus-5",
      outDir: "output",
    });
  });

  it("leaves the model undefined when REVIEW_MODEL is not set", () => {
    const config = loadConfig(["change.diff"], KEY);
    expect(config).toMatchObject({ ok: true, diffPath: "change.diff" });
    expect(config.ok && config.model).toBeUndefined();
  });

  // Oracle: plan.md Phase 1 §4 — turns default 5, budget optional, invalid values are config errors.
  it("defaults to 5 turns and no budget cap", () => {
    expect(loadConfig(["change.diff"], KEY)).toMatchObject({ ok: true, maxTurns: 5, maxBudgetUsd: undefined });
  });

  it.each([
    ["REVIEW_MAX_TURNS", "7", { maxTurns: 7 }],
    ["REVIEW_MAX_BUDGET_USD", "1.00", { maxBudgetUsd: 1 }],
    ["REVIEW_MAX_BUDGET_USD", "0.25", { maxBudgetUsd: 0.25 }],
  ])("parses %s=%s", (name, value, expected) => {
    expect(loadConfig(["change.diff"], { ...KEY, [name]: value })).toMatchObject({ ok: true, ...expected });
  });

  it.each([
    ["REVIEW_MAX_TURNS", "0"],
    ["REVIEW_MAX_TURNS", "abc"],
    ["REVIEW_MAX_TURNS", "2.5"],
    ["REVIEW_MAX_TURNS", "-3"],
    ["REVIEW_MAX_BUDGET_USD", "-1"],
    ["REVIEW_MAX_BUDGET_USD", "abc"],
    ["REVIEW_MAX_BUDGET_USD", "0"],
  ])("rejects %s=%s instead of defaulting it", (name, value) => {
    const config = loadConfig(["change.diff"], { ...KEY, [name]: value });
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.message).toContain(name);
  });
});
