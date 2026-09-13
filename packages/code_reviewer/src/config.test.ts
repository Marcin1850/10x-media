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
    expect(loadConfig(["change.diff"], { ...KEY, REVIEW_MODEL: "claude-opus-5" })).toEqual({
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
});
