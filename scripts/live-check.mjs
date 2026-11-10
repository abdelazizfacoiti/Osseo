#!/usr/bin/env node
/*
 * Live check of this AgentHost build, end to end.
 *
 *   npm run build && npm run check:live
 *
 * It runs in a throwaway AGENTHOST_HOME, so your ~/.agenthost is never touched.
 *   1. CLI: --help is read-only, the stop flag is respected, bare `agent resume` works.
 *   2. Desktop: a nested X display (Xephyr) opens as a small window on your screen for
 *      about a minute, with a GTK probe app. The MCP server drives it over stdio:
 *      verified clicks, typed text with punctuation and accents, hotkey repeat,
 *      inline screenshots, and the loop guard with its pause.
 *   3. Browser: headless Chrome, no window. fill, select, upload (confirmed through the
 *      CLI), a confirmed consequential click, wait_for, and an inline page screenshot.
 *   4. Session end: a second nested display (a small window for a few seconds) shows a
 *      task card. Closing the client's stdin must end the server and its card renderer;
 *      a killed server must take its renderer down too.
 *
 * Needs: Xephyr, python3 with GTK 3 (PyGObject), Chrome or Chromium, and a host DISPLAY.
 * Set LIVE_CHECK_LAYOUT=fr to run the desktop checks on a French (AZERTY) keyboard layout.
 * It prints PASS or FAIL for each check and exits non-zero if anything failed.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(REPO, "packages/agenthost-cli/dist/index.js");
const SERVER = path.join(REPO, "packages/mcp-server/dist/index.js");
const HOST_DISPLAY = process.env.DISPLAY ?? ":0";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function hasCommand(name) {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A display is busy when its X server is alive. A lock or socket left by a killed server is stale.
function displayBusy(number) {
  const lock = `/tmp/.X${number}-lock`;
  if (!existsSync(lock)) return existsSync(`/tmp/.X11-unix/X${number}`);
  try {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function freeDisplay() {
  for (let number = 131; number < 160; number += 1) {
    if (!displayBusy(number)) return `:${number}`;
  }
  throw new Error("no free display number between :131 and :159");
}

function runCli(env, args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 20_000 }) };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function cli(env, args) {
  const result = runCli(env, [...args, "--json"]);
  try {
    return JSON.parse(result.out);
  } catch {
    return { ok: false, out: result.out };
  }
}

const PROBE = `
import gi, sys
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
out = sys.argv[1]
win = Gtk.Window(title="Live probe")
win.set_default_size(360, 240)
win.move(0, 0)
fixed = Gtk.Fixed()
label = Gtk.Label(label="idle")
label.set_size_request(320, 20)
fixed.put(label, 20, 8)
change = Gtk.Button(label="Change label")
change.set_size_request(200, 40)
change.connect("clicked", lambda b: label.set_text("changed"))
fixed.put(change, 20, 40)
nothing = Gtk.Button(label="Does nothing")
nothing.set_size_request(200, 40)
fixed.put(nothing, 20, 100)
reset = Gtk.Button(label="Reset label")
reset.set_size_request(110, 40)
reset.connect("clicked", lambda b: label.set_text("idle"))
fixed.put(reset, 230, 40)
locked = Gtk.Button(label="Locked")
locked.set_size_request(200, 30)
locked.set_sensitive(False)
fixed.put(locked, 20, 200)
secret = Gtk.Entry()
secret.set_visibility(False)
secret.set_size_request(110, 30)
fixed.put(secret, 230, 200)
entry = Gtk.Entry()
entry.set_size_request(320, 30)
entry.connect("changed", lambda e: open(out, "w", encoding="utf-8").write(e.get_text()))
fixed.put(entry, 20, 160)
win.add(fixed)
win.show_all()
win.connect("destroy", Gtk.main_quit)
Gtk.main()
`;

// A VTE terminal named like GNOME Terminal (Ctrl+Shift+V pastes, plain Ctrl+V sends a control character).
const VTE_PROBE = `
import ctypes, gi, sys
ctypes.CDLL(None).prctl(15, b"gnome-terminal-", 0, 0, 0)
gi.require_version("Gtk", "3.0")
gi.require_version("Vte", "2.91")
from gi.repository import Gtk, Gdk, Vte, GLib
out = sys.argv[1]
win = Gtk.Window(title="VTE probe")
win.set_default_size(380, 200)
win.move(400, 0)
term = Vte.Terminal()
win.add(term)
def on_key(_window, event):
    mask = event.state & Gtk.accelerator_get_default_mod_mask()
    if event.keyval in (Gdk.KEY_V, Gdk.KEY_v) and mask & Gdk.ModifierType.CONTROL_MASK and mask & Gdk.ModifierType.SHIFT_MASK:
        term.paste_clipboard()
        return True
    return False
win.connect("key-press-event", on_key)
win.show_all()
term.spawn_sync(Vte.PtyFlags.DEFAULT, None, ["/bin/sh", "-c", "cat > " + out], None, GLib.SpawnFlags.DEFAULT, None, None, None)
win.connect("destroy", Gtk.main_quit)
Gtk.main()
`;

const FORM = `<!doctype html><meta charset="utf-8"><title>Live form</title>
<label>Name <input id="name" placeholder="Name"></label>
<label>Country <select id="country"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<label>Attach <input type="file" id="cv" onchange="document.getElementById('msg').textContent='files:' + this.files.length"></label>
<label>Password <input type="password" id="pw" placeholder="Password"></label>
<button type="button" id="save" onclick="document.getElementById('msg').textContent='saved:' + document.getElementById('name').value">Save profile</button>
<button type="button" id="send" onclick="document.getElementById('msg').textContent='sent'">Send</button>
<p id="msg">ready</p>
<p id="frame-note">loading frame</p>
<iframe id="frame" title="Frame"></iframe>
<script>
const frame = document.getElementById("frame");
frame.addEventListener("load", () => {
  const doc = frame.contentDocument;
  doc.body.innerHTML = "<label>Frame field <input aria-label='Frame field'></label><button type='button' disabled>Frame disabled</button><button type='button' id='fb'>Frame button</button>";
  doc.getElementById("fb").addEventListener("click", () => { document.getElementById("msg").textContent = "frame clicked"; });
  document.getElementById("frame-note").textContent = "frame ready";
});
frame.srcdoc = "<!doctype html><title>frame</title>";
</script>`;

function hasVte() {
  try {
    execFileSync("python3", ["-c", "import gi; gi.require_version('Vte', '2.91'); from gi.repository import Vte"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function terminalChecks(mcp, work, display) {
  const file = path.join(work, "terminal.txt");
  writeFileSync(file, "");
  const script = path.join(work, "vte_probe.py");
  writeFileSync(script, VTE_PROBE);
  const probe = spawn("python3", ["-W", "ignore", script, file], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" });
  await sleep(2500);
  const listed = await mcp.call("window.list", { includeTitles: true });
  const win = listed.body?.data?.windows?.find((item) => item.title === "VTE probe");
  check("AgentHost lists the terminal window", Boolean(win));
  if (win) {
    const origin = win.bounds ?? { x: 0, y: 0 };
    const activeWindow = { windowId: win.windowId };
    await mcp.call("window.focus", { windowId: win.windowId });
    await mcp.call("desktop.click", { x: origin.x + 190, y: origin.y + 120, activeWindow });
    const typed = await mcp.call("desktop.type_text", { text: "Hello W-Z", activeWindow });
    check("typing into a terminal works (paste with Ctrl+Shift+V)", typed.ok, typed.error ?? "");
    await mcp.call("desktop.hotkey", { keys: ["ctrl", "d"], activeWindow });
    await sleep(800);
    const got = readFileSync(file, "utf8");
    check("the terminal receives exactly what was typed", got === "Hello W-Z", got === "Hello W-Z" ? "" : `got ${JSON.stringify(got)}`);
  }
  probe.kill();
}

function cliChecks(env) {
  const stopFile = path.join(env.AGENTHOST_HOME, "run", "stop.requested");
  mkdirSync(path.dirname(stopFile), { recursive: true });
  writeFileSync(stopFile, JSON.stringify({ requested: true, reason: "live-check" }));
  const before = readFileSync(stopFile, "utf8");
  for (const args of [["agent", "resume", "--help"], ["overlay", "check-input", "--help"], ["doctor", "--help"], ["workflow", "run", "--help"]]) {
    const started = Date.now();
    const result = runCli(env, args);
    check(`agenthost ${args.join(" ")} prints usage and runs nothing`, result.code === 0 && result.out.startsWith("usage: agenthost") && Date.now() - started < 10_000, result.out.split("\n")[0].slice(0, 80));
  }
  check("help left the stop flag untouched", readFileSync(stopFile, "utf8") === before);
  const cleared = cli(env, ["agent", "resume", "--stop"]);
  check("the operator clears the stop flag with --stop", cleared.ok === true && cleared.data?.cleared?.stop === true);
  const idle = cli(env, ["agent", "resume"]);
  check("bare resume with nothing active says so", idle.data?.note === "Nothing to resume: no pause, stop, or takeover is active.", idle.data?.note ?? idle.out);
}

function mcpClient(server) {
  const replies = new Map();
  let buffer = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) replies.set(message.id, message);
      } catch {
        /* Not a protocol message. */
      }
    }
  });
  server.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const wait = async (id, ms = 120_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (replies.has(id)) return replies.get(id);
      await sleep(50);
    }
    throw new Error(`no reply to request ${id}. Server stderr tail: ${stderr.slice(-600)}`);
  };
  let next = 100;
  return {
    async initialize() {
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "live-check", version: "1" } } })}\n`);
      await wait(1, 60_000);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(name, args = {}) {
      const id = next;
      next += 1;
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      const reply = await wait(id);
      const text = reply.result?.content?.find((item) => item.type === "text")?.text;
      let body;
      try {
        body = text === undefined ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      return {
        ok: body?.ok === true,
        body,
        error: body?.error?.code ?? (reply.error ? "rpc_error" : undefined),
        images: (reply.result?.content ?? []).filter((item) => item.type === "image")
      };
    }
  };
}

async function desktopChecks(mcp, entryFile, display) {
  const listed = await mcp.call("window.list", { includeTitles: true });
  const win = listed.body?.data?.windows?.find((item) => item.title === "Live probe");
  check("AgentHost lists the probe window", Boolean(win), win ? `bounds ${JSON.stringify(win.bounds)}` : JSON.stringify(listed.body?.error ?? "not listed"));
  if (!win) return undefined;
  const origin = win.bounds ?? { x: 0, y: 0 };
  await mcp.call("window.focus", { windowId: win.windowId });
  const activeWindow = { windowId: win.windowId };
  const clickAt = (x, y) => mcp.call("desktop.click", { x: origin.x + x, y: origin.y + y, activeWindow });

  const nothing = await clickAt(120, 120);
  check("a click on a control that does nothing reports no change", nothing.ok && nothing.body?.data?.effect?.screenChanged === false, JSON.stringify(nothing.body?.data?.effect ?? nothing.error ?? null));
  const changed = await clickAt(120, 60);
  check("a click that changes the window reports the change", changed.ok && changed.body?.data?.effect?.screenChanged === true, JSON.stringify(changed.body?.data?.effect ?? changed.error ?? null));
  const byLabelNothing = await mcp.call("desktop.click", { label: "Does nothing", activeWindow });
  check("a click by label on a control that does nothing reports no change", byLabelNothing.ok && byLabelNothing.body?.data?.effect?.screenChanged === false && byLabelNothing.body?.data?.resolved?.source === "accessibility", JSON.stringify(byLabelNothing.body?.data?.resolved ?? byLabelNothing.error ?? null));

  await clickAt(180, 175);
  const text = 'Plan: W-Z "quotes" & #tag 12/34 é€';
  const typed = await mcp.call("desktop.type_text", { text, activeWindow });
  await sleep(400);
  const entry = readFileSync(entryFile, "utf8");
  check("typed text arrives exactly (punctuation, accents, euro sign)", entry === text, entry === text ? "" : `got ${JSON.stringify(entry)}`);
  check("type_text reports that the window changed", typed.ok && typed.body?.data?.effect?.screenChanged === true, JSON.stringify(typed.body?.data?.effect ?? typed.error ?? null));

  const back = await mcp.call("desktop.hotkey", { keys: ["BackSpace"], repeat: 5, activeWindow });
  await sleep(400);
  const expected = Array.from(text).slice(0, -5).join("");
  const afterBack = readFileSync(entryFile, "utf8");
  check("hotkey repeat 5 removes exactly five characters", back.ok && afterBack === expected, afterBack === expected ? "" : `got ${JSON.stringify(afterBack)}`);

  const shot = await mcp.call("desktop.screenshot", { includeActiveWindowOnly: true });
  const image = shot.images[0];
  check("a desktop screenshot comes back as an inline JPEG", image?.mimeType === "image/jpeg" && image.data.startsWith("/9j/"), image ? `${Math.round((image.data.length * 3) / 4 / 1024)} KB` : "no image part");

  const byLabelReset = await mcp.call("desktop.click", { label: "Reset label", activeWindow });
  check("a click by label that changes the window reports the change", byLabelReset.ok && byLabelReset.body?.data?.effect?.screenChanged === true, JSON.stringify(byLabelReset.body?.data?.effect ?? byLabelReset.error ?? null));
  const locked = await mcp.call("desktop.click", { label: "Locked", activeWindow });
  check("a disabled control is refused by name and nothing is clicked", locked.error === "control_disabled", locked.error ?? "clicked");
  const near = await mcp.call("desktop.click", { label: "Does not", activeWindow });
  check("a near-miss name is refused and the real name is suggested", near.error === "label_not_found" && JSON.stringify(near.body?.error?.details ?? {}).includes("Does nothing"), near.error ?? "");
  const mixed = await mcp.call("desktop.click", { x: 1, y: 1, label: "Reset label", activeWindow });
  check("x/y together with a label is refused before any action", mixed.ok === false && mixed.error !== undefined, mixed.error ?? "accepted");

  const pictured = await mcp.call("desktop.screenshot", { includeActiveWindowOnly: true });
  const shotId = pictured.body?.data?.screenshotMetadata?.screenshotId;
  check("a screenshot names itself with an id", typeof shotId === "string" && shotId.startsWith("shot_"), String(shotId));
  const byShot = await mcp.call("desktop.click", { screenshotId: shotId, imageX: 60, imageY: 60, activeWindow });
  await sleep(300);
  check("a click at a point in the picture lands on the control there", byShot.ok && byShot.body?.data?.effect?.screenChanged === true, JSON.stringify(byShot.body?.data?.effect ?? byShot.error ?? null));
  const outside = await mcp.call("desktop.click", { screenshotId: shotId, imageX: 900, imageY: 60, activeWindow });
  check("a point outside the picture is refused", outside.error === "image_point_outside", outside.error ?? "accepted");
  const unknownShot = await mcp.call("desktop.click", { screenshotId: "shot_000000000000", imageX: 10, imageY: 10, activeWindow });
  check("an unknown screenshot id is refused", unknownShot.error === "screenshot_unknown", unknownShot.error ?? "accepted");
  // Move every X window with that title (the reference may be either of two ids for one probe).
  const probeXids = () => execFileSync("xdotool", ["search", "--name", "^Live probe$"], { env: { ...process.env, DISPLAY: display }, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const xid of probeXids()) execFileSync("xdotool", ["windowmove", xid, "40", "40"], { env: { ...process.env, DISPLAY: display } });
  await sleep(400);
  const stale = await mcp.call("desktop.click", { screenshotId: shotId, imageX: 60, imageY: 60, activeWindow });
  check("a click on a picture whose window has moved is refused as stale", stale.error === "screenshot_stale", stale.error ?? "accepted");
  for (const xid of probeXids()) execFileSync("xdotool", ["windowmove", xid, "0", "0"], { env: { ...process.env, DISPLAY: display } });
  await sleep(400);

  const withPicture = await mcp.call("desktop.click", { x: 120, y: 60, activeWindow, returnScreenshot: "region" });
  const pictureId = withPicture.body?.data?.inline?.screenshotId;
  check("a click can return the picture after it inline, with an id", withPicture.ok && withPicture.images.length === 1 && typeof pictureId === "string", withPicture.error ?? `${withPicture.images.length} image(s)`);
  const fromPicture = await mcp.call("desktop.click", { screenshotId: pictureId, imageX: 285, imageY: 60, activeWindow });
  await sleep(300);
  check("the id from that picture clicks the control shown in it", fromPicture.ok && fromPicture.body?.data?.effect?.screenChanged === true, fromPicture.error ?? JSON.stringify(fromPicture.body?.data?.effect ?? null));
  const keyed = await mcp.call("desktop.hotkey", { keys: ["Escape"], activeWindow, returnScreenshot: "window" });
  check("a hotkey can return the active window inline", keyed.ok && keyed.images.length === 1, keyed.error ?? `${keyed.images.length} image(s)`);
  const read = await mcp.call("screen.read", {});
  const outline = read.body?.data?.outline ?? "";
  check("screen.read names the controls, their state and bounds", read.ok && outline.includes('push button "Change label"') && outline.includes('push button "Locked" [disabled]') && /@\d+,\d+ \d+x\d+/.test(outline), outline.slice(0, 160));
  check("screen.read stays within its byte cap", read.ok && (read.body?.data?.bytes ?? Infinity) <= 2048, String(read.body?.data?.bytes));

  const failingPlan = await mcp.call("computer.run_steps", {
    steps: [
      { tool: "desktop.click", input: { label: "Change label", activeWindow }, expect: { screenChanged: true } },
      { tool: "desktop.click", input: { label: "Does nothing", activeWindow }, expect: { windowTitle: "Not this window" } },
      { tool: "desktop.click", input: { label: "Reset label", activeWindow } }
    ],
    returnScreenshot: "window"
  });
  const outcomes = failingPlan.body?.data?.outcomes ?? [];
  check("a missed expectation stops the plan at that step", failingPlan.error === "expectation_failed" && outcomes.length === 2 && !(failingPlan.body?.data?.steps ?? []).some((item) => item.index === 2), failingPlan.error ?? `${outcomes.length} outcome(s)`);
  check("the plan reports one line per step, and says which expectation missed", /ok, but Expected the active window title/.test(outcomes[1] ?? "") && /ok, screen changed, expectation met/.test(outcomes[0] ?? ""), JSON.stringify(outcomes));
  check("the plan returns one picture at its end", failingPlan.images.length === 1, `${failingPlan.images.length} image(s)`);
  const textPlan = await mcp.call("computer.run_steps", {
    steps: [{ tool: "desktop.click", input: { label: "Reset label", activeWindow }, expect: { textVisible: "idle" } }]
  });
  check("a textVisible expectation passes when the text is on screen", textPlan.ok && textPlan.body?.data?.steps?.[0]?.expectation === "met", textPlan.error ?? JSON.stringify(textPlan.body?.data?.outcomes ?? null));

  const fieldAt = (x, y, args) => mcp.call("desktop.set_field", { x: origin.x + x, y: origin.y + y, activeWindow, ...args });
  const entryNow = () => readFileSync(entryFile, "utf8");
  const one = await fieldAt(180, 175, { text: "Field one" });
  await sleep(300);
  check("set_field replaces the text and reads it back", one.ok && one.body?.data?.confirmed === true && entryNow() === "Field one", JSON.stringify(one.body?.data ?? one.error ?? null));
  const two = await fieldAt(180, 175, { text: "Field two" });
  await sleep(300);
  check("set_field over existing text leaves exactly the new text", two.ok && two.body?.data?.confirmed === true && entryNow() === "Field two", entryNow() === "Field two" ? "" : `got ${JSON.stringify(entryNow())}`);
  const appended = await fieldAt(180, 175, { text: "+3", replace: false });
  await sleep(300);
  check("set_field with replace false appends at the end", appended.ok && appended.body?.data?.confirmed === true && entryNow() === "Field two+3", entryNow() === "Field two+3" ? "" : `got ${JSON.stringify(entryNow())}`);
  const cleared = await fieldAt(180, 175, { text: "" });
  await sleep(300);
  check("set_field with empty text clears the field", cleared.ok && cleared.body?.data?.confirmed === true && entryNow() === "", JSON.stringify(cleared.body?.data ?? cleared.error ?? null));
  const notField = await fieldAt(120, 120, { text: "SHOULD NOT APPEAR" });
  await sleep(300);
  check("set_field refuses a click that focuses no editable field, typing nothing", notField.error === "field_not_exposed" && entryNow() === "", notField.error ?? "accepted");
  const secretField = await fieldAt(285, 215, { text: "hunter2" });
  await sleep(300);
  check("set_field refuses a password field before typing anything", ["sensitive_field", "field_not_exposed"].includes(secretField.error) && entryNow() === "", secretField.error ?? "accepted");
  return { mcp, win, activeWindow, clickAt };
}

async function pauseChecks(mcp, env, activeWindow, clickAt) {
  let last;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    last = await mcp.call("desktop.hotkey", { keys: ["Shift_L"], activeWindow });
  }
  check("ten identical unchanged calls trigger a self-pause", /paused itself/.test((last.body?.observations ?? []).join(" ")));
  const status = await mcp.call("agent.status", {});
  const pause = status.body?.data?.runState?.pause;
  check("the pause is stored with its reason", pause?.requested === true && /no visible change/.test(pause?.reason ?? ""), (pause?.reason ?? "").slice(0, 90));
  const blocked = await clickAt(120, 120);
  check("while paused, a state-changing action is refused", !blocked.ok && blocked.error === "pause_requested", blocked.error ?? "not refused");
  const resumed = cli(env, ["agent", "resume"]);
  check("bare agent resume clears the pause", resumed.data?.note === "Pause cleared.", resumed.data?.note ?? resumed.out);
  const after = await mcp.call("agent.status", {});
  check("actions run again after resume", after.body?.data?.runState?.pause?.requested === false);
  return mcp;
}

async function browserChecks(mcp, work, env) {
  const form = path.join(work, "form.html");
  writeFileSync(form, FORM);
  const cvPath = path.join(work, "cv.txt");
  writeFileSync(cvPath, "cv");
  const opened = await mcp.call("browser.open", { url: pathToFileURL(form).toString(), headless: true });
  check("browser.open loads the local form in headless Chrome", opened.ok, opened.body?.error?.message ?? "");

  const ready = await mcp.call("browser.wait_for", { text: "frame ready", timeoutMs: 8000 });
  check("the iframe loads before the snapshot", ready.ok && ready.body?.data?.matched === true, ready.error ?? "");
  const snap = await mcp.call("browser.snapshot", {});
  const elements = snap.body?.data?.elements ?? [];
  const find = (predicate) => elements.find(predicate)?.ref;
  const refs = {
    name: find((item) => item.name === "Name"),
    country: find((item) => item.tag === "select"),
    cv: find((item) => item.type === "file"),
    password: find((item) => item.type === "password"),
    save: find((item) => item.name === "Save profile"),
    send: find((item) => item.name === "Send")
  };
  const missingRefs = Object.entries(refs).filter(([, value]) => !value).map(([key]) => key);
  check("the snapshot finds every control by ref", missingRefs.length === 0, missingRefs.length ? `missing ${missingRefs.join(", ")}` : "");
  const frameField = find((item) => item.name === "Frame field");
  const frameDisabled = find((item) => item.name === "Frame disabled");
  const frameButton = find((item) => item.name === "Frame button");
  check("the snapshot lists a same-origin iframe control marked inFrame", Boolean(frameField) && elements.some((item) => item.name === "Frame field" && item.inFrame === true));
  const frameFilled = await mcp.call("browser.fill", { fields: [{ ref: frameField, text: "in frame" }] });
  check("browser.fill reaches a field inside the iframe and reads it back", frameFilled.ok && (frameFilled.body?.data?.fields ?? []).every((item) => item.confirmed), frameFilled.error ?? "");
  const disabledClick = await mcp.call("browser.click", { ref: frameDisabled });
  check("a disabled control in the iframe is refused before any click", disabledClick.error === "element_disabled", disabledClick.error ?? "clicked");
  const frameClick = await mcp.call("browser.click", { ref: frameButton });
  check("a click inside the iframe lands and reports domChanged, not navigated", frameClick.ok && frameClick.body?.data?.domChanged === true && frameClick.body?.data?.navigated === false, frameClick.error ?? JSON.stringify(frameClick.body?.data ?? null).slice(0, 160));

  const filled = await mcp.call("browser.fill", { fields: [{ ref: refs.name, text: "Ada Lovelace" }] });
  check("browser.fill types a value and reads it back", filled.ok && (filled.body?.data?.fields ?? []).every((item) => item.confirmed));
  const refused = await mcp.call("browser.fill", { fields: [{ ref: refs.name, text: "x" }, { ref: refs.password, text: "hunter2" }] });
  check("browser.fill refuses a password field before typing", refused.error === "sensitive_field", refused.error ?? "");

  const wrong = await mcp.call("browser.select", { ref: refs.country, label: "Gamma" });
  check("browser.select lists the options when none matches", wrong.error === "option_not_found" && JSON.stringify(wrong.body?.observations ?? []).includes("Alpha"));
  const chosen = await mcp.call("browser.select", { ref: refs.country, label: "Beta" });
  check("browser.select chooses an option by its label", chosen.ok && chosen.body?.data?.selected === "Beta");

  const uploadBare = await mcp.call("browser.upload", { ref: refs.cv, files: [cvPath] });
  check("browser.upload refuses without a confirmation", !uploadBare.ok, uploadBare.error ?? "");
  const uploadPreview = await mcp.call("browser.upload", { ref: refs.cv, files: [cvPath], dryRun: true });
  const uploadToken = uploadPreview.body?.confirmation?.tokenId;
  check("the upload preview mints a one-time token", Boolean(uploadToken));
  const uploadApproved = uploadToken ? cli(env, ["confirm", uploadToken]) : { ok: false };
  check("the operator confirms the upload with `agenthost confirm`", uploadApproved.ok === true);
  const uploaded = await mcp.call("browser.upload", { ref: refs.cv, files: [cvPath], confirmationToken: uploadToken });
  check("the confirmed upload attaches the file", uploaded.ok, uploaded.error ?? "");
  const seen = await mcp.call("browser.wait_for", { text: "files:1", timeoutMs: 5000 });
  check("the page reports the attached file", seen.ok && seen.body?.data?.matched === true);

  const saved = await mcp.call("browser.click", { ref: refs.save });
  check("a non-consequential click runs without a token", saved.ok, saved.error ?? "");
  const savedSeen = await mcp.call("browser.wait_for", { text: "saved:Ada Lovelace", timeoutMs: 5000 });
  check("the click had its effect on the page", savedSeen.ok);

  const sendBare = await mcp.call("browser.click", { ref: refs.send });
  check("a consequential Send click needs confirmation", !sendBare.ok, sendBare.error ?? "");
  const sendPreview = await mcp.call("browser.click", { ref: refs.send, dryRun: true });
  const sendToken = sendPreview.body?.confirmation?.tokenId;
  if (sendToken) cli(env, ["confirm", sendToken]);
  const sent = await mcp.call("browser.click", { ref: refs.send, confirmationToken: sendToken });
  check("a confirmed Send runs once", sent.ok, sent.error ?? "");
  const sentSeen = await mcp.call("browser.wait_for", { text: "sent", timeoutMs: 5000 });
  check("the page shows the sent state", sentSeen.ok);

  const pageShot = await mcp.call("browser.screenshot", {});
  const image = pageShot.images[0];
  check("browser.screenshot returns an inline JPEG", image?.mimeType === "image/jpeg" && image.data.startsWith("/9j/"));
  await mcp.call("browser.close", {});
}

const COMPOSITOR = path.join(REPO, "scripts/live-check-compositor.py");

// The renderer child of one server process, or undefined when no card renderer is running.
function rendererUnder(serverPid) {
  let listing = "";
  try {
    listing = execFileSync("ps", ["-o", "pid=,args=", "--ppid", String(serverPid)], { encoding: "utf8" });
  } catch {
    return undefined;
  }
  const line = listing.split("\n").find((item) => item.includes("gtk3-renderer.py"));
  return line === undefined ? undefined : Number(line.trim().split(/\s+/)[0]);
}

function processAlive(pid) {
  try {
    const state = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.charAt(0);
    return state !== undefined && state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function waitFor(probe, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = probe();
    if (value) return value;
    await sleep(200);
  }
  return undefined;
}

async function sessionExitChecks(root) {
  console.log("== Session end (a nested display opens for a few seconds)");
  const display = freeDisplay();
  const home = path.join(root, "exit-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = path.join(home, "config.json");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, autoInstallDependencies: false }));
  const env = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: config, DISPLAY: display, XDG_SESSION_TYPE: "x11" };
  const started = [];
  try {
    started.push(spawn("Xephyr", [display, "-screen", "640x480", "-no-host-grab"], { env: { ...process.env, DISPLAY: HOST_DISPLAY }, stdio: "ignore" }));
    for (let attempt = 0; attempt < 60 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); attempt += 1) await sleep(100);
    // A nested display has no compositor, so cards would refuse to draw. This claims the
    // compositing selection on that display only.
    started.push(spawn("python3", ["-W", "ignore", COMPOSITOR], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" }));
    await sleep(1000);

    const first = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    started.push(first);
    const firstMcp = mcpClient(first);
    await firstMcp.initialize();
    const card = await firstMcp.call("task.create", { goal: "Live session-end check" });
    check("a task card is created for the session", card.ok, card.error ?? "");
    const renderer = await waitFor(() => rendererUnder(first.pid), 15_000);
    check("the card's overlay renderer starts on the nested display", renderer !== undefined, renderer === undefined ? "no gtk3-renderer child" : `pid ${renderer}`);
    first.stdin.end();
    const serverExited = await waitFor(() => first.exitCode !== null || first.signalCode !== null, 8_000);
    check("the MCP server exits when its client closes stdin", Boolean(serverExited));
    if (renderer !== undefined) {
      const rendererGone = await waitFor(() => !processAlive(renderer), 8_000);
      check("the card's renderer exits with the session", Boolean(rendererGone));
    }

    const second = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    started.push(second);
    const secondMcp = mcpClient(second);
    await secondMcp.initialize();
    await secondMcp.call("task.create", { goal: "Live hard-kill check" });
    const killedRenderer = await waitFor(() => rendererUnder(second.pid), 15_000);
    check("a second card renderer starts", killedRenderer !== undefined);
    second.kill("SIGKILL");
    if (killedRenderer !== undefined) {
      // The renderer polls its parent every 5 s, so allow a little more than one poll.
      const orphanGone = await waitFor(() => !processAlive(killedRenderer), 12_000);
      check("the renderer exits when its server is killed outright", Boolean(orphanGone));
    }
  } finally {
    for (const child of started.reverse()) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
    await sleep(500);
  }
}

const DIALOG_PROBE = `
import gi, sys
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
out, title = sys.argv[1], sys.argv[2]
is_open = title.lower().startswith("open")
action = Gtk.FileChooserAction.OPEN if is_open else Gtk.FileChooserAction.SAVE
dlg = Gtk.FileChooserDialog(title=title, action=action)
dlg.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Open" if is_open else "Save", Gtk.ResponseType.OK)
dlg.set_default_size(480, 320)
dlg.move(0, 0)
def on_response(d, response):
    if response == Gtk.ResponseType.OK:
        open(out, "w", encoding="utf8").write(d.get_filename() or "")
    d.destroy()
    Gtk.main_quit()
dlg.connect("response", on_response)
dlg.show_all()
Gtk.main()
`;

async function fileDialogChecks(root) {
  console.log("== File dialogs (a nested display opens for a few seconds)");
  const display = freeDisplay();
  const work = path.join(root, "dialog-work");
  mkdirSync(work, { recursive: true });
  const home = path.join(root, "dialog-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = path.join(home, "config.json");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, overlay: { mode: "off" }, autoInstallDependencies: false }));
  const picked = path.join(work, "picked.txt");
  writeFileSync(picked, "chosen");
  const dialogScript = path.join(work, "dialog_probe.py");
  writeFileSync(dialogScript, DIALOG_PROBE);
  const started = [];
  try {
    started.push(spawn("Xephyr", [display, "-screen", "800x600", "-no-host-grab"], { env: { ...process.env, DISPLAY: HOST_DISPLAY }, stdio: "ignore" }));
    for (let attempt = 0; attempt < 60 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); attempt += 1) await sleep(100);
    const env = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: config, DISPLAY: display, XDG_SESSION_TYPE: "x11" };
    const openOut = path.join(work, "opened.txt");
    started.push(spawn("python3", ["-W", "ignore", dialogScript, openOut, "Open File"], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" }));
    await sleep(2000);
    const server = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    started.push(server);
    const mcp = mcpClient(server);
    await mcp.initialize();
    const listed = await mcp.call("window.list", { includeTitles: true });
    const dialog = listed.body?.data?.windows?.find((item) => item.title === "Open File");
    check("AgentHost lists the open file dialog with its window id", Boolean(dialog), dialog ? `window ${dialog.windowId}` : JSON.stringify(listed.body?.error ?? "not listed"));
    if (dialog) {
      const selected = await mcp.call("desktop.file_dialog_select", { path: picked, windowId: dialog.windowId });
      await sleep(300);
      check("file_dialog_select types the path, submits it, and the dialog closes", selected.ok && selected.body?.data?.closed === true, selected.error ?? JSON.stringify(selected.body?.observations ?? []));
      check("the dialog accepted exactly the requested file", existsSync(openOut) && readFileSync(openOut, "utf8") === picked, existsSync(openOut) ? `got ${JSON.stringify(readFileSync(openOut, "utf8"))}` : "no result written");
    }
    const savePath = path.join(work, "should-not-exist.txt");
    started.push(spawn("python3", ["-W", "ignore", dialogScript, path.join(work, "saved.txt"), "Save File"], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" }));
    await sleep(2000);
    const save = await mcp.call("desktop.file_dialog_select", { path: savePath, dialogTitle: "Save File" });
    check("file_dialog_select refuses a Save dialog and writes nothing", save.error === "save_dialog_refused" && !existsSync(savePath), save.error ?? "accepted");
  } finally {
    for (const child of started.reverse()) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
    await sleep(500);
  }
}

async function main() {
  if (!existsSync(SERVER) || !existsSync(CLI)) {
    console.log("Build first: npm run build");
    process.exitCode = 2;
    return;
  }
  const missing = ["Xephyr", "python3"].filter((tool) => !hasCommand(tool));
  if (missing.length > 0) {
    console.log(`Missing: ${missing.join(", ")}. Install them, then run this again.`);
    process.exitCode = 2;
    return;
  }
  const chrome = ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"].some(hasCommand);
  const root = mkdtempSync(path.join(os.tmpdir(), "agenthost-live-"));
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(work, { recursive: true });
  const config = path.join(home, "config.json");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, overlay: { mode: "off" }, autoInstallDependencies: false }));
  const env = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: config };
  const children = [];
  try {
    console.log("== CLI");
    cliChecks(env);

    const display = freeDisplay();
    console.log(`== Desktop on nested display ${display} (a small window opens on your screen for about a minute)`);
    const xephyr = spawn("Xephyr", [display, "-screen", "800x600", "-no-host-grab"], { env: { ...process.env, DISPLAY: HOST_DISPLAY }, stdio: "ignore" });
    children.push(xephyr);
    for (let attempt = 0; attempt < 60 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); attempt += 1) await sleep(100);
    if (!existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) throw new Error(`Xephyr did not open ${display}. Is DISPLAY=${HOST_DISPLAY} reachable?`);
    if (process.env.LIVE_CHECK_LAYOUT) {
      try {
        execFileSync("setxkbmap", [process.env.LIVE_CHECK_LAYOUT], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" });
        console.log(`(keyboard layout set to ${process.env.LIVE_CHECK_LAYOUT} on ${display} only)`);
      } catch {
        console.log(`(could not set layout ${process.env.LIVE_CHECK_LAYOUT}; setxkbmap failed)`);
      }
    }
    const entryFile = path.join(work, "entry.txt");
    writeFileSync(entryFile, "");
    const probeScript = path.join(work, "probe_app.py");
    writeFileSync(probeScript, PROBE);
    children.push(spawn("python3", ["-W", "ignore", probeScript, entryFile], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" }));
    await sleep(2500);

    const server = spawn(process.execPath, [SERVER], { env: { ...env, DISPLAY: display, XDG_SESSION_TYPE: "x11" }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(server);
    const mcp = mcpClient(server);
    await mcp.initialize();
    const desktop = await desktopChecks(mcp, entryFile, display);
    if (desktop) {
      await pauseChecks(mcp, env, desktop.activeWindow, desktop.clickAt);
      if (hasVte()) await terminalChecks(mcp, work, display);
      else console.log("(terminal check skipped: no VTE 2.91 bindings for python3)");
    }

    if (chrome) {
      console.log("== Browser (headless Chrome)");
      await browserChecks(mcp, work, env);
    } else {
      console.log("== Browser: SKIPPED (no Chrome or Chromium found)");
    }

    await sessionExitChecks(root);
    await fileDialogChecks(root);
  } finally {
    for (const child of children.reverse()) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* Already gone. */
      }
    }
    await sleep(1000);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Chrome may still be flushing its profile; the temp folder is harmless. */
    }
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`ERROR  ${error.message}`);
  process.exitCode = 1;
});
