import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHostMcpContext } from "../context.js";

const calls: Array<{ name: string; input: Record<string, any> }> = [];
let reply: (name: string, input: Record<string, any>) => Record<string, any> = () => ({});
vi.mock("../nested.js", () => ({
  callGoverned: vi.fn(async (_context: unknown, name: string, input: Record<string, any>) => {
    calls.push({ name, input });
    return { ok: true, tool: name, riskLevel: "medium", approval: { required: false, status: "not_required" }, data: { done: name }, observations: ["did it"], error: null, ...reply(name, input) };
  })
}));

import { createNumberedTools } from "../tools/numbered.js";
import { forgetViews, rememberView, type Box, type ViewTarget } from "../view-registry.js";

type Tool = { name: string; delegatesExecutionArgs?: boolean; inputSchema: { safeParse(v: unknown): { success: boolean; data?: any } }; handler(input: unknown, context: AgentHostMcpContext): Promise<any> };
const tools = new Map((createNumberedTools() as unknown as Tool[]).map((tool) => [tool.name, tool]));

const WIN: Box = { x: 100, y: 50, width: 600, height: 400 };
const screen = (extra: Partial<Extract<ViewTarget, { kind: "screen" }>> = {}): ViewTarget => ({ kind: "screen", bounds: { x: 120, y: 100, width: 100, height: 20 }, enabled: true, blocked: false, role: "push button", name: "Save", windowId: "w1", ...extra });
const dom = (extra: Partial<Extract<ViewTarget, { kind: "dom" }>> = {}): ViewTarget => ({ kind: "dom", ref: "s1-e2", role: "button", name: "Go", enabled: true, blocked: false, ...extra });

function context(boundsOrNull: Box | null = WIN, options: { active?: boolean; page?: { title: string }; windows?: unknown[] } = {}): AgentHostMcpContext {
  const bounds = boundsOrNull ?? undefined;
  return {
    linux: {
      browser: options.page === undefined ? undefined : { state: async () => ({ url: "file:///x", title: options.page!.title }) },
      getActiveWindow: async () => ({ activeWindow: options.active === false ? undefined : { windowId: "w1", title: "App", appName: "App", pid: 7 } }),
      getActiveWindowBounds: async () => ({ supported: true, bounds, reason: "ok" }),
      listWindows: async () => ({ supported: true, backend: "t", truncated: false, reason: "ok", windows: options.windows ?? (bounds === undefined ? [] : [{ windowId: "w1", title: "App", appName: "App", bounds }]) }),
      findAccessibilityElement: async () => ({ supported: true, backend: "t", candidates: [], reason: "ok" })
    }
  } as unknown as AgentHostMcpContext;
}

function seen(targets: Array<[number, ViewTarget]>, windowKey = "w1") {
  return rememberView({ windowKey, ...(windowKey === "browser" ? {} : { windowBounds: WIN }), source: windowKey === "browser" ? "dom" : "accessibility", targets: new Map(targets) });
}

async function call(name: string, input: unknown, ctx: AgentHostMcpContext = context()) {
  const tool = tools.get(name)!;
  const parsed = tool.inputSchema.safeParse(input);
  expect(parsed.success, `${name} input ${JSON.stringify(input)}`).toBe(true);
  return tool.handler(parsed.data, ctx);
}

beforeEach(() => { calls.length = 0; reply = () => ({}); });
afterEach(() => forgetViews());

describe("the tools hand dryRun and confirmationToken to the nested call", () => {
  it("all are delegating tools whose schemas accept both", () => {
    for (const tool of tools.values()) expect(tool.delegatesExecutionArgs).toBe(true);
    expect(tools.size).toBe(11);
  });
});

describe("click", () => {
  it("clicks the centre of a screen element with the window pinned, and notes to see again", async () => {
    const view = seen([[1, screen()]]);
    const result = await call("click", { n: 1, view: view.id });
    expect(calls).toEqual([{ name: "desktop.click", input: { x: 170, y: 110, target: { windowId: "w1" } } }]);
    expect(result.tool).toBe("click");
    expect(result.ok).toBe(true);
    expect(result.observations).toContain("Call see again before using numbers: the screen may have changed.");
  });

  it("defaults to the newest view", async () => {
    seen([[1, screen()]], "w9");
    const view = seen([[1, screen({ windowId: "w2" })]], "w2");
    expect(view).toBeDefined();
    await call("click", { n: 1 }, context(WIN, { windows: [{ windowId: "w2", bounds: WIN }] }));
    expect(calls[0]!.input.target).toEqual({ windowId: "w2" });
  });

  it("sends a dom element to browser.click", async () => {
    const view = seen([[1, dom()]], "browser");
    await call("click", { n: 1, view: view.id });
    expect(calls).toEqual([{ name: "browser.click", input: { ref: "s1-e2" } }]);
  });

  it("uses desktop.pointer for double and right clicks", async () => {
    const view = seen([[1, screen()]]);
    await call("click", { n: 1, view: view.id, double: true });
    await call("click", { n: 1, view: view.id, button: "right" });
    expect(calls.map((c) => [c.name, c.input.action])).toEqual([["desktop.pointer", "double_click"], ["desktop.pointer", "right_click"]]);
    expect(calls[0]!.input).toMatchObject({ x: 170, y: 110, target: { windowId: "w1" } });
  });

  it("refuses double or right clicks on browser elements", async () => {
    const view = seen([[1, dom()]], "browser");
    expect((await call("click", { n: 1, view: view.id, double: true })).error.code).toBe("unsupported_for_browser");
    expect(calls).toHaveLength(0);
  });

  it("clicks x,y in the active window with plain desktop.click", async () => {
    await call("click", { x: 300, y: 200 });
    expect(calls).toEqual([{ name: "desktop.click", input: { x: 300, y: 200, activeWindow: { windowId: "w1" } } }]);
  });

  it("needs n or x and y, not both", () => {
    expect(tools.get("click")!.inputSchema.safeParse({}).success).toBe(false);
    expect(tools.get("click")!.inputSchema.safeParse({ n: 1, x: 1, y: 1 }).success).toBe(false);
    expect(tools.get("click")!.inputSchema.safeParse({ x: 1 }).success).toBe(false);
  });

  it("refuses with distinct codes and performs nothing", async () => {
    const view = seen([[1, screen({ enabled: false })], [2, screen({ blocked: true, role: "password text" })], [3, screen()]]);
    expect((await call("click", { n: 1, view: view.id })).error.code).toBe("target_disabled");
    expect((await call("click", { n: 2, view: view.id })).error.code).toBe("target_blocked");
    expect((await call("click", { n: 9, view: view.id })).error.code).toBe("number_unknown");
    expect((await call("click", { n: 1, view: "v_zzzzzz" })).error.code).toBe("view_unknown");
    expect((await call("click", { n: 3, view: view.id }, context({ ...WIN, x: 101 }))).error.code).toBe("view_stale");
    forgetViews();
    expect((await call("click", { n: 1 })).error.code).toBe("no_view");
    expect(calls).toHaveLength(0);
  });

  it("passes dryRun and confirmationToken through, and returns a nested confirmation_required intact", async () => {
    const view = seen([[1, screen()]]);
    reply = (_name, input) => input.confirmationToken === undefined
      ? { ok: false, preview: true, confirmation: { tokenId: "tok_12345678" }, error: { code: "confirmation_required", message: "confirm" }, observations: ["Operator approval: agenthost confirm tok_12345678"] }
      : {};
    const first = await call("click", { n: 1, view: view.id, dryRun: true });
    expect(calls[0]!.input.dryRun).toBe(true);
    expect(first).toMatchObject({ tool: "click", ok: false, error: { code: "confirmation_required" }, confirmation: { tokenId: "tok_12345678" } });
    expect(first.observations.join(" ")).not.toContain("Call see again");
    const second = await call("click", { n: 1, view: view.id, confirmationToken: "tok_12345678" });
    expect(calls[1]!.input.confirmationToken).toBe("tok_12345678");
    // The repeat builds the same nested arguments, so the token binds.
    const { confirmationToken: _t, ...repeated } = calls[1]!.input;
    const { dryRun: _d, ...firstInput } = calls[0]!.input;
    expect(repeated).toEqual(firstInput);
    expect(second.ok).toBe(true);
  });

  it("does not add the see-again note after a failure", async () => {
    const view = seen([[1, screen()]]);
    reply = () => ({ ok: false, error: { code: "x", message: "y" } });
    expect((await call("click", { n: 1, view: view.id })).observations).not.toContain("Call see again before using numbers: the screen may have changed.");
  });
});

describe("type", () => {
  it("uses set_field for a screen element (replace by default)", async () => {
    const view = seen([[1, screen({ role: "entry" })]]);
    await call("type", { n: 1, view: view.id, text: "Ada" });
    expect(calls).toEqual([{ name: "desktop.set_field", input: { x: 170, y: 110, text: "Ada", replace: true, target: { windowId: "w1" } } }]);
  });

  it("appends when clear is false", async () => {
    const view = seen([[1, screen({ role: "entry" })]]);
    await call("type", { n: 1, view: view.id, text: "!", clear: false });
    expect(calls[0]!.input.replace).toBe(false);
  });

  it("presses Return after a successful submit, but not after a failure or a preview", async () => {
    const view = seen([[1, screen({ role: "entry" })]]);
    const ok = await call("type", { n: 1, view: view.id, text: "Ada", submit: true });
    expect(calls.map((c) => c.name)).toEqual(["desktop.set_field", "desktop.hotkey"]);
    expect(calls[1]!.input).toEqual({ keys: ["Return"], target: { windowId: "w1" } });
    expect(ok.ok).toBe(true);
    calls.length = 0;
    await call("type", { n: 1, view: view.id, text: "Ada", submit: true, dryRun: true });
    expect(calls.map((c) => c.name)).toEqual(["desktop.set_field"]);
    calls.length = 0;
    reply = () => ({ ok: false, error: { code: "readback_mismatch", message: "x" } });
    await call("type", { n: 1, view: view.id, text: "Ada", submit: true });
    expect(calls.map((c) => c.name)).toEqual(["desktop.set_field"]);
  });

  it("uses browser.fill (with read-back) for a dom element, browser.type to append or submit", async () => {
    const view = seen([[1, dom({ role: "entry" })]], "browser");
    await call("type", { n: 1, view: view.id, text: "Ada" });
    await call("type", { n: 1, view: view.id, text: "Ada", submit: true });
    await call("type", { n: 1, view: view.id, text: "Ada", clear: false });
    expect(calls).toEqual([
      { name: "browser.fill", input: { fields: [{ ref: "s1-e2", text: "Ada" }] } },
      { name: "browser.type", input: { ref: "s1-e2", text: "Ada", clear: true, submit: true } },
      { name: "browser.type", input: { ref: "s1-e2", text: "Ada", clear: false } }
    ]);
  });

  it("types into the focused control without n", async () => {
    await call("type", { text: "hello" });
    expect(calls).toEqual([{ name: "desktop.type_text", input: { text: "hello", activeWindow: { windowId: "w1" } } }]);
  });

  it("refuses sensitive, disabled and stale numbers and performs nothing", async () => {
    const view = seen([[1, screen({ blocked: true, role: "password text" })], [2, screen({ enabled: false })], [3, screen()]]);
    expect((await call("type", { n: 1, view: view.id, text: "x" })).error.code).toBe("target_blocked");
    expect((await call("type", { n: 2, view: view.id, text: "x" })).error.code).toBe("target_disabled");
    expect((await call("type", { n: 3, view: view.id, text: "x" }, context(null))).error.code).toBe("view_stale");
    expect(calls).toHaveLength(0);
  });

  it("passes the confirmation token to the nested call", async () => {
    const view = seen([[1, screen({ role: "entry" })]]);
    await call("type", { n: 1, view: view.id, text: "Ada", confirmationToken: "tok_abcdefgh" });
    expect(calls[0]!.input.confirmationToken).toBe("tok_abcdefgh");
  });
});

describe("key, scroll, drag", () => {
  it("key presses the chord with desktop.hotkey in the active window", async () => {
    await call("key", { keys: ["ctrl", "l"], repeat: 2 });
    await call("key", { keys: "Return" });
    expect(calls[0]).toEqual({ name: "desktop.hotkey", input: { keys: ["ctrl", "l"], repeat: 2, activeWindow: { windowId: "w1" } } });
    expect(calls[1]!.input.keys).toEqual(["Return"]);
  });

  it("scroll over an element, over a point, or at the pointer", async () => {
    const view = seen([[1, screen()]]);
    await call("scroll", { n: 1, view: view.id, direction: "down", amount: 3 });
    await call("scroll", { x: 400, y: 300, direction: "up" });
    await call("scroll", { direction: "down" });
    expect(calls[0]).toEqual({ name: "desktop.pointer", input: { action: "scroll", direction: "down", amount: 3, x: 170, y: 110, target: { windowId: "w1" } } });
    expect(calls[1]!.input).toMatchObject({ action: "scroll", direction: "up", x: 400, y: 300, activeWindow: { windowId: "w1" } });
    expect(calls[2]!.input.x).toBeUndefined();
  });

  it("scroll refuses a dom element with a hint", async () => {
    const view = seen([[1, dom()]], "browser");
    expect((await call("scroll", { n: 1, view: view.id, direction: "down" })).error.code).toBe("unsupported_for_browser");
  });

  it("drag from one number to another in the same window", async () => {
    const view = seen([[1, screen()], [2, screen({ bounds: { x: 300, y: 300, width: 40, height: 40 } })]]);
    await call("drag", { view: view.id, fromN: 1, toN: 2 });
    expect(calls[0]).toEqual({ name: "desktop.pointer", input: { action: "drag", startX: 170, startY: 110, endX: 320, endY: 320, target: { windowId: "w1" } } });
  });

  it("drag from a number to a point; refuses mixed windows and unknown numbers", async () => {
    const view = seen([[1, screen()], [2, screen({ windowId: "w2" })]]);
    await call("drag", { view: view.id, fromN: 1, toX: 10, toY: 20 });
    expect(calls[0]!.input).toMatchObject({ startX: 170, endX: 10, endY: 20 });
    calls.length = 0;
    expect((await call("drag", { view: view.id, fromN: 1, toN: 2 })).error.code).toBe("windows_differ");
    expect((await call("drag", { view: view.id, fromN: 1, toN: 9 })).error.code).toBe("number_unknown");
    expect(calls).toHaveLength(0);
  });
});

describe("open, windows, wait, ask, steps, status", () => {
  it("open: app, url in the agent's browser, url in the person's browser", async () => {
    await call("open", { app: "Calculator" });
    await call("open", { url: "https://example.com" });
    await call("open", { url: "https://example.com", in: "my-browser" });
    expect(calls[0]).toEqual({ name: "app.open", input: { appName: "Calculator" } });
    // headless is added only when the machine has no display.
    expect(calls[1]).toMatchObject({ name: "browser.open", input: { url: "https://example.com" } });
    expect(calls[2]).toEqual({ name: "app.open_url", input: { url: "https://example.com" } });
    expect(tools.get("open")!.inputSchema.safeParse({ app: "A", url: "https://x" }).success).toBe(false);
    expect(tools.get("open")!.inputSchema.safeParse({}).success).toBe(false);
  });

  it("windows lists, or focuses by id", async () => {
    await call("windows", {});
    await call("windows", { focus: "w2" });
    expect(calls).toEqual([
      { name: "window.list", input: { includeTitles: true, limit: 100 } },
      { name: "window.focus", input: { windowId: "w2" } }
    ]);
  });

  it("wait uses browser.wait_for when a browser page is the target, computer.wait_for for a window", async () => {
    await call("wait", { text: "Saved", timeoutMs: 3000 }, context(WIN, { page: { title: "App" } }));
    await call("wait", { window: "Save As" });
    expect(calls).toEqual([
      { name: "browser.wait_for", input: { text: "Saved", timeoutMs: 3000 } },
      { name: "computer.wait_for", input: { windowAppears: { title: "Save As" }, timeoutMs: 10000 } }
    ]);
  });

  it("wait polls for text that never shows and times out with a code", async () => {
    const result = await call("wait", { text: "Never", timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("wait_timeout");
  });

  it("wait gone returns at once when the text is not there", async () => {
    expect((await call("wait", { gone: "Spinner", timeoutMs: 200 })).ok).toBe(true);
  });

  it("ask, steps and status call the existing tools", async () => {
    await call("ask", { kind: "login", message: "Please sign in" });
    await call("steps", { steps: [{ tool: "click", input: { n: 1 } }, { tool: "desktop.hotkey", input: { keys: ["Return"] } }], stopOnError: true });
    await call("status", {});
    expect(calls).toEqual([
      { name: "agent.request_handoff", input: { kind: "login", message: "Please sign in" } },
      { name: "computer.run_steps", input: { steps: [{ tool: "click", input: { n: 1 } }, { tool: "desktop.hotkey", input: { keys: ["Return"] } }], stopOnError: true } },
      { name: "agent.status", input: {} }
    ]);
  });
});
