import { describe, expect, it } from "vitest";
import { createWindowsDesktop } from "../desktop.js";
import { HelperError, type HelperTransport } from "../helper.js";
import { HELPER_SCRIPT } from "../helper-script.js";

type Handler = (params: Record<string, unknown>) => unknown;

function fakeHelper(handlers: Record<string, Handler>) {
  const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
  const helper: HelperTransport = {
    async request<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
      calls.push({ method, params, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      const handler = handlers[method];
      if (handler === undefined) throw new HelperError("unknown_method", `No handler for ${method}`);
      return handler(params) as T;
    },
    close() {}
  };
  return { helper, calls };
}

const notepad = { hwnd: "1001", title: "Untitled - Notepad", pid: 10, process: "notepad", x: 10, y: 20, width: 800, height: 600, minimized: false };
const saveBounds = { x: 220, y: 270, width: 120, height: 40 };

const treeReply = {
  root: {
    id: "1001:#abc",
    role: "window",
    name: "Check",
    bounds: { x: 200, y: 200, width: 400, height: 140 },
    enabled: true,
    children: [
      { id: "1001:0#d1", role: "entry", name: "Name", text: "hello", bounds: { x: 220, y: 220, width: 360, height: 24 }, enabled: true },
      { id: "1001:1#d2", role: "password text", name: "Password", text: "hunter2", sensitive: true, enabled: true },
      { id: "1001:2#d3", role: "entry", name: "Hidden", text: "off screen", hidden: true, enabled: true },
      { id: "1001:3#d4", role: "push button", name: "Save", bounds: saveBounds, enabled: true }
    ]
  },
  nodeCount: 5,
  truncated: false,
  redacted: true
};

describe("Windows accessibility: tree", () => {
  it("maps the helper tree to the Linux shape and drops text of sensitive and hidden nodes", async () => {
    const { helper, calls } = fakeHelper({ "uia.tree": () => treeReply });
    const result = await createWindowsDesktop(helper).getAccessibilityTree({ pid: 10, maxDepth: 12, maxNodes: 150 });
    expect(result).toMatchObject({ supported: true, backend: "windows-uia", nodeCount: 5, truncated: false, redacted: true });
    const kids = result.root?.children ?? [];
    expect(kids.map((node) => node.role)).toEqual(["entry", "password text", "entry", "push button"]);
    expect(kids[0]).toMatchObject({ name: "Name", text: "hello", enabled: true });
    expect(kids[1]).toMatchObject({ sensitive: true });
    expect(kids[1]).not.toHaveProperty("text");
    expect(kids[2]).toMatchObject({ hidden: true });
    expect(kids[2]).not.toHaveProperty("text");
    expect(kids[3]?.bounds).toEqual(saveBounds);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(calls[0]?.params).toMatchObject({ pid: 10, maxDepth: 12, maxNodes: 150, includeText: false });
    expect(calls[0]?.timeoutMs).toBeGreaterThan(Number(calls[0]?.params.timeoutMs));
  });

  it("prefers a window handle, accepts hex, and resolves an app name to a pid", async () => {
    const { helper, calls } = fakeHelper({ "uia.tree": () => treeReply, "windows.list": () => ({ windows: [notepad], truncated: false }) });
    const desktop = createWindowsDesktop(helper);
    await desktop.getAccessibilityTree({ windowId: "0x3E9", pid: 99 });
    expect(calls.at(-1)?.params).toMatchObject({ hwnd: "1001" });
    expect(calls.at(-1)?.params).not.toHaveProperty("pid");
    await desktop.getAccessibilityTree({ appName: "Notepad.exe" });
    expect(calls.at(-1)?.params).toMatchObject({ pid: 10 });
    expect(await desktop.getAccessibilityTree({ appName: "nothing" })).toMatchObject({ supported: false, reason: expect.stringContaining("nothing") });
    expect(await desktop.getAccessibilityTree({})).toMatchObject({ supported: false });
  });

  it("clamps depth and node counts and passes includeText through", async () => {
    const { helper, calls } = fakeHelper({ "uia.tree": () => treeReply });
    await createWindowsDesktop(helper).getAccessibilityTree({ pid: 1, maxDepth: 99, maxNodes: 99999, includeText: true });
    expect(calls[0]?.params).toMatchObject({ maxDepth: 14, maxNodes: 1000, includeText: true });
  });

  it("says when the walk was cut off by the deadline", async () => {
    const { helper } = fakeHelper({ "uia.tree": () => ({ ...treeReply, truncated: true, timedOut: true }) });
    const result = await createWindowsDesktop(helper).getAccessibilityTree({ pid: 10 });
    expect(result).toMatchObject({ supported: true, truncated: true });
    expect(result.reason).toContain("too slowly");
  });

  it("reports an elevated window clearly instead of an empty tree", async () => {
    const { helper } = fakeHelper({ "uia.tree": () => { throw new HelperError("elevated_window", "That window runs as administrator, so a normal process cannot read or operate it."); } });
    const result = await createWindowsDesktop(helper).getAccessibilityTree({ pid: 10 });
    expect(result).toMatchObject({ supported: false, nodeCount: 0 });
    expect(result.reason).toContain("elevated_window");
    expect(result.reason).toContain("administrator");
  });

  it("reports a helper whose UI Automation did not load, with the reason", async () => {
    const { helper } = fakeHelper({ "uia.tree": () => { throw new HelperError("uia_unavailable", "UI Automation could not be loaded: compile error"); } });
    expect(await createWindowsDesktop(helper).getAccessibilityTree({ pid: 10 })).toMatchObject({ supported: false, reason: expect.stringContaining("could not be loaded") });
  });

  it("returns a supported, empty result when the app has no window", async () => {
    const { helper } = fakeHelper({ "uia.tree": () => ({ root: null, nodeCount: 0, truncated: false, redacted: false, found: false }) });
    const result = await createWindowsDesktop(helper).getAccessibilityTree({ pid: 10 });
    expect(result).toMatchObject({ supported: true, nodeCount: 0 });
    expect(result.root).toBeUndefined();
  });
});

describe("Windows accessibility: find", () => {
  const found = {
    candidates: [
      { id: "1001:3#d4", role: "push button", name: "Save", text: "Save", bounds: saveBounds, confidence: 1, reason: "Matched accessibility query.", enabled: true },
      { id: "1001:5#d5", role: "push button", name: "Save as", bounds: null, confidence: 0.9, reason: "Matched accessibility query.", enabled: false }
    ],
    truncated: false
  };

  it("maps candidates with bounds, enabled and confidence", async () => {
    const { helper, calls } = fakeHelper({ "uia.find": () => found });
    const result = await createWindowsDesktop(helper).findAccessibilityElement({ pid: 10, query: "Save", role: "push button", limit: 8 });
    expect(result.supported).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ id: "1001:3#d4", role: "push button", name: "Save", bounds: saveBounds, enabled: true, confidence: 1 });
    expect(result.candidates[1]).toMatchObject({ enabled: false });
    expect(result.candidates[1]).not.toHaveProperty("bounds");
    expect(calls[0]?.params).toMatchObject({ pid: 10, query: "Save", role: "push button", limit: 8 });
  });

  it("reports a partial search", async () => {
    const { helper } = fakeHelper({ "uia.find": () => ({ ...found, timedOut: true }) });
    expect((await createWindowsDesktop(helper).findAccessibilityElement({ pid: 10, query: "Save" })).reason).toContain("partial");
  });

  it("is unsupported (not empty) when the helper fails", async () => {
    const { helper } = fakeHelper({ "uia.find": () => { throw new HelperError("helper_timeout", "no answer"); } });
    expect(await createWindowsDesktop(helper).findAccessibilityElement({ pid: 10, query: "Save" })).toMatchObject({ supported: false, candidates: [] });
  });
});

describe("Windows accessibility: actions", () => {
  const element = {
    id: "1001:3#d4",
    role: "push button",
    name: "Save",
    states: ["enabled", "showing"],
    availableActions: ["invoke"],
    bounds: saveBounds,
    appName: "notepad",
    windowId: "1001",
    windowTitle: "Check",
    pid: 10,
    sensitive: false,
    hidden: false
  };

  it("activates by query and returns the target in the Linux shape", async () => {
    const { helper, calls } = fakeHelper({ "uia.activate": () => ({ matched: true, ambiguous: false, performed: true, action: "invoke", reason: "Performed the invoke action.", element }) });
    const result = await createWindowsDesktop(helper).invokeAccessibilityAction({ pid: 10, query: "Save", role: "push button", actionName: "click", requireExactMatch: true });
    expect(result).toMatchObject({ supported: true, matched: true, performed: true, ambiguous: false, actionName: "invoke", redacted: false });
    expect(result.target).toMatchObject({ elementId: "1001:3#d4", role: "push button", availableActions: ["invoke"], dataSensitivity: "none", appName: "notepad", windowId: "1001", pid: 10 });
    expect(calls[0]?.params).toMatchObject({ pid: 10, query: "Save", role: "push button", action: "click", requireExactMatch: true });
  });

  it("uses an element id without needing a scope", async () => {
    const { helper, calls } = fakeHelper({ "uia.activate": () => ({ matched: true, performed: true, element }) });
    const result = await createWindowsDesktop(helper).invokeAccessibilityAction({ elementId: "1001:3#d4", actionName: "click" });
    expect(result.performed).toBe(true);
    expect(calls[0]?.params).toMatchObject({ elementId: "1001:3#d4" });
    expect(calls[0]?.params).not.toHaveProperty("pid");
  });

  it("reports ambiguous, missing and disabled elements as matched/performed false, not as errors", async () => {
    const ambiguous = fakeHelper({ "uia.activate": () => ({ matched: false, ambiguous: true, performed: false, reason: "Several elements match (2)." }) });
    expect(await createWindowsDesktop(ambiguous.helper).invokeAccessibilityAction({ pid: 10, query: "Save", actionName: "click" })).toMatchObject({ supported: true, ambiguous: true, performed: false });
    const disabled = fakeHelper({ "uia.activate": () => ({ matched: true, ambiguous: false, performed: false, reason: "The element is disabled, so nothing was done.", element: { ...element, states: ["disabled"] } }) });
    const refused = await createWindowsDesktop(disabled.helper).invokeAccessibilityAction({ pid: 10, query: "Save", actionName: "click" });
    expect(refused).toMatchObject({ supported: true, matched: true, performed: false });
    expect(refused.reason).toContain("disabled");
  });

  it("refuses an elevated window with the reason", async () => {
    const { helper } = fakeHelper({ "uia.activate": () => { throw new HelperError("elevated_window", "That window runs as administrator."); } });
    const result = await createWindowsDesktop(helper).invokeAccessibilityAction({ pid: 10, query: "Save", actionName: "click" });
    expect(result).toMatchObject({ supported: false, performed: false, actionName: "click" });
    expect(result.reason).toContain("elevated_window");
  });

  it("sets text, never echoes the value, and marks a sensitive target secret", async () => {
    const field = { ...element, id: "1001:0#d1", role: "entry", name: "Name", availableActions: ["set value"], valueMetadata: { supportsText: true, supportsValue: true, editable: true, readOnly: false, textLength: 5 } };
    const { helper, calls } = fakeHelper({ "uia.setText": () => ({ matched: true, ambiguous: false, changed: true, reason: "Set the field value.", element: field }) });
    const result = await createWindowsDesktop(helper).setAccessibilityValue({ pid: 10, query: "Name", role: "entry", value: "hello" });
    expect(result).toMatchObject({ supported: true, changed: true, redacted: true, redactedValue: true });
    expect(result.target).toMatchObject({ dataSensitivity: "low", valueMetadata: { editable: true, readOnly: false, textLength: 5 } });
    expect(JSON.stringify(result)).not.toContain("hello");
    expect(calls[0]?.params).toMatchObject({ value: "hello" });

    const secret = fakeHelper({ "uia.setText": () => ({ matched: true, changed: false, reason: "That field holds a password or credential, so nothing was typed.", element: { ...field, role: "password text", name: "Password", sensitive: true, valueMetadata: { supportsText: true, supportsValue: true, editable: true, readOnly: false, textLength: 8 } } }) });
    const refused = await createWindowsDesktop(secret.helper).setAccessibilityValue({ pid: 10, query: "Password", value: "x" });
    expect(refused).toMatchObject({ supported: true, matched: true, changed: false });
    expect(refused.target).toMatchObject({ dataSensitivity: "secret" });
    expect(refused.target?.valueMetadata).not.toHaveProperty("textLength");
  });

  it("focuses an element", async () => {
    const { helper } = fakeHelper({ "uia.focus": () => ({ matched: true, ambiguous: false, focused: true, reason: "Moved keyboard focus to the element.", element }) });
    expect(await createWindowsDesktop(helper).focusAccessibilityElement({ pid: 10, query: "Save" })).toMatchObject({ supported: true, matched: true, focused: true });
  });

  it("inspects an element", async () => {
    const { helper } = fakeHelper({ "uia.inspect": () => ({ matched: true, ambiguous: false, element }) });
    const result = await createWindowsDesktop(helper).inspectAccessibilityElement({ pid: 10, query: "Save" });
    expect(result).toMatchObject({ supported: true, matched: true });
    expect(result.element?.states).toContain("enabled");
  });

  it("needs a scope when there is no element id", async () => {
    const { helper, calls } = fakeHelper({ "uia.activate": () => ({}) });
    const result = await createWindowsDesktop(helper).invokeAccessibilityAction({ query: "Save", actionName: "click" });
    expect(result.supported).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("Windows accessibility: field read-back", () => {
  it("returns the text of a normal field for read-back", async () => {
    const { helper, calls } = fakeHelper({ "uia.textAtPoint": () => ({ found: true, role: "entry", focused: true, sensitive: false, text: "hello", length: 5, reason: "Read the editable text field." }) });
    const result = await createWindowsDesktop(helper).readTextAtPoint({ pid: 10, x: 100.4, y: 50.6 });
    expect(result).toMatchObject({ supported: true, found: true, role: "entry", focused: true, sensitive: false, text: "hello", length: 5 });
    expect(calls[0]?.params).toMatchObject({ x: 100, y: 51, pid: 10 });
  });

  it("never passes on text from a sensitive field, even if the helper sent it", async () => {
    const { helper } = fakeHelper({ "uia.textAtPoint": () => ({ found: true, role: "password text", focused: true, sensitive: true, text: "hunter2", length: 7 }) });
    const result = await createWindowsDesktop(helper).readTextAtPoint({ pid: 10, x: 1, y: 1 });
    expect(result).toMatchObject({ found: true, sensitive: true });
    expect(result).not.toHaveProperty("text");
    expect(JSON.stringify(result)).not.toContain("hunter2");
    const byRole = fakeHelper({ "uia.textAtPoint": () => ({ found: true, role: "password text", focused: true, text: "hunter2" }) });
    expect(await createWindowsDesktop(byRole.helper).readTextAtPoint({ pid: 10, x: 1, y: 1 })).toMatchObject({ sensitive: true });
  });

  it("says no field was found, and is unsupported when the helper fails", async () => {
    const none = fakeHelper({ "uia.textAtPoint": () => ({ found: false, reason: "No editable text field is exposed at that point." }) });
    expect(await createWindowsDesktop(none.helper).readTextAtPoint({ pid: 10, x: 1, y: 1 })).toMatchObject({ supported: true, found: false });
    const broken = fakeHelper({ "uia.textAtPoint": () => { throw new HelperError("elevated_window", "admin"); } });
    expect(await createWindowsDesktop(broken.helper).readTextAtPoint({ pid: 10, x: 1, y: 1 })).toMatchObject({ supported: false, found: false });
  });

  it("reads one element's text, but never a sensitive element's", async () => {
    const ok = fakeHelper({ "uia.getText": () => ({ matched: true, readable: true, sensitive: false, text: "hello", length: 5, reason: "Read the element text." }) });
    expect(await createWindowsDesktop(ok.helper).readAccessibilityText({ pid: 10, query: "Name" })).toMatchObject({ supported: true, readable: true, text: "hello", length: 5 });
    const secret = fakeHelper({ "uia.getText": () => ({ matched: true, readable: true, sensitive: true, text: "hunter2" }) });
    const result = await createWindowsDesktop(secret.helper).readAccessibilityText({ pid: 10, query: "Password" });
    expect(result).toMatchObject({ readable: false, sensitive: true });
    expect(result).not.toHaveProperty("text");
  });
});

describe("Windows accessibility: capabilities and the helper script", () => {
  it("reports accessibility supported only when the helper's UI Automation answers", async () => {
    const up = fakeHelper({ ping: () => ({}), "uia.ping": () => ({ uia: true }) });
    expect((await createWindowsDesktop(up.helper).getDesktopCapabilities()).accessibility).toMatchObject({ supported: true, backend: "windows-uia" });
    const down = fakeHelper({ ping: () => ({}), "uia.ping": () => { throw new HelperError("uia_unavailable", "UI Automation could not be loaded: missing assembly"); } });
    const capabilities = await createWindowsDesktop(down.helper).getDesktopCapabilities();
    expect(capabilities.accessibility).toMatchObject({ supported: false });
    expect(capabilities.accessibility.reason).toContain("missing assembly");
    expect(capabilities.guiInput.supported).toBe(true);
  });

  it("has a case in the script for every uia method the adapter sends", async () => {
    const seen = new Set<string>();
    const recorder = {
      async request(method: string) {
        seen.add(method);
        if (method === "windows.list") return { windows: [notepad], truncated: false };
        return {};
      },
      close() {}
    };
    const desktop = createWindowsDesktop(recorder as never);
    const target = { pid: 10, query: "Save" };
    await desktop.getDesktopCapabilities();
    await desktop.getAccessibilityTree({ pid: 10 });
    await desktop.findAccessibilityElement(target);
    await desktop.readTextAtPoint({ pid: 10, x: 1, y: 1 });
    await desktop.inspectAccessibilityElement(target);
    await desktop.invokeAccessibilityAction({ ...target, actionName: "click" });
    await desktop.setAccessibilityValue({ ...target, value: "x" });
    await desktop.focusAccessibilityElement(target);
    await desktop.readAccessibilityText(target);
    const uia = [...seen].filter((method) => method.startsWith("uia."));
    expect(uia.length).toBe(9);
    for (const method of uia) expect(HELPER_SCRIPT, `no case for ${method}`).toContain(`case "${method}":`);
  });

  it("gives every UI Automation request a deadline and a worker thread", () => {
    expect(HELPER_SCRIPT).toContain("worker.Join(timeoutMs)");
    expect(HELPER_SCRIPT).toContain("ApartmentState.MTA");
    expect(HELPER_SCRIPT).toContain("elevated_window");
    // Passwords: flagged by the control, and credential-looking names, and never read.
    expect(HELPER_SCRIPT).toContain("c.IsPassword");
    expect(HELPER_SCRIPT).toContain("SecretName");
  });
});
