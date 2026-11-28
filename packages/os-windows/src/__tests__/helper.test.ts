import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWindowsDesktop } from "../desktop.js";
import { HelperError, probeWindowsDesktop, WindowsHelperProcess } from "../helper.js";
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-win-helper-"));
  dirs.push(dir);
  const script = path.join(dir, "fake.cjs");
  await writeFile(script, FAKE);
  const helper = new WindowsHelperProcess({ osseoDir: dir, command: { program: process.execPath, args: [script] }, ...extra });
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
    const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-win-helper-"));
    dirs.push(dir);
    const helper = new WindowsHelperProcess({ osseoDir: dir, command: { program: path.join(dir, "no-such-program"), args: [] } });
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

  it("compiles nothing at run time, so no DLL is written to disk", () => {
    expect(source).not.toMatch(/Add-Type\s+-TypeDefinition/i);
    expect(source).not.toMatch(/-MemberDefinition/i);
    expect(source).not.toMatch(/Add-Type\s+-Namespace/i);
    expect(source).not.toMatch(/-Language\s+CSharp/i);
    expect(source).toContain("DefineDynamicAssembly"); // the Win32 bindings are emitted in memory
    expect(source).toContain("Initialize-AhNative");
  });

  it("is safe to embed: no backticks, no dollar-brace, CRLF line endings only", () => {
    expect(source).not.toContain("`");
    expect(source).not.toContain("${");
    expect(source).not.toMatch(/[^\r]\n/);
  });

  it("closes the embedded UI Automation text on its own line", () => {
    const lines = source.split("\r\n");
    expect(lines.filter((line) => line === "'@")).toHaveLength(1);
    expect(source).toContain("$script:uiaDefinitions = @'\r\n");
  });

  it("routes uia.* lines to the UI Automation worker and keeps it optional", () => {
    expect(source).toContain("IndexOf('\"method\":\"uia.') -ge 0");
    expect(source).toContain("Invoke-UiaLine $line");
    // UI Automation loads inside try/catch, so a failure cannot take the rest of the helper down.
    const at = source.indexOf("$script:uiaError = ''");
    expect(at).toBeGreaterThan(0);
    expect(source.slice(at, at + 200)).toContain("try {");
    expect(source).toContain("'uia_unavailable'");
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
    await desktop.screenshot({ path: path.join(os.tmpdir(), "osseo-recorder.png") });
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
    for (const method of seen) expect(source, `the script has no case for ${method}`).toContain(`'${method}'`);
  });
});

describe("when antivirus blocks the helper", () => {
  // What PowerShell prints, wrapped the way it wraps it, when the antivirus scan interface refuses the script.
  const blocked = `process.stderr.write("This script contains malicious content and has been blocked by your antivirus software.\\n    + FullyQualifiedErrorId : ScriptContainedMali\\nciousContent\\n"); process.exit(1);`;

  async function fakeProgram(source: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-win-av-"));
    dirs.push(dir);
    const script = path.join(dir, "blocked.cjs");
    await writeFile(script, source);
    return { osseoDir: dir, command: { program: process.execPath, args: [script] } };
  }

  it("reports it by name instead of a bare exit code", async () => {
    const probe = await probeWindowsDesktop(await fakeProgram(blocked));
    expect(probe).toMatchObject({ ok: false, code: "helper_blocked_by_antivirus" });
    expect(probe.ok === false && probe.reason).toContain("Antivirus blocked");
  });

  it("keeps other failures as they are, and passes when the helper answers", async () => {
    expect(await probeWindowsDesktop(await fakeProgram("process.exit(2)"))).toMatchObject({ ok: false, code: "helper_exited" });
    expect(await probeWindowsDesktop(await fakeProgram(FAKE))).toEqual({ ok: true });
  });
});
