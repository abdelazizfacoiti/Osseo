import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WINDOWS_OVERLAY_SCRIPT } from "../windows-overlay-script.js";
import { WindowsOverlayRenderer, windowsOverlayEnabled, type WindowsOverlayRendererOptions } from "../windows-renderer.js";

// A stand-in for the PowerShell overlay process: a Node script that speaks the same JSON-line protocol.
// The mode (second argument) picks a handshake or failure: normal, unsupported, epoch, exit.
const FAKE = String.raw`
const readline = require("node:readline");
const mode = process.argv[2] || "normal";
let token = null;
let epoch = 0;
let session = "unknown";
const events = [];
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (token === null) token = req.token;
  if (req.token !== token) return send({ version: 1, id: req.id, ok: false, error: "renderer_token_invalid" });
  const p = req.payload || {};
  if (req.command === "hello") {
    if (mode === "exit") process.exit(4);
    session = p.sessionId;
    epoch = p.rendererEpoch;
    const supported = mode !== "unsupported";
    const reply = { version: 1, id: req.id, ok: true, data: { protocolVersion: 1, rendererEpoch: mode === "epoch" ? epoch + 1 : epoch, capabilities: { supported, available: supported, visible: supported, renderer: "wpf-windows", rendererStatus: supported ? "available" : "unavailable", displayAvailable: true, clickThrough: supported, interactiveWidgets: supported, reason: supported ? "wpf_overlay_ready" : "overlay_input_guard_unavailable", limitations: ["fake", "visual " + JSON.stringify(p.visual ?? null)] } } };
    return mode === "slow" ? setTimeout(() => send(reply), 3000) : send(reply);
  }
  if (req.command === "show" || req.command === "update") {
    if (p.overlayId === "hang") return;
    if (p.overlayId === "die") process.exit(3);
    if (p.overlayId === "garbage") return send({ version: 1, id: req.id, ok: "yes" });
    if (p.overlayId === "missing") return send({ version: 1, id: req.id, ok: false, error: "overlay_not_found" });
    const visible = p.overlayId !== "invisible";
    if (p.overlayId === "event") events.push({ eventId: "event_1", overlayId: p.overlayId, event: "pause", createdAt: new Date().toISOString(), ownerSessionId: session });
    return send({ version: 1, id: req.id, ok: true, data: { command: req.command, acknowledgement: req.command === "show" ? "visible" : "updated", rendererEpoch: epoch, visibleWindowCount: 1, interactiveWindowCount: 0, transparentWindowCount: 1, drawReadyCount: visible ? 1 : 0, visible, liveSurfaceRegistered: p.overlayId !== "unregistered", overlayId: p.overlayId, reason: "fake_shown", requestId: req.id } });
  }
  if (req.command === "dismiss") return send({ version: 1, id: req.id, ok: true, data: { command: "dismiss", acknowledgement: "dismissed", rendererEpoch: epoch, visibleWindowCount: 0, interactiveWindowCount: 0, drawReadyCount: 0, liveSurfaceRegistered: false, overlayId: p.overlayId, reason: "fake_dismissed", requestId: req.id } });
  if (req.command === "clear") return send({ version: 1, id: req.id, ok: true, data: { command: "clear", acknowledgement: "cleared", rendererEpoch: epoch, visibleWindowCount: 0, interactiveWindowCount: 0, drawReadyCount: 0, liveSurfaceRegistered: false, reason: "fake_cleared", requestId: req.id } });
  if (req.command === "emergency_hide") return send({ version: 1, id: req.id, ok: true, data: { command: "emergency_hide", acknowledgement: "emergency_hidden", rendererEpoch: epoch, visibleWindowCount: 0, interactiveWindowCount: 0, drawReadyCount: 0, liveSurfaceRegistered: false, reason: "fake_hidden", requestId: req.id } });
  if (req.command === "state") return send({ version: 1, id: req.id, ok: true, data: { renderer: { supported: true }, overlays: [], pendingEvents: events.slice(), emergencyHidden: false } });
  if (req.command === "events") return send({ version: 1, id: req.id, ok: true, data: { events: events.splice(0) } });
  if (req.command === "close") { send({ version: 1, id: req.id, ok: true, data: { reason: "renderer_closing" } }); process.exit(0); }
  return send({ version: 1, id: req.id, ok: false, error: "renderer_command_failed" });
});
`;

const dirs: string[] = [];
const renderers: WindowsOverlayRenderer[] = [];
afterEach(async () => {
  for (const renderer of renderers.splice(0)) await renderer.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(mode = "normal", extra: Partial<WindowsOverlayRendererOptions> = {}): Promise<WindowsOverlayRenderer> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-win-overlay-"));
  dirs.push(dir);
  const script = path.join(dir, "fake-overlay.cjs");
  await writeFile(script, FAKE);
  const renderer = new WindowsOverlayRenderer({
    osseoDir: dir,
    sessionId: "session-test",
    command: { program: process.execPath, args: [script, mode] },
    startupTimeoutMs: 5_000,
    commandTimeoutMs: 400,
    ...extra
  });
  renderers.push(renderer);
  return renderer;
}

const card = (overlayId: string) => ({ overlayId, type: "widget", payload: { title: "Test", components: [], sensitivity: "public" } });

describe("WindowsOverlayRenderer", () => {
  it("sends the dock layout in the handshake, so the overlay process can reserve the strip", async () => {
    const renderer = await start("normal", { visual: { layout: "dock", dockSide: "right", dockWidthPercent: 18, dockReserveSpace: true } });
    const capabilities = await renderer.capabilities();
    expect(capabilities.limitations).toContain('visual {"layout":"dock","dockSide":"right","dockWidthPercent":18,"dockReserveSpace":true}');
  });

  it("starts on the first call and reports the capabilities from the handshake", async () => {
    const renderer = await start();
    expect(await renderer.capabilities()).toMatchObject({ supported: true, visible: true, renderer: "wpf-windows", rendererStatus: "available" });
    expect(await renderer.diagnostics()).toMatchObject({ effectiveBackend: "wpf-windows", handshake: "passed", rendererEpoch: 1 });
  });

  it("shows a card and returns the acknowledgement with the renderer's epoch", async () => {
    const renderer = await start();
    expect(await renderer.show(card("card-1"))).toMatchObject({ ok: true, acknowledged: true, rendererEpoch: 1, visibleWindowCount: 1, drawReadyCount: 1, liveSurfaceRegistered: true });
  });

  it("refuses a card the renderer did not map, and keeps the process for the next card", async () => {
    const renderer = await start();
    expect(await renderer.show(card("invisible"))).toMatchObject({ ok: false, reason: "renderer_visibility_timeout" });
    expect(await renderer.show(card("card-2"))).toMatchObject({ ok: true });
  });

  it("reports a card without a live registration, and an update of an unknown card, as failures", async () => {
    const renderer = await start();
    expect(await renderer.show(card("unregistered"))).toMatchObject({ ok: false, reason: "overlay_live_registration_missing" });
    expect(await renderer.update(card("missing"))).toMatchObject({ ok: false, reason: "overlay_not_found" });
  });

  it("reports an unsupported handshake with its reason and never shows a card", async () => {
    const renderer = await start("unsupported");
    await renderer.warmup();
    expect(await renderer.capabilities()).toMatchObject({ supported: false, reason: "overlay_input_guard_unavailable" });
    expect(await renderer.show(card("card-1"))).toMatchObject({ ok: false, reason: "overlay_input_guard_unavailable" });
  });

  it("refuses a handshake whose epoch does not match the one it sent", async () => {
    const renderer = await start("epoch");
    await renderer.warmup();
    expect(await renderer.capabilities()).toMatchObject({ supported: false, reason: "renderer_epoch_mismatch" });
  });

  it("returns at once while a slow start is still running, and the start finishes in the background", async () => {
    const renderer = await start("slow", { startupTimeoutMs: 10_000 });
    const began = Date.now();
    await renderer.warmup();
    expect(Date.now() - began).toBeLessThan(500);
    expect(await renderer.show(card("card-1"))).toMatchObject({ ok: false, reason: "renderer_starting" });
    let report = await renderer.capabilities();
    for (let attempt = 0; attempt < 20 && !report.supported; attempt += 1) report = await renderer.capabilities();
    expect(report.supported).toBe(true);
    expect(await renderer.show(card("card-2"))).toMatchObject({ ok: true });
  }, 20_000);

  it("drains the events the process queued, and nothing on the second drain", async () => {
    const renderer = await start();
    await renderer.show(card("event"));
    expect(await renderer.drainEvents()).toEqual([expect.objectContaining({ overlayId: "event", event: "pause", ownerSessionId: "session-test" })]);
    expect(await renderer.drainEvents()).toEqual([]);
  });

  it("times out a command that is never answered, and restarts for the next one", async () => {
    const renderer = await start();
    expect(await renderer.show(card("hang"))).toMatchObject({ ok: false, reason: "renderer_command_timeout" });
    expect(await renderer.show(card("card-after"))).toMatchObject({ ok: true });
  });

  it("turns a reply that breaks the protocol into a failure and restarts the process", async () => {
    const renderer = await start();
    expect(await renderer.show(card("garbage"))).toMatchObject({ ok: false, reason: "renderer_protocol_error" });
    expect(await renderer.show(card("card-after"))).toMatchObject({ ok: true });
  });

  it("restarts once after the process dies, then stops trying", async () => {
    const renderer = await start();
    expect((await renderer.show(card("die"))).ok).toBe(false);
    expect((await renderer.show(card("card-after"))).ok).toBe(true);
    expect((await renderer.show(card("die"))).ok).toBe(false);
    expect((await renderer.show(card("card-final"))).ok).toBe(false);
  });

  it("clears and hides through the protocol and reports the acknowledgements", async () => {
    const renderer = await start();
    expect(await renderer.clear()).toMatchObject({ ok: true, acknowledged: true });
    expect(await renderer.emergencyHide()).toMatchObject({ ok: true, acknowledged: true });
    expect(await renderer.dismiss("card-1")).toMatchObject({ ok: true, acknowledged: true });
  });

  it("refuses every call after close", async () => {
    const renderer = await start();
    await renderer.close();
    expect(await renderer.show(card("card-1"))).toMatchObject({ ok: false });
  });

  it("writes the script under run/ when no test command is injected", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-win-overlay-script-"));
    dirs.push(dir);
    const renderer = new WindowsOverlayRenderer({ osseoDir: dir, startupTimeoutMs: 1_000 });
    renderers.push(renderer);
    await renderer.warmup();
    await renderer.capabilities();
    expect(await readFile(path.join(dir, "run", "windows-overlay.ps1"), "utf8")).toBe(WINDOWS_OVERLAY_SCRIPT);
  });
});

describe("windowsOverlayEnabled", () => {
  it("is on only for the exact opt-in value", () => {
    expect(windowsOverlayEnabled({ OSSEO_WINDOWS_OVERLAY: "1" })).toBe(true);
    expect(windowsOverlayEnabled({ OSSEO_WINDOWS_OVERLAY: "true" })).toBe(false);
    expect(windowsOverlayEnabled({})).toBe(false);
  });
});
