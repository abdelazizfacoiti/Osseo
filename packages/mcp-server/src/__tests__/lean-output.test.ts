import { describe, expect, it } from "vitest";
import type { ToolResult } from "@agenthost/core";
import { renderResultText, type StateHolder } from "../lean-output.js";

function result(overrides: Record<string, unknown> = {}): ToolResult & { serverVersion: string; serverPath: string } {
  return {
    ok: true,
    tool: "desktop.click",
    riskLevel: "medium",
    approval: { required: false, status: "not_required" },
    data: { clicked: true, activeWindow: null },
    observations: ["Clicked."],
    serverVersion: "0.1.0",
    serverPath: "/home/someone/agenthost/dist/index.js",
    ...overrides
  } as unknown as ToolResult & { serverVersion: string; serverPath: string };
}

const STATE = { activeWindow: { windowId: "7", title: "Editor" }, windowChanged: false, capturedAt: "2026-11-10T00:00:00.000Z" };

describe("renderResultText (lean)", () => {
  it("drops provenance on ordinary tools and null fields", () => {
    const shown = JSON.parse(renderResultText(result(), "lean", {}));
    expect(shown).not.toHaveProperty("serverPath");
    expect(shown).not.toHaveProperty("serverVersion");
    expect(shown.data).not.toHaveProperty("activeWindow");
    expect(shown.data).toEqual({ clicked: true });
  });

  it("drops the approval block when none is required, and keeps it when one is", () => {
    expect(JSON.parse(renderResultText(result(), "lean", {}))).not.toHaveProperty("approval");
    const pending = result({ approval: { required: true, status: "pending", tokenId: "tok_1" } });
    expect(JSON.parse(renderResultText(pending, "lean", {}))).toHaveProperty("approval.status", "pending");
  });

  it("keeps provenance on the tools that answer about the server", () => {
    const status = JSON.parse(renderResultText(result({ tool: "agent.status" }), "lean", {}));
    expect(status.serverPath).toBe("/home/someone/agenthost/dist/index.js");
    const info = JSON.parse(renderResultText(result({ tool: "system.get_info" }), "lean", {}));
    expect(info.serverVersion).toBe("0.1.0");
  });

  it("sends the state once, then says it is unchanged until it changes", () => {
    const holder: StateHolder = {};
    const first = JSON.parse(renderResultText(result({ state: STATE }), "lean", holder));
    expect(first.state.activeWindow.title).toBe("Editor");
    expect(first).not.toHaveProperty("stateUnchanged");

    const second = JSON.parse(renderResultText(result({ state: { ...STATE, capturedAt: "2026-11-10T00:00:05.000Z" } }), "lean", holder));
    expect(second).not.toHaveProperty("state");
    expect(second.stateUnchanged).toBe(true);

    const moved = JSON.parse(renderResultText(result({ state: { ...STATE, windowChanged: true } }), "lean", holder));
    expect(moved.state.windowChanged).toBe(true);
  });

  it("is compact JSON, smaller than the full rendering of the same result", () => {
    const full = renderResultText(result(), "full", {});
    const lean = renderResultText(result(), "lean", {});
    expect(lean).not.toContain("\n");
    expect(lean.length).toBeLessThan(full.length);
  });
});

describe("renderResultText (full)", () => {
  it("keeps every field, pretty-printed, as before", () => {
    const value = result({ state: STATE });
    expect(renderResultText(value, "full", {})).toBe(JSON.stringify(value, null, 2));
  });
});
