import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWindowsDesktop } from "../desktop.js";
import { HelperError, WindowsHelperProcess } from "../helper.js";
import { HELPER_SCRIPT } from "../helper-script.js";

// A stand-in for powershell.exe: a Node script that speaks the same JSON-line protocol.
const FAKE = `
const readline = require("node:readline");
process.stderr.write("noise on stderr\\n");
process.stdout.write("not a protocol line\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "ping") return process.stdout.write(JSON.stringify({ id, ok: true, result: { protocol: 1 } }) + "\\n");
  if (method === "uia.ping") return process.stdout.write(JSON.stringify({ id, ok: true, result: { uia: true } }) + "\\n");
  if (method === "echo") return process.stdout.write(JSON.stringify({ id, ok: true, result: params }) + "\\n");
  if (method === "fail") return process.stdout.write(JSON.stringify({ id, ok: false, error: { code: "elevated_window", message: "no" } }) + "\\n");
  if (method === "die") process.exit(3);
  if (method === "hang") return;
});
`;

const dirs: string[] = [];
const helpers: WindowsHelperProcess[] = [];
afterEach(async () => {
  for (const helper of helpers.splice(0)) helper.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(extra: { startTimeoutMs?: number } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-win-helper-"));
  dirs.push(dir);
  const script = path.join(dir, "fake.cjs");
  await writeFile(script, FAKE);
  const helper = new WindowsHelperProcess({ agentHostDir: dir, command: { program: process.execPath, args: [script] }, ...extra });
  helpers.push(helper);
  return helper;
}

describe("WindowsHelperProcess", () => {
  it("starts on the first request, ignores non-protocol output, and matches replies by id", async () => {
    const helper = await start();
    const [a, b] = await Promise.all([helper.request("echo", { n: 1 }), helper.request("echo", { n: 2 })]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 2 });
  });

  it("turns an error reply into a HelperError with its code", async () => {
    const helper = await start();
    await expect(helper.request("fail")).rejects.toMatchObject({ name: "HelperError", code: "elevated_window", message: "no" });
  });

  it("times out a request that is never answered", async () => {
    const helper = await start();
    await expect(helper.request("hang", {}, 150)).rejects.toMatchObject({ code: "helper_timeout" });
  });

  it("rejects pending requests when the process dies, then restarts on the next request", async () => {
    const helper = await start();
    await helper.request("echo", {});
    await expect(helper.request("die")).rejects.toMatchObject({ code: "helper_exited" });
    await expect(helper.request("echo", { again: true })).resolves.toEqual({ again: true });
  });

  it("reports a helper that cannot start", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-win-helper-"));
    dirs.push(dir);
    const helper = new WindowsHelperProcess({ agentHostDir: dir, command: { program: path.join(dir, "no-such-program"), args: [] } });
    helpers.push(helper);
    await expect(helper.request("ping")).rejects.toMatchObject({ code: "helper_unavailable" });
  });

  it("works end to end under the adapter", async () => {
    const helper = await start();
    const capabilities = await createWindowsDesktop(helper).getDesktopCapabilities();
    expect(capabilities).toMatchObject({ platform: "win32", displayAvailable: true, accessibility: { supported: true, backend: "windows-uia" } });
    expect(new HelperError("x", "y").code).toBe("x");
  });
});

describe("helper script", () => {
  const source = HELPER_SCRIPT;

  it("avoids C# newer than the compiler in Windows PowerShell 5.1 (C# 5)", () => {
    expect(source).not.toMatch(/\$"/); // string interpolation
    expect(source).not.toMatch(/\?\./); // null-conditional
    expect(source).not.toMatch(/\bnameof\s*\(/);
    expect(source).not.toMatch(/out var /);
    expect(source).not.toMatch(/\)\s*=>\s*[^{]/); // expression-bodied members and lambdas
    expect(source).not.toContain("`");
  });

  it("is a well-formed here-string with the closing marker at the start of a line", () => {
    expect(source).toContain("$source = @'\r\n");
    expect(source).toContain("\r\n'@\r\n");
    expect(source.match(/^'@$/gm)).toHaveLength(2); // the Win32 class and the UI Automation class
  });

  it("routes uia.* lines to the UI Automation class and keeps it optional", () => {
    expect(source).toContain("IndexOf('\"method\":\"uia.')");
    expect(source).toContain("[AgentHostUia.Uia]::Handle($line)");
    expect(source).toContain("[AgentHostWin.Host]::Handle($line)");
    // The UI Automation class is compiled on its own, inside try/catch, so a failure cannot take the rest down.
    const compile = source.indexOf("Add-Type -TypeDefinition $uiaSource");
    expect(compile).toBeGreaterThan(source.indexOf("try {"));
    expect(source.slice(source.indexOf("try {", source.indexOf("$uiaError = ''")), compile)).toContain("UIAutomationClient");
    expect(source).toContain("uia_unavailable");
  });

  it("handles every method the adapter sends", async () => {
    const seen = new Set<string>();
    const recorder = {
      async request(method: string) {
        seen.add(method);
        if (method === "window.active") return { hwnd: "1", title: "t", pid: 1, process: "p", x: 0, y: 0, width: 1, height: 1, minimized: false };
        if (method === "windows.list") return { windows: [], truncated: false };
        if (method === "clipboard.get") return { text: "x" };
        if (method === "screenshot") return { data: "", width: 1, height: 1, originX: 0, originY: 0 };
        if (method === "window.focus") return { focused: true, previous: null, window: null };
        if (method === "idle") return { idleMs: 0 };
        return {};
      },
      close() {}
    };
    const desktop = createWindowsDesktop(recorder as never, { sleep: async () => undefined });
    const window = { windowId: "1" };
    await desktop.getDesktopCapabilities();
    await desktop.listWindows({});
    await desktop.focusWindow({ windowId: "1" });
    await desktop.screenshot({ path: path.join(os.tmpdir(), "agenthost-recorder.png") });
    await desktop.getScreenGeometry();
    await desktop.hotkey({ keys: ["ctrl", "a"], activeWindow: window });
    await desktop.typeText({ text: "a", activeWindow: window });
    await desktop.click({ x: 1, y: 1, activeWindow: window });
    for (const action of ["move_mouse", "double_click", "right_click"] as const) await desktop.pointer({ action, x: 1, y: 1, activeWindow: window });
    await desktop.pointer({ action: "scroll", activeWindow: window });
    await desktop.pointer({ action: "drag", startX: 1, startY: 1, endX: 2, endY: 2, activeWindow: window });
    await desktop.setClipboard({ text: "x" });
    await desktop.getClipboard();
    await desktop.userIdleMs();
    // Every UI Automation method the adapter can send.
    const uia = { pid: 10, query: "Save", role: "push button" };
    await desktop.getAccessibilityTree({ pid: 10 });
    await desktop.findAccessibilityElement({ pid: 10, query: "Save" });
    await desktop.readTextAtPoint({ pid: 10, x: 1, y: 1 });
    await desktop.inspectAccessibilityElement(uia);
    await desktop.invokeAccessibilityAction({ ...uia, actionName: "click" });
    await desktop.setAccessibilityValue({ ...uia, value: "x" });
    await desktop.focusAccessibilityElement(uia);
    await desktop.readAccessibilityText(uia);
    expect(seen.size).toBeGreaterThan(10);
    for (const method of ["uia.ping", "uia.tree", "uia.find", "uia.textAtPoint", "uia.inspect", "uia.activate", "uia.setText", "uia.focus", "uia.getText"]) expect(seen.has(method), `the adapter never sends ${method}`).toBe(true);
    for (const method of seen) expect(source, `the script has no case for ${method}`).toContain(`case "${method}":`);
  });
});
