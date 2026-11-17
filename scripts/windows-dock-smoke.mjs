#!/usr/bin/env node
/*
 * Checks the Windows dock (W3 step 2) on a real Windows machine. No click is needed. With the dock layout the
 * overlay reserves a strip on one edge with the shell, the way the taskbar does, so maximized windows end at the
 * strip. The timeline card sits at its top and the bottom cards stack from its floor.
 *
 *   npm run build && node scripts\windows-dock-smoke.mjs
 *   set DOCK_SCREENSHOT=<file.png>   also saves a picture of the screen while the strip is up (not committed)
 *
 * It checks that:
 *   - the work area shrinks by the strip width while cards are up, and returns when the cards are dismissed
 *     (after the grace period);
 *   - the strip panel sits on the right edge, and each dock card lies inside it;
 *   - a maximized window ends at the strip's edge;
 *   - killing the overlay process gives the work area back;
 *   - emergency hide gives it back at once, and close leaves it as it was.
 * Each step prints PASS or FAIL. Exit 0 only when every check passes.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// The Win32 bindings are emitted in memory by the same module the overlay uses: no DLL is compiled or written.
import { NATIVE_PS } from "../packages/os-windows/dist/index.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_OVERLAY = path.join(REPO, "packages", "app-overlay", "dist", "index.js");
const OS_WINDOWS = path.join(REPO, "packages", "os-windows", "dist", "index.js");
const OS_LINUX = path.join(REPO, "packages", "os-linux", "dist", "index.js");
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
if (!existsSync(APP_OVERLAY) || !existsSync(OS_WINDOWS)) {
  console.log("FAIL  build first: npm run build");
  process.exit(2);
}

const { WindowsOverlayRenderer } = await import(pathToFileURL(APP_OVERLAY).href);
const { createWindowsDesktop, WindowsHelperProcess } = await import(pathToFileURL(OS_WINDOWS).href);
const { BrowserSession } = await import(pathToFileURL(OS_LINUX).href);

const DOCK = { layout: "dock", dockSide: "right", dockWidthPercent: 18, dockReserveSpace: true };
const CARD_TITLE = "AgentHost overlay";
const STRIP_TITLE = "AgentHost dock";
const FORM_TITLE = "AgentHost dock check window";
const TIMELINE = "agenthost-timeline-w3-dock";
const homes = [mkdtempSync(path.join(os.tmpdir(), "agenthost-win-dock-helper-"))];
const renderers = [];
const helper = new WindowsHelperProcess({ agentHostDir: homes[0] });
const desktop = createWindowsDesktop(helper);

/**
 * Primary display and its work area in device pixels, the same units as the window bounds from the helper. The
 * query is per-monitor DPI-aware (a plain PowerShell process would see virtualized sizes). `scale` is device pixels
 * per WPF unit, which is what the strip is sized in.
 */
function displayRects() {
  const script = NATIVE_PS + "\r\n[void][AhNative.Native]::SetProcessDPIAware(); Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $s =[System.Windows.Forms.Screen]::PrimaryScreen; $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $dpi = $g.DpiX; $g.Dispose(); '{0},{1},{2},{3},{4},{5},{6},{7},{8}' -f $s.Bounds.X, $s.Bounds.Y, $s.Bounds.Width, $s.Bounds.Height, $s.WorkingArea.X, $s.WorkingArea.Y, $s.WorkingArea.Width, $s.WorkingArea.Height, $dpi";
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  const n = String(out.stdout).trim().split(",").map(Number);
  if (n.length !== 9 || n.some((value) => !Number.isFinite(value))) throw new Error(`display_query_failed: ${String(out.stderr).slice(0, 200)}`);
  return { screen: { x: n[0], y: n[1], width: n[2], height: n[3] }, work: { x: n[4], y: n[5], width: n[6], height: n[7] }, scale: n[8] / 96 };
}

const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const rectText = (r) => `${r.x},${r.y},${r.width}x${r.height}`;

async function titled(title) {
  const listed = await desktop.listWindows({ limit: 200, includeTitles: true });
  return listed.windows.filter((window) => window.title === title);
}

/** Window ids already on screen under the AgentHost titles, so only this run's windows are counted. */
async function knownIds() {
  const ids = new Set();
  for (const title of [CARD_TITLE, STRIP_TITLE]) for (const window of await titled(title)) ids.add(window.windowId);
  return ids;
}

async function startRenderer(sessionId) {
  const home = mkdtempSync(path.join(os.tmpdir(), "agenthost-win-dock-"));
  homes.push(home);
  const renderer = new WindowsOverlayRenderer({ agentHostDir: home, sessionId, visual: DOCK, startupTimeoutMs: 45_000 });
  renderers.push(renderer);
  await renderer.warmup();
  let report = await renderer.capabilities();
  const deadline = Date.now() + 60_000;
  while (report.reason === "overlay_starting" && Date.now() < deadline) report = await renderer.capabilities();
  return { renderer, report };
}

const timeline = (overlayId) => ({
  overlayId,
  type: "widget",
  payload: {
    title: "Computer activity",
    placement: "top_right",
    sensitivity: "public",
    components: [{ type: "timeline", entries: [{ state: "done", label: "Opened the page" }, { state: "running", label: "Reading the results" }] }],
    interaction: { interactive: false, focus: "never", dismissible: true, allowedEvents: ["dismissed"] }
  }
});

const task = (overlayId, title) => ({
  overlayId,
  type: "widget",
  payload: {
    title,
    placement: "bottom_right",
    sensitivity: "public",
    components: [
      { type: "status_badge", status: "running", text: "Running" },
      { type: "key_value", key: "Risk", value: "low" },
      { type: "button", label: "Pause", event: "pause" },
      { type: "button", label: "Stop", event: "emergency_stop_requested" }
    ],
    interaction: { interactive: true, focus: "never", dismissible: true, allowedEvents: ["pause", "emergency_stop_requested", "dismissed"] }
  }
});

/** Maximizes a window by its handle (SW_MAXIMIZE = 3): the shell then fits it to the work area, which the strip reserves. */
function maximizeWindow(windowId) {
  const script = `${NATIVE_PS}\r\n[void][AhNative.Native]::ShowWindow([IntPtr][long]${windowId}, 3)`;
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}

/** Kills the overlay process this check started (a child of this process). Returns how many were stopped. */
function killOverlayChild() {
  // $PID excludes this query's own PowerShell, whose command line also contains the script name.
  const script = `$p = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*windows-overlay.ps1*' }); foreach ($x in $p) { Stop-Process -Id $x.ProcessId -Force }; 'stopped=' + $p.Count`;
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  const match = /stopped=(\d+)/.exec(String(out.stdout));
  return match === null ? -1 : Number(match[1]);
}

function saveScreenshot(file) {
  // Device pixels, so the picture covers the whole display and not only its top-left corner.
  const script = NATIVE_PS + "\r\n[void][AhNative.Native]::SetProcessDPIAware(); Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $s =[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $b = New-Object System.Drawing.Bitmap $s.Width, $s.Height; $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.X, $s.Y, 0, 0, $b.Size); $b.Save($env:DOCK_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()";
  const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, env: { ...process.env, DOCK_SHOT_PATH: file } });
  return out.status === 0 && existsSync(file);
}

const before = displayRects();
// The strip is sized in WPF units (240 minimum, a share of the display) and placed in device pixels.
const screenUnits = before.screen.width / before.scale;
const stripUnits = Math.min(screenUnits, Math.max(240, Math.round((screenUnits * DOCK.dockWidthPercent) / 100)));
const stripWidth = Math.round(stripUnits * before.scale);
const stripLeft = before.screen.width - stripWidth;
record("NOTE", "display", `screen ${rectText(before.screen)}, work area ${rectText(before.work)}, scale ${before.scale}, strip ${stripWidth} px wide`);

try {
  // ---- A: three cards, the strip, a maximized window, dismiss --------------------------------------------------
  const a = await startRenderer("w3-dock-a");
  check("the overlay process starts and installs the mouse guard", a.report.supported === true, a.report.reason);
  if (a.report.supported === true) {
    const known = await knownIds();
    const shown = [TIMELINE, `${TIMELINE}-task-1`, `${TIMELINE}-task-2`];
    const results = [await a.renderer.show(timeline(shown[0])), await a.renderer.show(task(shown[1], "Task one")), await a.renderer.show(task(shown[2], "Task two"))];
    check("the three dock cards are shown", results.every((result) => result.ok === true), results.map((result) => result.reason).join(", "));
    await sleep(1500);

    const reserved = displayRects();
    check("the work area shrinks by the strip width while the cards are up", reserved.work.width === before.work.width - stripWidth && reserved.work.x === before.work.x && reserved.work.height === before.work.height, `work area ${rectText(reserved.work)} (was ${rectText(before.work)})`);

    const panels = await titled(STRIP_TITLE);
    const panel = panels[0]?.bounds;
    check("the strip panel sits on the right edge at the strip width", panels.length === 1 && panel !== undefined && panel.x === stripLeft && panel.width === stripWidth && panel.y === before.work.y && panel.height === before.work.height, panels.length === 1 ? `panel ${rectText(panel)}` : `${panels.length} panel windows`);

    const cards = (await titled(CARD_TITLE)).filter((window) => !known.has(window.windowId));
    const inside = cards.filter((card) => card.bounds !== undefined && card.bounds.x >= stripLeft - 1 && card.bounds.x + card.bounds.width <= before.screen.width + 1 && card.bounds.y >= before.work.y - 1 && card.bounds.y + card.bounds.height <= before.work.y + before.work.height + 1);
    check("each of the three dock cards lies inside the strip", cards.length === 3 && inside.length === 3, `${cards.length} card windows, ${inside.length} inside (${cards.map((card) => rectText(card.bounds ?? { x: 0, y: 0, width: 0, height: 0 })).join(" ; ")})`);

    if (process.env.DOCK_SCREENSHOT !== undefined && process.env.DOCK_SCREENSHOT !== "") {
      record(saveScreenshot(process.env.DOCK_SCREENSHOT) ? "NOTE" : "FAIL", "screenshot of the strip", process.env.DOCK_SCREENSHOT);
    }

    // A maximized window must end where the strip begins.
    const form = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = '${FORM_TITLE}'; $f.WindowState = 'Maximized'; [System.Windows.Forms.Application]::Run($f)`], { stdio: "ignore", windowsHide: true });
    let formBounds;
    const deadline = Date.now() + 20_000;
    while (formBounds === undefined && Date.now() < deadline) {
      await sleep(500);
      formBounds = (await titled(FORM_TITLE))[0]?.bounds;
    }
    form.kill();
    check("a maximized window ends at the strip's edge", formBounds !== undefined && Math.abs(formBounds.x + formBounds.width - stripLeft) <= 2 && Math.abs(formBounds.y - before.work.y) <= 2, formBounds === undefined ? "the test window did not appear" : `window ${rectText(formBounds)}, strip starts at ${stripLeft}`);

    // The agent's own Chrome, maximized, must end at the strip too (the handoff's acceptance for task 2).
    const page = http.createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<title>Dock check page</title><h1>Dock check page</h1>");
    });
    await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
    const chrome = new BrowserSession({ agentHostDir: homes[0] });
    try {
      const opened = await chrome.open({ url: `http://127.0.0.1:${page.address().port}/`, headless: false });
      check("the agent's Chrome opens for the dock check", opened.opened === true, opened.reason ?? "");
      let chromeWindow;
      const chromeDeadline = Date.now() + 20_000;
      while (chromeWindow === undefined && Date.now() < chromeDeadline) {
        await sleep(300);
        chromeWindow = (await titled("Dock check page - Google Chrome"))[0];
      }
      if (chromeWindow !== undefined) maximizeWindow(chromeWindow.windowId);
      await sleep(1_200);
      const maximized = (await titled("Dock check page - Google Chrome"))[0]?.bounds;
      check("the agent's Chrome, maximized, ends at the strip's edge", maximized !== undefined && Math.abs(maximized.x + maximized.width - stripLeft) <= 2 && Math.abs(maximized.y - before.work.y) <= 2, maximized === undefined ? "the Chrome window was not found" : `window ${rectText(maximized)}, strip starts at ${stripLeft}`);
    } finally {
      await chrome.close().catch(() => undefined);
      page.close();
    }

    for (const overlayId of shown) await a.renderer.dismiss(overlayId);
    await sleep(3_500);
    const released = displayRects();
    check("dismissing the cards gives the work area back after the grace period", sameRect(released.work, before.work), `work area ${rectText(released.work)} (was ${rectText(before.work)})`);
    check("no strip panel is left after dismiss", (await titled(STRIP_TITLE)).length === 0);
  }
  await a.renderer.close();

  // ---- B: killing the overlay process releases the strip -------------------------------------------------------
  const b = await startRenderer("w3-dock-b");
  if (b.report.supported === true) {
    await b.renderer.show(timeline(`${TIMELINE}-kill`));
    await sleep(1000);
    const held = displayRects();
    check("the strip is reserved again for the kill test", held.work.width === before.work.width - stripWidth, `work area ${rectText(held.work)}`);
    const stopped = killOverlayChild();
    check("the overlay process of this check was found and killed", stopped === 1, `stopped ${stopped} process(es)`);
    await sleep(2_000);
    const after = displayRects();
    check("killing the overlay process gives the work area back", sameRect(after.work, before.work), `work area ${rectText(after.work)} (was ${rectText(before.work)})`);
  } else {
    record("FAIL", "overlay process for the kill test", b.report.reason);
  }
  await b.renderer.close();

  // ---- C: emergency hide releases at once; close leaves the work area as it was --------------------------------
  const c = await startRenderer("w3-dock-c");
  if (c.report.supported === true) {
    // Screenshot suppression clears the cards and shows them again: the reservation must survive that.
    await c.renderer.show(timeline(`${TIMELINE}-cleared`));
    await sleep(600);
    await c.renderer.clear();
    await sleep(300);
    check("a clear keeps the reservation through the grace period (screenshot suppression)", displayRects().work.width === before.work.width - stripWidth, "the work area was released by the clear");
    await c.renderer.show(timeline(`${TIMELINE}-cleared`));
    await sleep(600);
    await c.renderer.show(timeline(`${TIMELINE}-emergency`));
    await c.renderer.show(task(`${TIMELINE}-emergency-task`, "Emergency task"));
    await sleep(800);
    await c.renderer.emergencyHide();
    await sleep(400);
    const hidden = displayRects();
    check("emergency hide gives the work area back at once", sameRect(hidden.work, before.work), `work area ${rectText(hidden.work)} (was ${rectText(before.work)})`);

    await c.renderer.show(timeline(`${TIMELINE}-close`));
    await sleep(800);
    check("the strip comes back after emergency hide when a card is shown again", displayRects().work.width === before.work.width - stripWidth, "no reservation");
  } else {
    record("FAIL", "overlay process for the emergency test", c.report.reason);
  }
  await c.renderer.close();
  await sleep(700);
  check("close leaves the work area as it was", sameRect(displayRects().work, before.work), `work area ${rectText(displayRects().work)} (was ${rectText(before.work)})`);
} catch (error) {
  record("FAIL", "harness", error instanceof Error ? error.message : String(error));
} finally {
  for (const renderer of renderers) await renderer.close().catch(() => undefined);
  helper.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
}
console.log(`\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.NOTE} notes, ${counts.SKIP} skipped`);
process.exitCode = counts.FAIL === 0 ? 0 : 1;
