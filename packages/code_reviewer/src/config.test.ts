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

  // Oracle: plan.md Phase 2 §1 — positional diff path plus optional named flags; strict parsing.
  it("keeps a positional-only invocation valid with local defaults", () => {
    expect(loadConfig(["change.diff"], KEY)).toMatchObject({
      ok: true,
      diffPath: "change.diff",
      title: "",
      bodyPath: undefined,
      reportPath: undefined,
      markdownPath: undefined,
      reviewedSha: undefined,
    });
  });

  it.each([
    ["--title", "Fix: refund on failure", { title: "Fix: refund on failure" }],
    ["--body-file", "/tmp/pr-body.md", { bodyPath: "/tmp/pr-body.md" }],
    ["--report", "/tmp/ai-cr/report.json", { reportPath: "/tmp/ai-cr/report.json" }],
    ["--markdown", "/tmp/ai-cr/comment.md", { markdownPath: "/tmp/ai-cr/comment.md" }],
    ["--reviewed-sha", "0123abc", { reviewedSha: "0123abc" }],
  ])("parses %s", (flag, value, expected) => {
    expect(loadConfig(["change.diff", flag, value], KEY)).toMatchObject({
      ok: true,
      diffPath: "change.diff",
      ...expected,
    });
  });

  it("accepts flags before the diff path", () => {
    expect(loadConfig(["--title", "T", "change.diff"], KEY)).toMatchObject({
      ok: true,
      diffPath: "change.diff",
      title: "T",
    });
  });

  it.each([
    ["an unknown flag", ["change.diff", "--verbose"], /verbose/],
    ["a flag without its value", ["change.diff", "--title"], /title/],
    ["a second positional", ["a.diff", "b.diff"], /one diff file/],
    ["flags but no diff path", ["--title", "T"], /diff file argument/],
  ])("rejects %s", (_label, argv, message) => {
    const config = loadConfig(argv, KEY);
    expect(config.ok).toBe(false);
    if (!config.ok) expect(config.message).toMatch(message);
  });

  it("keeps the markdown path on a config error, so an error comment can still be written", () => {
    expect(loadConfig(["change.diff", "--markdown", "comment.md"], {})).toMatchObject({
      ok: false,
      markdownPath: "comment.md",
    });
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
