import { describe, expect, it } from "vitest";

import { verifyLockdown } from "./lockdown.js";

// Oracle: plan.md's Phase 2 finding — with `tools: []` + `outputFormat` the init message lists exactly
// `StructuredOutput`; anything beyond it is a lockdown leak, and a run without init proves nothing.
describe("verifyLockdown", () => {
  it("accepts a complete init listing exactly StructuredOutput", () => {
    expect(verifyLockdown({ initTools: ["StructuredOutput"], model: "claude-sonnet-5" })).toEqual({
      ok: true,
      init: { initTools: ["StructuredOutput"], model: "claude-sonnet-5" },
    });
  });

  it.each([
    ["no init message", undefined],
    ["an init without a model", { initTools: ["StructuredOutput"] }],
    ["an init without a tool list", { model: "claude-sonnet-5" }],
    ["an extra built-in tool", { initTools: ["StructuredOutput", "Bash"], model: "claude-sonnet-5" }],
    ["an empty tool list", { initTools: [], model: "claude-sonnet-5" }],
    ["a different single tool", { initTools: ["Read"], model: "claude-sonnet-5" }],
  ])("refuses %s", (_label, init) => {
    const check = verifyLockdown(init);
    expect(check.ok).toBe(false);
    expect(!check.ok && check.reason).toMatch(/\S/);
  });
});
