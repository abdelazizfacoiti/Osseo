#!/usr/bin/env node
/*
 * Checks the Windows overlay (W3) on a real Windows machine. It starts the WPF overlay process, shows a test
 * card with Pause and Stop buttons, and checks that:
 *   - the process starts and installs the mouse guard;
 *   - the card is in the window list and its Stop button is in the UI Automation tree;
 *   - a synthetic click on Stop (SendInput, the way the agent clicks) is refused: no event comes back;
 *   - a real click on Stop by you is accepted: emergency_stop_requested arrives within 30 s;
 *   - the card dismisses, and the clear and close calls leave no card behind.
 *
 *   npm run build && node scripts\windows-overlay-smoke.mjs
 *
 * One step needs you: when it prints "CLICK STOP", click the Stop button with the mouse, not the keyboard.
 * Nothing else is clicked except the synthetic click it is testing, and that one should be refused.
 * Set OSSEO_WINDOWS_OVERLAY=1 only in the real server; this script starts the renderer itself.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_OVERLAY = path.join(REPO, "packages", "app-overlay", "dist", "index.js");
const OS_WINDOWS = path.join(REPO, "packages", "os-windows", "dist", "index.js");
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

const home = mkdtempSync(path.join(os.tmpdir(), "osseo-win-overlay-"));
const renderer = new WindowsOverlayRenderer({ osseoDir: home, sessionId: "w3-check" });
const helper = new WindowsHelperProcess({ osseoDir: home });
const desktop = createWindowsDesktop(helper);
const CARD = "w3-check-card";
const CARD_TITLE = "Osseo overlay";
const card = {
  overlayId: CARD,
  type: "widget",
  payload: {
    title: "Osseo W3 check",
    components: [
      { type: "text", text: "Click Stop with the mouse. A synthetic click must do nothing." },
      { type: "button", label: "Pause", event: "pause" },
      { type: "button", label: "Stop", event: "emergency_stop_requested" }
    ],
    placement: "top_right",
    sensitivity: "public",
    interaction: { interactive: true, focus: "never", dismissible: true, allowedEvents: ["pause", "emergency_stop_requested", "dismissed"] }
  }
};

// Another Osseo process (the MCP server of a running session) draws cards with the same title. Only a window
// that appeared after this run's snapshot is this run's card.
let titledBefore = null;
async function cardWindow() {
  const listed = await desktop.listWindows({ limit: 200, includeTitles: true });
  return listed.windows.find((window) => window.title === CARD_TITLE && (titledBefore === null || !titledBefore.has(window.windowId)));
}

/** One line per node: depth, role, name, bounds. Printed when UI Automation does not find the Stop button. */
function treeLines(node, depth = 0, out = []) {
  if (node === undefined || node === null || out.length >= 80) return out;
  const b = node.bounds;
  out.push(`${"  ".repeat(depth)}${node.role ?? "?"} ${JSON.stringify(node.name ?? "")}${node.enabled === false ? " [disabled]" : ""}${b === undefined ? "" : ` @${b.x},${b.y} ${b.width}x${b.height}`}`);
  for (const child of node.children ?? []) treeLines(child, depth + 1, out);
  return out;
}

try {
  const started = Date.now();
  titledBefore = new Set((await desktop.listWindows({ limit: 200, includeTitles: true })).windows.filter((window) => window.title === CARD_TITLE).map((window) => window.windowId));
  if (titledBefore.size > 0) record("NOTE", "Osseo cards from another process are ignored by this check", `${titledBefore.size} window(s)`);
  // warmup() starts the process in the background and returns at once, so wait here until the start settles.
  await renderer.warmup();
  let report = await renderer.capabilities();
  const deadline = Date.now() + 45_000;
  while (report.reason === "overlay_starting" && Date.now() < deadline) report = await renderer.capabilities();
  const diagnostics = await renderer.diagnostics();
  check("the overlay process starts and installs the mouse guard", report.supported === true, `${report.reason}; ${JSON.stringify(diagnostics.lastStderrSummary ?? "")}`);
  if (report.supported !== true) throw new Error("the overlay did not start; nothing else can run");
  record("NOTE", "overlay start-up", `${Date.now() - started} ms`);

  const shown = await renderer.show(card);
  check("the test card is shown", shown.ok === true && (shown.visibleWindowCount ?? 0) >= 1, shown.reason);

  const window = await cardWindow();
  check("the card window is in the window list", window !== undefined, "no window titled Osseo overlay");
  if (window !== undefined) {
    const stop = await desktop.findAccessibilityElement({ windowId: window.windowId, query: "Stop", role: "push button" });
    const stopHit = stop.candidates?.find((candidate) => candidate.name === "Stop" && candidate.bounds !== undefined);
    check("UI Automation finds the Stop button with bounds", stopHit !== undefined, JSON.stringify(stop));
    if (stopHit === undefined) {
      // Say what UI Automation does see, so the next run explains itself.
      record("NOTE", "card window", JSON.stringify({ windowId: window.windowId, pid: window.pid, title: window.title, bounds: window.bounds }));
      for (const [label, target] of [["by window id", { windowId: window.windowId }], ["by process id", window.pid === undefined ? undefined : { pid: window.pid }]]) {
        if (target === undefined) continue;
        try {
          const tree = await desktop.getAccessibilityTree({ ...target, maxDepth: 14, maxNodes: 120 });
          record("NOTE", `UI Automation tree ${label}`, `supported=${tree.supported} ${tree.reason ?? ""}`);
          for (const line of treeLines(tree.root)) console.log(`        ${line}`);
        } catch (error) {
          record("NOTE", `UI Automation tree ${label}`, error instanceof Error ? error.message : String(error));
        }
      }
      record("NOTE", "synthetic click check", "skipped: the Stop button could not be located, so the agent's click was not tried");
    } else {
      const x = Math.round(stopHit.bounds.x + stopHit.bounds.width / 2);
      const y = Math.round(stopHit.bounds.y + stopHit.bounds.height / 2);
      // The agent's own click, sent straight to the helper (no focus change): the guard must refuse it.
      await helper.request("input.click", { x, y, button: "left" });
      await sleep(800);
      const synthetic = await renderer.drainEvents();
      check("a synthetic click on Stop is refused: no event comes back", !synthetic.some((event) => event.event === "emergency_stop_requested"), JSON.stringify(synthetic));
    }

    // The real click does not need UI Automation: you click the card yourself.
    console.log("");
    console.log("CLICK STOP: click the red-bordered card's Stop button with the mouse now (30 s). Do not use the keyboard.");
    const deadline = Date.now() + 30_000;
    let received = [];
    while (Date.now() < deadline && !received.some((event) => event.event === "emergency_stop_requested")) {
      await sleep(500);
      received = received.concat(await renderer.drainEvents());
    }
    check("a real click on Stop is accepted: emergency_stop_requested arrives", received.some((event) => event.event === "emergency_stop_requested"), received.length === 0 ? "no event within 30 s" : JSON.stringify(received));
    record("NOTE", "events after the real click", JSON.stringify(received.map((event) => event.event)));
  }

  const state = await renderer.state();
  check("state lists the card as visible", state.overlays.some((overlay) => overlay.overlayId === CARD && overlay.visible === true), JSON.stringify(state.overlays));

  const dismissed = await renderer.dismiss(CARD);
  check("dismiss acknowledges the card", dismissed.ok === true, dismissed.reason);
  await sleep(400);
  check("the card window is gone after dismiss", (await cardWindow()) === undefined, "the window is still listed");
} catch (error) {
  record("FAIL", "harness", error instanceof Error ? error.message : String(error));
} finally {
  await renderer.close();
  await sleep(300);
  check("close leaves no card window behind", (await cardWindow().catch(() => undefined)) === undefined, "a card window is still listed");
  helper.close();
  rmSync(home, { recursive: true, force: true });
}
console.log(`\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.NOTE} notes, ${counts.SKIP} skipped`);
process.exitCode = counts.FAIL === 0 ? 0 : 1;
