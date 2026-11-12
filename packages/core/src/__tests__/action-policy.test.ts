import { describe, expect, it } from "vitest";
import { createGovernedActionEffect, decideGovernedAction, fingerprintActionBinding, getDefaultPolicy, validateGovernedActionEffect } from "../index.js";

describe("universal governed-action policy", () => {
  it("returns precise confirmation recovery for an external effect under the default policy", () => {
    const effect = createGovernedActionEffect({
      ownerSessionId: "session-policy-test",
      operationFamily: "communication",
      operation: "send",
      executionClass: "state_changing",
      externalEffect: true,
      confirmationLevel: "standard",
      verificationKind: "receipt",
      bindings: { recipient: fingerprintActionBinding("recipient"), content: fingerprintActionBinding("message") }
    });
    const decision = decideGovernedAction({
      effect,
      safety: { allowed: false, blocked: false, guideOnly: false, riskLevel: "high", appSensitivity: "communication" },
      policy: getDefaultPolicy()
    });
    expect(decision.code).toBe("action_confirmation_missing");
    expect(decision.recovery).toBe("confirm");
  });

  it("keeps a recoverable refusal when the policy denies external sends", () => {
    const effect = createGovernedActionEffect({
      ownerSessionId: "session-policy-test",
      operationFamily: "communication",
      operation: "send",
      executionClass: "state_changing",
      externalEffect: true,
      confirmationLevel: "standard",
      verificationKind: "receipt",
      bindings: { recipient: fingerprintActionBinding("recipient"), content: fingerprintActionBinding("message") }
    });
    const policy = getDefaultPolicy();
    policy.defaults.externalSendsUploads = "deny";
    const decision = decideGovernedAction({
      effect,
      safety: { allowed: false, blocked: false, guideOnly: false, riskLevel: "high", appSensitivity: "communication" },
      policy
    });
    expect(decision.code).toBe("action_not_permitted");
    expect(decision.recovery).toBe("confirm");
  });

  it("requires a governed route for financial state changes", () => {
    const effect = createGovernedActionEffect({
      ownerSessionId: "session-policy-test",
      operationFamily: "browser",
      operation: "payment",
      executionClass: "state_changing",
      externalEffect: true,
      confirmationLevel: "strong",
      verificationKind: "receipt",
      bindings: { target: fingerprintActionBinding("target") }
    });
    const decision = decideGovernedAction({
      effect,
      safety: { allowed: true, blocked: false, guideOnly: false, riskLevel: "high", appSensitivity: "financial" },
      policy: getDefaultPolicy()
    });
    expect(decision.decision).toBe("unsupported");
    expect(decision.code).toBe("action_route_unavailable");
  });

  it("rejects tampered effect fingerprints", () => {
    const effect = createGovernedActionEffect({
      ownerSessionId: "session-policy-test",
      operationFamily: "file",
      operation: "write",
      executionClass: "state_changing",
      bindings: { target: fingerprintActionBinding("/approved/root/file") }
    });
    const result = validateGovernedActionEffect({ ...effect, operation: "delete" });
    expect(result).toMatchObject({ ok: false, code: "action_binding_changed" });
  });
});
