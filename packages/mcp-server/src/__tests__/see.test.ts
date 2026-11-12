import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultPolicy } from "@agenthost/core";
import type { AgentHostMcpContext } from "../context.js";

const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
const screenshot = { ok: true as boolean };
vi.mock("../nested.js", () => ({
  callGoverned: vi.fn(async (_context: unknown, name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    if (!screenshot.ok) return { ok: false, data: null, error: { code: "screenshot_failed", message: "x" }, observations: [] };
    return {
      ok: true,
      data: { inlineImage: { data: "UExBSU4=", mimeType: "image/jpeg" }, inline: { scale: 0.5 }, screenshotMetadata: { screenOrigin: { x: 100, y: 50 } } },
      observations: []
    };
  })
}));
const drawMarks = vi.fn(async (_dir: string, _jpeg: string, _marks: unknown[]): Promise<string | undefined> => "TUFSS0VE");
vi.mock("../tools/see-marks.js", () => ({ MAX_MARKS: 40, drawMarks: (...args: [string, string, unknown[]]) => drawMarks(...args) }));
const ocr = vi.fn(async (_context: unknown, _input: unknown): Promise<unknown> => ({ ok: false }));
vi.mock("../tools/vision.js", () => ({ findScreenTextMatches: (context: unknown, input: unknown) => ocr(context, input) }));

import { createSeeTool, formatLine } from "../tools/see.js";
import { forgetViews, recallView } from "../view-registry.js";

const see = createSeeTool() as unknown as { inputSchema: { parse(v: unknown): unknown }; handler(input: unknown, context: AgentHostMcpContext): Promise<{ ok: boolean; data: any; error: { code: string } | null; observations: string[] }> };

const WIN = { x: 100, y: 50, width: 600, height: 400 };
const at = (y: number) => ({ x: 120, y, width: 100, height: 20 });
const tree = {
  id: "root", role: "frame", name: "Form", bounds: WIN,
  children: [
    { id: "1", role: "push button", name: "Save", enabled: true, bounds: at(100) },
    { id: "2", role: "entry", name: "Name", text: "Ada ".repeat(30), enabled: true, bounds: at(130) },
    { id: "3", role: "check box", name: "Subscribe", enabled: true, bounds: at(160) },
    { id: "4", role: "push button", name: "Delete", enabled: false, bounds: at(190) },
    { id: "5", role: "password text", name: "Password", text: "hunter2", sensitive: true, bounds: at(220) },
    { id: "6", role: "label", name: "Some page text", bounds: at(250) },
    { id: "7", role: "push button", name: "Ghost", hidden: true, bounds: at(280) },
    { id: "8", role: "push button", name: "Elsewhere", enabled: true, bounds: { x: 900, y: 900, width: 50, height: 20 } }
  ]
};

function fake(options: { tree?: unknown; browser?: unknown; active?: boolean; app?: string; windows?: unknown[] } = {}) {
  return {
    config: { agentHostDir: "/tmp/agenthost-see-test" },
    policy: getDefaultPolicy(),
    linux: {
      browser: options.browser,
      getActiveWindow: async () => ({ activeWindow: options.active === false ? undefined : { windowId: "w1", title: "Form - App", appName: options.app ?? "App", pid: 7 } }),
      getActiveWindowBounds: async () => ({ supported: true, bounds: WIN, reason: "ok" }),
      listWindows: async () => ({ supported: true, backend: "t", truncated: false, reason: "ok", windows: options.windows ?? [{ windowId: "w1", title: "Form - App", appName: "App", pid: 7, bounds: WIN }] }),
      getAccessibilityTree: async () => options.tree === undefined ? { supported: true, backend: "t", root: tree, nodeCount: 9, truncated: false, redacted: false, reason: "ok" } : options.tree
    }
  } as unknown as AgentHostMcpContext;
}

const run = (context: AgentHostMcpContext, input: unknown = {}) => see.handler(see.inputSchema.parse(input), context);

beforeEach(() => { calls.length = 0; screenshot.ok = true; drawMarks.mockClear(); ocr.mockClear(); });
afterEach(() => forgetViews());

describe("formatLine", () => {
  it("writes role, name, value and state on one line", () => {
    expect(formatLine(1, { role: "push button", name: "Save", enabled: true, blocked: false })).toBe('[1] button "Save"');
    expect(formatLine(2, { role: "entry", name: "Name", value: "Ada", enabled: true, blocked: false })).toBe('[2] entry "Name" = "Ada"');
    expect(formatLine(3, { role: "check box", name: "Subscribe", checked: true, enabled: true, blocked: false })).toBe('[3] check box "Subscribe" (checked)');
    expect(formatLine(4, { role: "push button", name: "Delete", enabled: false, blocked: false })).toBe('[4] button "Delete" (disabled)');
    expect(formatLine(5, { role: "password text", name: "Password", value: "x", enabled: true, blocked: true })).toBe("[5] password field (blocked)");
  });
});

describe("see from the accessibility tree", () => {
  it("numbers actionable elements in the documented line format", async () => {
    const result = await run(fake(), { picture: "none" });
    expect(result.ok).toBe(true);
    const lines = result.data.list.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('[1] button "Save"');
    expect(lines[1]).toMatch(/^\[2\] entry "Name" = "Ada Ada Ada Ada Ada Ada Ada Ada Ada Ada.{0,3}"$/);
    expect(lines[2]).toBe('[3] check box "Subscribe"');
    expect(lines[3]).toBe('[4] button "Delete" (disabled)');
    expect(lines[4]).toBe("[5] password field (blocked)");
    expect(result.data).toMatchObject({ source: "accessibility", count: 5, truncated: false, window: { id: "w1", title: "Form - App", app: "App" } });
    expect(result.data.view).toMatch(/^v_/);
  });

  it("cuts a field value to 40 characters, skips page text, hidden nodes and elements outside the window", async () => {
    const result = await run(fake(), { picture: "none" });
    const name = result.data.list.split("\n")[1] as string;
    const value = /= "(.*)"$/.exec(name)![1]!;
    expect(value.length).toBeLessThanOrEqual(40);
    expect(result.data.list).not.toContain("Some page text");
    expect(result.data.list).not.toContain("Ghost");
    expect(result.data.list).not.toContain("Elsewhere");
  });

  it("never shows a sensitive value or a secret-looking name, and the number cannot be acted on", async () => {
    const result = await run(fake(), { picture: "none" });
    expect(result.data.list).not.toContain("hunter2");
    expect(result.data.list).not.toContain("Password");
    const target = recallView(result.data.view, Date.now())!.targets.get(5)!;
    expect(target).toMatchObject({ kind: "screen", blocked: true, windowId: "w1" });
  });

  it("filters by name or role, case-insensitively, and numbers from 1", async () => {
    const byName = await run(fake(), { filter: "SAVE", picture: "none" });
    expect(byName.data.list).toBe('[1] button "Save"');
    const byRole = await run(fake(), { filter: "check box", picture: "none" });
    expect(byRole.data.list).toBe('[1] check box "Subscribe"');
  });

  it("caps with max and says it was truncated", async () => {
    const result = await run(fake(), { max: 2, picture: "none" });
    expect(result.data.count).toBe(2);
    expect(result.data.truncated).toBe(true);
    expect(result.observations.join(" ")).toContain("2 of 5");
  });

  it("stores screen targets with bounds, role, name and window", async () => {
    const result = await run(fake(), { picture: "none" });
    expect(recallView(result.data.view, Date.now())!.targets.get(1)).toEqual({ kind: "screen", bounds: at(100), enabled: true, blocked: false, role: "push button", name: "Save", windowId: "w1" });
    expect(recallView(result.data.view, Date.now())!.targets.get(4)).toMatchObject({ enabled: false });
  });

  it("replaces the view of the same window on the next see", async () => {
    const first = await run(fake(), { picture: "none" });
    const second = await run(fake(), { picture: "none" });
    expect(recallView(first.data.view, Date.now())).toBeUndefined();
    expect(recallView(second.data.view, Date.now())).toBeDefined();
  });

  it("refuses a credential app and reads nothing", async () => {
    const result = await run(fake({ app: "KeePassXC" }));
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe("safety_blocked");
    expect(calls).toHaveLength(0);
  });

  it("fails clearly when there is no active window or the window id is unknown", async () => {
    expect((await run(fake({ active: false }))).error!.code).toBe("active_window_unavailable");
    expect((await run(fake(), { window: "nope" })).error!.code).toBe("window_not_found");
  });
});

describe("see from the agent's own browser", () => {
  const elements = [
    { ref: "s1-e1", role: "button", name: "Go", tag: "button" },
    { ref: "s1-e2", role: "textbox", name: "Name", tag: "input", type: "text", value: "Ada" },
    { ref: "s1-e3", role: "checkbox", name: "Subscribe", tag: "input", type: "checkbox", checked: true },
    { ref: "s1-e4", role: "textbox", name: "Pass", tag: "input", type: "password", value: "hunter2" },
    { ref: "s1-e5", role: "button", name: "Off", tag: "button", disabled: true }
  ];
  const browser = {
    state: async () => ({ url: "file:///form.html", title: "Form" }),
    snapshot: async () => ({ url: "file:///form.html", title: "Form", elements, text: "page text", truncated: false }),
    describe: async () => ({ sensitiveField: false })
  };

  it("uses dom elements when the browser page is the active window", async () => {
    const context = fake({ browser });
    const result = await run(context, { picture: "none" });
    expect(result.data.source).toBe("dom");
    expect(result.data.window).toMatchObject({ id: "browser", title: "Form" });
    expect(result.data.list.split("\n")).toEqual([
      '[1] button "Go"',
      '[2] entry "Name" = "Ada"',
      '[3] check box "Subscribe" (checked)',
      "[4] password field (blocked)",
      '[5] button "Off" (disabled)'
    ]);
    expect(result.data.list).not.toContain("hunter2");
    expect(recallView(result.data.view, Date.now())!.targets.get(2)).toMatchObject({ kind: "dom", ref: "s1-e2" });
  });

  it("uses dom elements when there is no window system at all", async () => {
    const result = await run(fake({ browser, active: false }), { picture: "none" });
    expect(result.data.source).toBe("dom");
  });

  it("falls back to the accessibility tree when another window is active", async () => {
    const result = await run(fake({ browser: { ...browser, state: async () => ({ url: "file:///x", title: "Other page" }) } }), { picture: "none" });
    expect(result.data.source).toBe("accessibility");
  });

  it("marks a field blocked when the page says it is sensitive", async () => {
    const sensitive = { ...browser, describe: async (input: { ref: string }) => ({ sensitiveField: input.ref === "s1-e2" }) };
    const result = await run(fake({ browser: sensitive }), { picture: "none" });
    expect(result.data.list.split("\n")[1]).toBe('[2] entry "Name" (blocked)');
  });

  it("refuses a login page", async () => {
    const login = { ...browser, state: async () => ({ url: "https://accounts.google.com/signin", title: "Form" }) };
    const result = await run(fake({ browser: login }));
    expect(result.error!.code).toBe("safety_blocked");
  });
});

describe("see with OCR and no source", () => {
  it("uses OCR words when the tree is empty", async () => {
    ocr.mockResolvedValueOnce({
      ok: true,
      data: { matches: [
        { text: "Hello", screenBounds: at(100) },
        { text: "World", screenBounds: at(130) },
        { text: "Away", screenBounds: { x: 900, y: 900, width: 40, height: 10 } },
        { text: "secret", redacted: true, screenBounds: at(160) }
      ] }
    });
    const result = await run(fake({ tree: { supported: false, backend: "t", nodeCount: 0, truncated: false, redacted: false, reason: "none" } }), { picture: "none" });
    expect(result.data.source).toBe("ocr");
    expect(result.data.list).toBe('[1] text "Hello"\n[2] text "World"');
    expect(result.observations.join(" ")).toContain("OCR");
  });

  it("reports source none with a plain picture when nothing is found", async () => {
    const result = await run(fake({ tree: { supported: false, backend: "t", nodeCount: 0, truncated: false, redacted: false, reason: "none" } }));
    expect(result.data).toMatchObject({ source: "none", count: 0, list: "", picture: "plain" });
    expect(result.data.inlineImage).toBeDefined();
  });
});

describe("see picture modes", () => {
  it("auto sends no picture for an accessibility list of three or more", async () => {
    const result = await run(fake());
    expect(result.data.picture).toBe("none");
    expect(result.data.inlineImage).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("auto sends a plain picture for a thin list", async () => {
    const thin = { supported: true, backend: "t", root: { id: "r", role: "frame", bounds: WIN, children: [{ id: "1", role: "push button", name: "Only", enabled: true, bounds: at(100) }] }, nodeCount: 2, truncated: false, redacted: false, reason: "ok" };
    const result = await run(fake({ tree: thin }));
    expect(result.data.picture).toBe("plain");
    expect(calls[0]).toMatchObject({ name: "desktop.screenshot", input: { includeActiveWindowOnly: true } });
  });

  it("none never captures; plain attaches the window picture", async () => {
    expect((await run(fake(), { picture: "none" })).data.inlineImage).toBeUndefined();
    expect(calls).toHaveLength(0);
    const plain = await run(fake(), { picture: "plain" });
    expect(plain.data.picture).toBe("plain");
    expect(plain.data.inlineImage).toEqual({ data: "UExBSU4=", mimeType: "image/jpeg" });
  });

  it("marked draws a box per element, mapped through the picture scale and origin", async () => {
    const result = await run(fake(), { picture: "marked" });
    expect(result.data.picture).toBe("marked");
    expect(result.data.inlineImage.data).toBe("TUFSS0VE");
    const marks = drawMarks.mock.calls[0]![2] as Array<{ n: number; x: number; y: number; width: number; height: number }>;
    expect(marks).toHaveLength(5);
    // scale 0.5, origin (100, 50): element 1 is at (120, 100) 100x20.
    expect(marks[0]).toEqual({ n: 1, x: 10, y: 25, width: 50, height: 10 });
  });

  it("marked falls back to plain and says so when drawing fails", async () => {
    drawMarks.mockResolvedValueOnce(undefined);
    const result = await run(fake(), { picture: "marked" });
    expect(result.data.picture).toBe("plain");
    expect(result.data.inlineImage.data).toBe("UExBSU4=");
    expect(result.observations.join(" ")).toContain("showing the plain picture");
  });

  it("a failed capture still returns the list", async () => {
    screenshot.ok = false;
    const result = await run(fake(), { picture: "plain" });
    expect(result.ok).toBe(true);
    expect(result.data.picture).toBe("none");
    expect(result.observations.join(" ")).toContain("could not be taken");
  });

  it("a window that is not active is captured by region", async () => {
    const context = fake({ windows: [{ windowId: "w1", title: "Form - App", appName: "App", pid: 7, bounds: WIN }, { windowId: "w2", title: "Other", appName: "App", pid: 7, bounds: { x: 0, y: 0, width: 300, height: 300 } }] });
    await run(context, { window: "w2", picture: "plain" });
    expect(calls[0]!.input).toMatchObject({ region: { x: 0, y: 0, width: 300, height: 300 } });
  });
});
