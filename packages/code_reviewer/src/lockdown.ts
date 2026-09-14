/**
 * Tools the session may expose despite `tools: []`. `StructuredOutput` is how the SDK delivers `outputFormat`
 * (observed in the init message on SDK 0.3.270); it gives the model no access to anything outside the prompt.
 */
export const EXPECTED_SESSION_TOOLS: readonly string[] = ["StructuredOutput"];

/** What the session reported about itself in its `system`/`init` message — the proof of the lockdown. */
export interface SessionInit {
  initTools: string[];
  model: string;
}

export type LockdownCheck = { ok: true; init: SessionInit } | { ok: false; reason: string };

/**
 * Fail closed: a review is trusted only when the session proved it exposed exactly the expected tools.
 * A missing or partial init message is not proof, and neither is a subset — both are refused, so an SDK
 * change to the tool list stops the CLI instead of silently passing through a caret-range upgrade.
 */
export function verifyLockdown(init: Partial<SessionInit> | undefined): LockdownCheck {
  if (!init?.initTools || !init.model) {
    return { ok: false, reason: "No complete init message received — the session's tool list could not be verified." };
  }
  const actual = [...init.initTools].sort();
  const expected = [...EXPECTED_SESSION_TOOLS].sort();
  if (actual.length !== expected.length || actual.some((tool, i) => tool !== expected[i])) {
    return {
      ok: false,
      reason: `Expected exactly ${JSON.stringify(expected)}, but the session exposed ${JSON.stringify(init.initTools)}.`,
    };
  }
  return { ok: true, init: { initTools: init.initTools, model: init.model } };
}
