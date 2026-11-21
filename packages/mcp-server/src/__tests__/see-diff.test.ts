import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultPolicy } from "@osseo/core";
import type { OsseoMcpContext } from "../context.js";

const calls: Array<{ name: string; input: Record<string, any> }> = [];
vi.mock("../nested.js", () => ({
  callGoverned: vi.fn(async (_context: unknown, name: string, input: Record<string, any>) => {
    calls.push({ name, input });
    return { ok: true, tool: name, riskLevel: "medium", approval: { required: false, status: "not_required" }, data: { effect: { screenChanged: false } }, observations: ["Clicked. No visible change in the window: the click may have missed."], error: null };
  })
}));

import { createNumberedTools } from "../tools/numbered.js";
import { createSeeTool } from "../tools/see.js";
import { diffOutlines, NO_CHANGE, observeStructure, parseOutlineLine } from "../see-diff.js";
import { forgetViews, recallView, viewForWindow } from "../view-registry.js";

const WIN = { x: 100, y: 50, width: 600, height: 400 };
const at = (y: number) => ({ x: 120, y, width: 100, height: 20 });
const node = (id: string, role: string, name: string, y: number, extra: Record<string, unknown> = {}) => ({ id, role, name, enabled: true, bounds: at(y), ...extra });
const treeOf = (...children: unknown[]) => ({ supported: true, backend: "t", root: { id: "r", role: "frame", name: "Form", bounds: WIN, children }, nodeCount: 9, truncated: false, redacted: false, reason: "ok" });

let current: unknown;
let never = false;
function fake(): OsseoMcpContext {
  return {
    config: { osseoDir: "/tmp/osseo-see-diff-test" },
    policy: getDefaultPolicy(),
    linux: {
      getActiveWindow: async () => ({ activeWindow: { windowId: "w1", title: "Form - App", appName: "App", pid: 7 } }),
      getActiveWindowBounds: async () => ({ supported: true, bounds: WIN, reason: "ok" }),
      listWindows: async () => ({ supported: true, backend: "t", truncated: false, reason: "ok", windows: [{ windowId: "w1", title: "Form - App", appName: "App", pid: 7, bounds: WIN }] }),
      getAccessibilityTree: () => never ? new Promise(() => undefined) : Promise.resolve(current)
    }
  } as unknown as OsseoMcpContext;
}

const see = createSeeTool() as unknown as { inputSchema: { parse(v: unknown): unknown }; handler(input: unknown, context: OsseoMcpContext): Promise<any> };
const numbered = new Map((createNumberedTools() as unknown as Array<{ name: string; inputSchema: { parse(v: unknown): unknown }; auditOutputSummary?: (r: any) => string; handler(i: unknown, c: OsseoMcpContext): Promise<any> }>).map((t) => [t.name, t]));
const act = (name: string, input: unknown, ctx: OsseoMcpContext) => numbered.get(name)!.handler(numbered.get(name)!.inputSchema.parse(input), ctx);
const look = (ctx: OsseoMcpContext) => see.handler(see.inputSchema.parse({ picture: "none" }), ctx);

beforeEach(() => { calls.length = 0; never = false; });
afterEach(() => forgetViews());

describe("diffOutlines", () => {
  it("reports a changed value of an ordinary field, cut to 40 characters", () => {
    const long = "Ada Lovelace ".repeat(10);
    const diff = diffOutlines(['[1] entry "Name"'], [`[1] entry "Name" = "${long.slice(0, 39)}…"`.replace("…", "") + ' and more beyond"']);
    expect(diff.count).toBe(1);
    expect(diff.changes[0]).toMatch(/^field "Name" now reads ".{1,40}"$/);
    expect(diff.changes[0]!.match(/now reads "(.*)"$/)![1]!.length).toBeLessThanOrEqual(40);
    expect(diffOutlines(['[2] entry "Name" = "Bob"'], ['[2] entry "Name" = "Ada"']).changes).toEqual(['field "Name" now reads "Ada"']);
    expect(diffOutlines(['[2] entry "Name" = "Bob"'], ['[2] entry "Name"']).changes).toEqual(['field "Name" was cleared']);
  });

  it("never shows a value for a protected field", () => {
    const diff = diffOutlines(['[3] entry "Card" = "4111 1111"'], ["[3] entry \"Card\" (blocked)"]);
    expect(diff.changes).toEqual(["protected field changed"]);
    expect(diff.protectedChanged).toBe(1);
    expect(JSON.stringify(diff)).not.toContain("4111");
    expect(diffOutlines(["[1] password field (blocked)"], ["[7] password field (blocked)"]).changes).toEqual([NO_CHANGE]);
    expect(diffOutlines([], ["[1] password field (blocked)"]).changes).toEqual(["a protected field appeared"]);
  });

  it("reports appeared and gone elements and counts them", () => {
    const diff = diffOutlines(['[1] button "Save"', '[2] dialog "Confirm"'], ['[1] button "Save"', '[2] button "Close"']);
    expect(diff.changes).toEqual(['button "Close" appeared', 'dialog "Confirm" went away']);
    expect(diff).toMatchObject({ count: 2, appeared: 1, wentAway: 1, changed: 0 });
  });

  it("reports checkbox and enabled state", () => {
    expect(diffOutlines(['[1] check box "Subscribe"'], ['[1] check box "Subscribe" (checked)']).changes).toEqual(['check box "Subscribe" is now checked']);
    expect(diffOutlines(['[1] check box "Subscribe" (checked)'], ['[1] check box "Subscribe"']).changes).toEqual(['check box "Subscribe" is no longer checked']);
    expect(diffOutlines(['[1] button "Save"'], ['[1] button "Save" (disabled)']).changes).toEqual(['button "Save" is now disabled']);
  });

  it("ignores renumbering and says nothing changed otherwise", () => {
    const diff = diffOutlines(['[1] button "A"', '[2] button "B"'], ['[1] button "B"', '[2] button "A"']);
    expect(diff).toMatchObject({ changes: [NO_CHANGE], count: 0 });
  });

  it("caps the sentences but keeps the true count", () => {
    const after = Array.from({ length: 15 }, (_, i) => `[${i + 1}] button "B${i}"`);
    const diff = diffOutlines([], after);
    expect(diff.count).toBe(15);
    expect(diff.changes).toHaveLength(11);
    expect(diff.changes.at(-1)).toBe("and 5 more changes");
  });

  it("parses nameless fields and values", () => {
    expect(parseOutlineLine('[4] entry = "x" (disabled)')).toMatchObject({ role: "entry", name: "", value: "x", enabled: false });
  });
});

describe("structure after a numbered action", () => {
  async function setup() {
    current = treeOf(node("1", "push button", "Save", 100), node("2", "entry", "Name", 130, { text: "" }));
    const ctx = fake();
    const seen = await look(ctx);
    return { ctx, view: seen.data.view as string };
  }

  it("reports what changed, keeps pixels secondary, and keeps the stale-numbers note", async () => {
    const { ctx, view } = await setup();
    current = treeOf(node("1", "push button", "Save", 100), node("2", "entry", "Name", 130, { text: "Ada" }));
    const result = await act("click", { n: 1, view }, ctx);
    expect(result.data).toMatchObject({ structure: "used", changeCount: 1, changes: ['field "Name" now reads "Ada"'], effect: { screenChanged: false } });
    expect(result.observations).toContain("Call see again before using numbers: the screen may have changed.");
    expect(result.observations.join(" ")).not.toContain("No visible change");
  });

  it("says no change in words and keeps the pixel note", async () => {
    const { ctx, view } = await setup();
    const result = await act("click", { n: 1, view }, ctx);
    expect(result.data).toMatchObject({ structure: "used", changeCount: 0, changes: [NO_CHANGE] });
    expect(result.observations.join(" ")).toContain("No visible change in the window");
  });

  it("falls back to pixels when the outline is empty", async () => {
    const { ctx, view } = await setup();
    current = treeOf();
    const result = await act("click", { n: 1, view }, ctx);
    expect(result.data).toMatchObject({ structure: "unavailable", structureReason: "empty", changes: [], changeCount: 0, effect: { screenChanged: false } });
    expect(result.observations.join(" ")).toContain("No visible change in the window");
    expect(result.observations.join(" ")).toContain("empty");
  });

  it("falls back on a timeout", async () => {
    const { ctx } = await setup();
    never = true;
    const outcome = await observeStructure(ctx, viewForWindow("w1"), "w1", 20);
    expect(outcome).toMatchObject({ structure: "unavailable", reason: "timeout", changes: [] });
  });

  it("does not compare a window other than the view's", async () => {
    const { ctx } = await setup();
    expect(await observeStructure(ctx, viewForWindow("w1"), "w2")).toMatchObject({ structure: "unavailable", reason: "window_differs" });
    expect(await observeStructure(ctx, undefined, "w1")).toMatchObject({ structure: "unavailable", reason: "no_view" });
  });

  it("stores the new outline, so the second action diffs against it, while the numbers stay those of the last see", async () => {
    const { ctx, view } = await setup();
    const targetsBefore = recallView(view, Date.now())!.targets;
    current = treeOf(node("1", "push button", "Save", 100), node("2", "entry", "Name", 130, { text: "Ada" }));
    await act("click", { n: 1, view }, ctx);
    expect(recallView(view)!.outline).toContain('[2] entry "Name" = "Ada"');
    expect(recallView(view)!.targets).toBe(targetsBefore);
    current = treeOf(node("1", "push button", "Save", 100), node("2", "entry", "Name", 130, { text: "Ada" }), node("3", "push button", "Done", 160));
    const second = await act("key", { keys: "Return" }, ctx);
    expect(second.data.changes).toEqual(['button "Done" appeared']);
  });

  it("audits counts only: no typed text, no changed text", async () => {
    const { ctx, view } = await setup();
    current = treeOf(node("1", "push button", "Save", 100), node("2", "entry", "Name", 130, { text: "Secret Ada" }));
    const result = await act("type", { n: 2, view, text: "Secret Ada" }, ctx);
    const summary = numbered.get("type")!.auditOutputSummary!(result);
    expect(summary).toBe("type completed. structure: used, changeCount: 1");
    expect(summary).not.toContain("Ada");
    expect(summary).not.toContain("Name");
  });
});
