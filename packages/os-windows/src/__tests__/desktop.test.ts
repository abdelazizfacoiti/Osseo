import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWindowsDesktop, normalizeHwnd } from "../desktop.js";
import { HelperError, type HelperTransport } from "../helper.js";

const notepad = { hwnd: "1001", title: "Untitled - Notepad", pid: 10, process: "notepad", x: 10, y: 20, width: 800, height: 600, minimized: false };
const other = { hwnd: "2002", title: "Docs", pid: 11, process: "chrome", x: 0, y: 0, width: 1000, height: 700, minimized: false };

type Handler = (params: Record<string, unknown>) => unknown;

/** A scripted helper: answers by method name and records every request in order. */
function fakeHelper(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const helper: HelperTransport = {
    async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) throw new HelperError("unknown_method", `No handler for ${method}`);
      return handler(params) as T;
    },
    close() {}
  };
  return { helper, calls, methods: () => calls.map((call) => call.method) };
}

const noSleep = async () => undefined;

describe("normalizeHwnd", () => {
  it("accepts decimal and 0x-hex and rejects anything else", () => {
    expect(normalizeHwnd("1001")).toBe("1001");
    expect(normalizeHwnd("0x3E9")).toBe("1001");
    expect(normalizeHwnd("abc")).toBeUndefined();
    expect(normalizeHwnd(undefined)).toBeUndefined();
  });
});

describe("Windows desktop adapter", () => {
  it("reports the foreground window with its app sensitivity", async () => {
    const { helper } = fakeHelper({ "window.active": () => notepad });
    const result = await createWindowsDesktop(helper).getActiveWindow();
    expect(result).toMatchObject({ supported: true, activeWindow: { windowId: "1001", appName: "notepad", title: "Untitled - Notepad", pid: 10 } });
    expect(result.activeWindow?.appSensitivity).toBeDefined();
  });

  it("lists windows, with titles only when asked", async () => {
    const { helper } = fakeHelper({ "windows.list": () => ({ windows: [notepad, other], truncated: false }) });
    const desktop = createWindowsDesktop(helper);
    const plain = await desktop.listWindows({});
    expect(plain.windows[0]).toMatchObject({ windowId: "1001", appName: "notepad", bounds: { x: 10, y: 20, width: 800, height: 600 } });
    expect(plain.windows[0]).not.toHaveProperty("title");
    expect((await desktop.listWindows({ includeTitles: true })).windows[0]?.title).toBe("Untitled - Notepad");
  });

  it("turns a helper failure into an unsupported result, not an exception", async () => {
    const { helper } = fakeHelper({ "window.active": () => { throw new HelperError("helper_timeout", "no answer"); } });
    expect(await createWindowsDesktop(helper).getActiveWindow()).toMatchObject({ supported: false, reason: "helper_timeout: no answer" });
  });

  it("clicks in the pinned window, rounding the point", async () => {
    const { helper, calls } = fakeHelper({ "window.active": () => notepad, "input.click": () => ({}) });
    const result = await createWindowsDesktop(helper).click({ x: 100.4, y: 50.6, activeWindow: { windowId: "1001" } });
    expect(result).toMatchObject({ clicked: true, button: "left" });
    expect(calls.find((call) => call.method === "input.click")?.params).toEqual({ x: 100, y: 51, button: "left" });
  });

  it("re-activates a drifted window once, and refuses when it still is not in front", async () => {
    let focused = false;
    const drifted = fakeHelper({
      "window.active": () => (focused ? notepad : other),
      "window.focus": () => { focused = true; return {}; },
      "input.click": () => ({})
    });
    expect((await createWindowsDesktop(drifted.helper).click({ x: 1, y: 1, activeWindow: { windowId: "1001" } })).clicked).toBe(true);
    expect(drifted.methods()).toEqual(["window.active", "window.focus", "window.active", "input.click"]);

    const stuck = fakeHelper({ "window.active": () => other, "window.focus": () => ({}), "input.click": () => ({}) });
    const refused = await createWindowsDesktop(stuck.helper).click({ x: 1, y: 1, activeWindow: { windowId: "1001" } });
    expect(refused.clicked).toBe(false);
    expect(refused.reason).toContain("active_window_mismatch");
    expect(stuck.methods()).not.toContain("input.click");
  });

  it("passes the elevated-window refusal on as the reason", async () => {
    const { helper } = fakeHelper({
      "window.active": () => notepad,
      "input.click": () => { throw new HelperError("elevated_window", "That window runs as administrator."); }
    });
    const result = await createWindowsDesktop(helper).click({ x: 1, y: 1, activeWindow: { windowId: "1001" } });
    expect(result).toMatchObject({ clicked: false, reason: "elevated_window: That window runs as administrator." });
  });

  it("sends hotkeys as virtual keys with the repeat count, and rejects unknown keys without input", async () => {
    const { helper, calls } = fakeHelper({ "window.active": () => notepad, "input.keys": () => ({}) });
    const desktop = createWindowsDesktop(helper);
    expect((await desktop.hotkey({ keys: ["ctrl", "End"], repeat: 3, activeWindow: { windowId: "1001" } })).sent).toBe(true);
    expect(calls.find((call) => call.method === "input.keys")?.params).toEqual({ vks: [0x11, 0x23], repeat: 3, delayMs: 20 });
    const bad = await desktop.hotkey({ keys: ["ctrl", "bogus"], activeWindow: { windowId: "1001" } });
    expect(bad).toMatchObject({ sent: false, reason: 'Unknown key "bogus".' });
    expect(calls.filter((call) => call.method === "input.keys")).toHaveLength(1);
  });

  it("pastes text and restores the old clipboard only after the settle check", async () => {
    const order: string[] = [];
    const { helper } = fakeHelper({
      "window.active": () => notepad,
      "clipboard.get": () => { order.push("get"); return { text: "before" }; },
      "clipboard.set": (params) => { order.push(`set:${String(params.text)}`); return {}; },
      "input.keys": () => { order.push("paste"); return {}; }
    });
    const settle = async () => { order.push("settle"); };
    const result = await createWindowsDesktop(helper, { sleep: noSleep }).typeText({ text: "hello", activeWindow: { windowId: "1001" } }, { settle });
    expect(result).toMatchObject({ typed: true, method: "clipboard", characterCount: 5 });
    expect(order).toEqual(["get", "set:hello", "paste", "settle", "set:before"]);
  });

  it("clears the clipboard afterwards when it held no text, so the pasted text does not stay", async () => {
    const sets: string[] = [];
    const { helper } = fakeHelper({
      "window.active": () => notepad,
      "clipboard.get": () => ({ text: null }),
      "clipboard.set": (params) => { sets.push(String(params.text)); return {}; },
      "input.keys": () => ({})
    });
    const result = await createWindowsDesktop(helper, { sleep: noSleep }).typeText({ text: "secret-ish", activeWindow: { windowId: "1001" } });
    expect(sets).toEqual(["secret-ish", ""]);
    expect(result.reason).toContain("cleared");
  });

  it("does not paste when the window is not in front", async () => {
    const { helper, methods } = fakeHelper({ "window.active": () => other, "window.focus": () => ({}) });
    const result = await createWindowsDesktop(helper, { sleep: noSleep }).typeText({ text: "x", activeWindow: { windowId: "1001" } });
    expect(result.typed).toBe(false);
    expect(methods()).not.toContain("clipboard.set");
  });

  it("maps pointer actions: scroll directions, drag, and missing coordinates", async () => {
    const { helper, calls } = fakeHelper({ "window.active": () => notepad, "input.scroll": () => ({}), "input.drag": () => ({}), "input.move": () => ({}) });
    const desktop = createWindowsDesktop(helper);
    const window = { windowId: "1001" };
    await desktop.pointer({ action: "scroll", direction: "down", amount: 2, x: 5, y: 6, activeWindow: window });
    await desktop.pointer({ action: "scroll", direction: "left", amount: 1, activeWindow: window });
    expect(calls.filter((call) => call.method === "input.scroll").map((call) => call.params)).toEqual([
      { x: 5, y: 6, vertical: -2, horizontal: 0 },
      { vertical: 0, horizontal: -1 }
    ]);
    await desktop.pointer({ action: "drag", startX: 1, startY: 2, endX: 3, endY: 4, activeWindow: window });
    expect(calls.find((call) => call.method === "input.drag")?.params).toEqual({ x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 300 });
    expect(await desktop.pointer({ action: "move_mouse", activeWindow: window })).toMatchObject({ performed: false });
  });

  it("writes the screenshot file and reports its geometry and origin", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-win-shot-"));
    try {
      const file = path.join(dir, "shots", "a.png");
      const { helper, calls } = fakeHelper({
        "window.active": () => notepad,
        screenshot: () => ({ data: Buffer.from("PNGDATA").toString("base64"), width: 400, height: 300, originX: 10, originY: 20 })
      });
      const result = await createWindowsDesktop(helper).screenshot({ path: file, includeActiveWindowOnly: true, scale: 0.5 });
      expect(await readFile(file, "utf8")).toBe("PNGDATA");
      expect(result).toMatchObject({ supported: true, bytesWritten: 7, activeWindow: { windowId: "1001" }, screenshotMetadata: { captureKind: "active_window", imageWidth: 400, imageHeight: 300, scale: 0.5, screenOrigin: { x: 10, y: 20 } } });
      expect(calls.find((call) => call.method === "screenshot")?.params).toMatchObject({ hwnd: "1001", scale: 0.5, format: "png" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("says accessibility is unavailable when the helper cannot do UI Automation, instead of guessing", async () => {
    const { helper } = fakeHelper({});
    const desktop = createWindowsDesktop(helper);
    expect(await desktop.getAccessibilityTree({ pid: 10 })).toMatchObject({ supported: false });
    expect(await desktop.readTextAtPoint({ pid: 10, x: 1, y: 1 })).toMatchObject({ supported: false, found: false });
  });
});
