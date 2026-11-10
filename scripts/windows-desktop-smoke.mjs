#!/usr/bin/env node
/*
 * Checks the Windows desktop adapter (W2) on a real Windows machine. It starts the PowerShell helper,
 * reads windows, screenshots and the clipboard, and then drives a small borderless test window that
 * it creates itself (a text box and a Save button): focus, click, paste, select-all, click.
 * The window writes what the text box held to a file, so the result is checked, not assumed.
 *
 *   npm run build && node scripts/windows-desktop-smoke.mjs [--no-input] [--elevated-probe]
 *
 * --no-input        skips the test window (no mouse or keyboard input is sent)
 * --elevated-probe  focus an administrator window within 8 seconds; AgentHost must refuse input to it
 *
 * Do not touch the mouse or keyboard while it runs (about 20 seconds). It never sends input outside
 * its own test window.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "packages", "os-windows", "dist", "index.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const counts = { PASS: 0, FAIL: 0, SKIP: 0, NOTE: 0 };
const record = (status, name, detail = "") => {
  counts[status] += 1;
  console.log(`${status.padEnd(4)}  ${name}${detail === "" ? "" : `  (${detail})`}`);
};
const check = (name, ok, detail = "") => record(ok ? "PASS" : "FAIL", name, ok ? "" : detail);

if (process.platform !== "win32") {
  console.log(`SKIP  this check drives Windows; nothing to do on ${process.platform}`);
  process.exit(0);
}
if (!existsSync(DIST)) {
  console.log("FAIL  build first: npm run build");
  process.exit(2);
}
const args = new Set(process.argv.slice(2));
const { createWindowsDesktop, WindowsHelperProcess } = await import(pathToFileURL(DIST).href);

const FORM = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][Dpi]::SetProcessDPIAware()
$out = $env:AH_CHECK_OUT
$form = New-Object System.Windows.Forms.Form
$form.Text = 'AgentHost Check Window'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(200, 200)
$form.Size = New-Object System.Drawing.Size(400, 140)
$form.TopMost = $true
$box = New-Object System.Windows.Forms.TextBox
$box.Location = New-Object System.Drawing.Point(20, 20)
$box.Size = New-Object System.Drawing.Size(360, 24)
$save = New-Object System.Windows.Forms.Button
$save.Text = 'Save'
$save.Location = New-Object System.Drawing.Point(20, 70)
$save.Size = New-Object System.Drawing.Size(120, 40)
$save.Add_Click({ [System.IO.File]::WriteAllText($out, $box.Text, (New-Object System.Text.UTF8Encoding($false))); $form.Close() })
$form.Controls.Add($box)
$form.Controls.Add($save)
[void]$form.ShowDialog()
`;

const home = mkdtempSync(path.join(os.tmpdir(), "agenthost-win-desktop-"));
const helper = new WindowsHelperProcess({ agentHostDir: home });
const desktop = createWindowsDesktop(helper);
let formProcess;
console.log(`AgentHost Windows desktop check, Node ${process.version}, ${os.release()}`);

try {
  const started = Date.now();
  const capabilities = await desktop.getDesktopCapabilities();
  check("helper starts and answers (PowerShell compiled the C# class)", capabilities.guiInput.supported === true, capabilities.guiInput.reason);
  if (!capabilities.guiInput.supported) throw new Error("the helper did not start; nothing else can run");
  record("NOTE", "helper start-up", `${Date.now() - started} ms`);

  const active = await desktop.getActiveWindow();
  check("the foreground window is read", active.supported && active.activeWindow?.windowId !== undefined, active.reason);

  const listed = await desktop.listWindows({ limit: 50, includeTitles: true });
  check("windows are listed with ids and bounds", listed.supported && listed.windows.length > 0 && listed.windows.every((w) => w.windowId && w.bounds), listed.reason);

  const geometry = await desktop.getScreenGeometry();
  check("the screen geometry is read", geometry.supported && geometry.bounds?.width > 0, geometry.reason);

  const pngFile = path.join(home, "full.png");
  const full = await desktop.screenshot({ path: pngFile });
  const pngBytes = existsSync(pngFile) ? readFileSync(pngFile) : Buffer.alloc(0);
  check("a full-screen PNG screenshot is written", full.supported && pngBytes.length > 1000 && pngBytes.subarray(1, 4).toString() === "PNG", full.reason);

  const jpgFile = path.join(home, "half.jpg");
  const half = await desktop.screenshot({ path: jpgFile, format: "jpeg", quality: 70, scale: 0.5, includeActiveWindowOnly: true });
  const jpgBytes = existsSync(jpgFile) ? readFileSync(jpgFile) : Buffer.alloc(0);
  check("a half-size JPEG of the active window is written", half.supported && jpgBytes[0] === 0xff && jpgBytes[1] === 0xd8, half.reason);

  const sentinel = `sentinel-${Date.now()}`;
  await desktop.setClipboard({ text: sentinel });
  const read = await desktop.getClipboard();
  check("the clipboard round trip works", read.supported && read.text === sentinel, read.reason);

  if (args.has("--no-input")) {
    record("SKIP", "input checks", "--no-input");
  } else {
    const outFile = path.join(home, "result.txt");
    const formFile = path.join(home, "form.ps1");
    writeFileSync(formFile, FORM);
    formProcess = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", formFile], { env: { ...process.env, AH_CHECK_OUT: outFile }, stdio: "ignore", windowsHide: false });
    let form;
    for (let i = 0; i < 60 && form === undefined; i += 1) {
      await sleep(500);
      const windows = await desktop.listWindows({ limit: 100, includeTitles: true });
      form = windows.windows?.find((w) => w.title === "AgentHost Check Window");
    }
    check("the test window appears in the window list", form !== undefined, "not listed after 30 s");
    if (form !== undefined) {
      const target = { windowId: form.windowId };
      const focus = await desktop.focusWindow({ windowId: form.windowId });
      check("the test window is focused by id", focus.focused === true, focus.reason);
      const scale = form.bounds.width / 400;
      const at = (dx, dy) => ({ x: Math.round(form.bounds.x + dx * scale), y: Math.round(form.bounds.y + dy * scale) });

      const box = at(200, 32);
      const click = await desktop.click({ ...box, activeWindow: target });
      check("a click is delivered to the test window", click.clicked === true, click.reason);

      const wrong = await desktop.typeText({ text: "wrong text", activeWindow: target });
      check("text is pasted", wrong.typed === true, wrong.reason);
      const selectAll = await desktop.hotkey({ keys: ["ctrl", "a"], activeWindow: target });
      check("a hotkey (ctrl+a) is delivered", selectAll.sent === true, selectAll.reason);
      const final = "AgentHost W2 check éè ✓";
      const typed = await desktop.typeText({ text: final, activeWindow: target });
      check("unicode text replaces the selection", typed.typed === true, typed.reason);

      const save = at(80, 90);
      const press = await desktop.click({ ...save, activeWindow: target });
      check("the Save button is clicked", press.clicked === true, press.reason);
      for (let i = 0; i < 20 && !existsSync(outFile); i += 1) await sleep(250);
      const written = existsSync(outFile) ? readFileSync(outFile, "utf8") : undefined;
      check("the text box held exactly the pasted text (click, paste, select-all all landed)", written === final, `got ${JSON.stringify(written)}`);

      const restored = await desktop.getClipboard();
      check("the prior clipboard text came back after pasting", restored.text === sentinel, `got ${JSON.stringify(restored.text)}`);
    }
  }

  if (args.has("--elevated-probe")) {
    console.log("Focus an administrator window now (8 seconds)...");
    await sleep(8000);
    const front = await desktop.getActiveWindow();
    const refused = await desktop.hotkey({ keys: ["shift"], activeWindow: front.activeWindow ?? {} });
    check("input to an administrator window is refused as elevated_window", refused.sent === false && String(refused.reason).startsWith("elevated_window"), refused.reason);
  } else {
    record("NOTE", "elevated windows are not tested", "run again with --elevated-probe to check the refusal");
  }
} catch (error) {
  record("FAIL", "harness", error instanceof Error ? error.message : String(error));
} finally {
  if (formProcess !== undefined && formProcess.exitCode === null) spawn("taskkill", ["/pid", String(formProcess.pid), "/T", "/F"], { stdio: "ignore" });
  helper.close();
  await sleep(300);
  rmSync(home, { recursive: true, force: true });
}
console.log(`\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.NOTE} notes, ${counts.SKIP} skipped`);
process.exitCode = counts.FAIL === 0 ? 0 : 1;
