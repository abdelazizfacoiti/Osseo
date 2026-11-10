import { describe, expect, it, vi } from "vitest";
import { toolSuccess, type OverlayWidget } from "@agenthost/core";
import type { OverlayManager } from "@agenthost/app-overlay";
import { ToolActionOverlay } from "../action-overlay.js";
import { ActionTimeline } from "../action-timeline.js";

function manager() {
  let visible = false;
  const shown: OverlayWidget[] = [];
  const dismissed: string[] = [];
  const fake = {
    showWidget: vi.fn(async (widget: OverlayWidget) => { visible = true; shown.push(widget); return { ok: true, errors: [] }; }),
    showPrimitive: vi.fn(async () => ({ ok: true, errors: [] })),
    updateWidget: vi.fn(async () => (visible ? { ok: true, reason: "overlay_widget_updated", acknowledged: true } : { ok: false, reason: "overlay_not_found" })),
    dismiss: vi.fn(async (id: string) => { visible = false; dismissed.push(id); return { ok: true, reason: "dismissed", acknowledged: true }; }),
    capabilities: vi.fn(() => ({ visible: true, supported: true })),
    pollEvents: vi.fn(async () => [])
  } as unknown as OverlayManager;
  return { manager: fake, dismissed };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("action card holds while a task is open", () => {
  it("stays up after an action while held, and hides when not held", async () => {
    const { manager: fake, dismissed } = manager();
    let held = true;
    const overlay = new ToolActionOverlay(fake, { widgetId: "pill", persistent: false, autoHideMs: 1_000, minDisplayMs: 0, frame: false, targetRing: false, holdVisible: () => held });
    const first = await overlay.begin({ tool: "desktop.click", summary: "Click", riskLevel: "low" });
    await first.finish(toolSuccess({ tool: "desktop.click", riskLevel: "low", approval: { required: false, status: "not_required" }, data: null, observations: [] }));
    await wait(1_300);
    expect(dismissed).not.toContain("pill");
    held = false;
    const second = await overlay.begin({ tool: "desktop.click", summary: "Click", riskLevel: "low" });
    await second.finish(toolSuccess({ tool: "desktop.click", riskLevel: "low", approval: { required: false, status: "not_required" }, data: null, observations: [] }));
    await wait(1_300);
    expect(dismissed).toContain("pill");
    await overlay.close();
  }, 10_000);
});

describe("action timeline reset", () => {
  it("closes the dock and clears its history", async () => {
    const { manager: fake, dismissed } = manager();
    const timeline = new ActionTimeline(fake, { sessionId: "s", alertPollMs: 60_000 });
    const done = timeline.begin("desktop.click", { x: 1, y: 2 });
    await done(toolSuccess({ tool: "desktop.click", riskLevel: "low", approval: { required: false, status: "not_required" }, data: null, observations: [] }));
    expect(timeline.visible).toBe(true);
    expect(timeline.entries().length).toBeGreaterThan(0);
    await timeline.reset();
    expect(timeline.visible).toBe(false);
    expect(timeline.entries()).toHaveLength(0);
    expect(dismissed).toContain(timeline.widgetId);
    await timeline.close();
  });
});
