import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateSafety } from "../safety/index.js";
import { getDefaultPolicy } from "../policies.js";
import type { SafetyInput } from "../types.js";

interface GoldenCase {
  name: string;
  input: SafetyInput;
  expected: { riskLevel: string; approvalRequired: boolean; approvalStatus: string; blocked: boolean; allowed: boolean; appSensitivity: string };
}

const fixture = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "policy-golden.json"), "utf8")) as {
  context: { homeDir: string; agentHostDir: string; platform: NodeJS.Platform };
  cases: GoldenCase[];
};

describe("policy golden fixture", () => {
  it("holds the representative calls", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(15);
  });

  for (const entry of fixture.cases) {
    it(`classifier decision is unchanged: ${entry.name}`, () => {
      const result = evaluateSafety(entry.input, getDefaultPolicy(), fixture.context);
      expect({
        riskLevel: result.riskLevel,
        approvalRequired: result.approval.required,
        approvalStatus: result.approval.status,
        blocked: result.blocked,
        allowed: result.allowed,
        appSensitivity: result.appSensitivity
      }).toEqual(entry.expected);
    });
  }
});

describe("policy golden fixture with the policy layer and no policy.toml", () => {
  it("leaves every decision to the floor or the classifier", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const { loadPolicy, decidePolicy, DEFAULT_POLICY_RULES } = await import("../policy-file.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-golden-"));
    try {
      const loaded = await loadPolicy(dir);
      expect(loaded.exists).toBe(false);
      expect(loaded.rules).toBe(DEFAULT_POLICY_RULES);
      for (const entry of fixture.cases) {
        const result = evaluateSafety(entry.input, getDefaultPolicy(), fixture.context);
        const outcome = decidePolicy(loaded.rules, {
          tool: entry.input.tool,
          input: entry.input,
          target: { app: entry.input.appName },
          classification: { riskLevel: result.riskLevel, stateChanging: true, appSensitivity: result.appSensitivity, actionType: entry.input.actionType }
        });
        expect(outcome.source, entry.name).toBe(entry.expected.blocked ? "floor" : "classifier");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("policy.toml is control plane", () => {
  it("is write-blocked and read-medium like config.json", () => {
    for (const access of ["file_write", "file_delete"] as const) {
      const result = evaluateSafety({ tool: "file.write", actionType: access, filePath: "/home/tester/.agenthost/policy.toml" }, getDefaultPolicy(), fixture.context);
      expect(result.blocked, access).toBe(true);
    }
    const read = evaluateSafety({ tool: "file.read", actionType: "file_read", filePath: "/home/tester/.agenthost/policy.toml" }, getDefaultPolicy(), fixture.context);
    expect(read.riskLevel).toBe("medium");
  });
});
