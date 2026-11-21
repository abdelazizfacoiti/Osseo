import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCapabilitiesJson, buildCapabilityMarkdown } from "../capability-manifest.js";

describe("capability manifest", () => {
  it("briefs agent clients with families, loop, and execution model", () => {
    const markdown = buildCapabilityMarkdown({ version: "0.1.0" });
    expect(markdown).toContain("computer");
    expect(markdown).toContain("browser");
    expect(markdown).toContain("skills");
    expect(markdown).toContain("osseo://status");
    expect(markdown).not.toContain("osseo://skills");
    expect(markdown).not.toContain("task.execute_plan");
    expect(markdown).toContain("observe, verify");
  });

  it("emits live counts when provided", () => {
    const markdown = buildCapabilityMarkdown({ version: "0.1.0", toolCount: 250, byExecutionClass: { read_only: 60 } });
    expect(markdown).toContain("250 tools");
    const json = buildCapabilitiesJson({ version: "0.1.0", toolCount: 250, byExecutionClass: {} });
    expect(json).toMatchObject({ product: "osseo", toolCount: 250 });
  });

  it("states the automatic overlay mode and fallback", () => {
    const overlay = { mode: "always" as const, triggers: ["computer.*", "desktop.*"], fallback: "osseo overlay status" };
    expect(buildCapabilityMarkdown({ version: "0.1.0", overlay })).toContain("Activity overlay: mode `always`");
    expect(buildCapabilitiesJson({ version: "0.1.0", overlay }).overlay).toEqual(overlay);
  });
});
