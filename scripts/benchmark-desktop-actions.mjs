#!/usr/bin/env node
/*
 * Desktop action latency benchmark (Phase 0 of docs/notes/speed-plan.md).
 *
 *   npm run build && npm run benchmark:desktop-actions [-- --runs 15 --out file.json --overlay]
 *
 * It starts a nested X display (Xephyr) with a small GTK test window, starts the built server over stdio
 * (isolated home, overlay off unless --overlay), and times the calls an agent makes, as the agent makes them:
 * see, click by number, key, type, a 20-key run as 20 calls and as one sequence. Per action it prints the median
 * and p90 wall time, and, from the server's own audit log, the median time of each phase (overlay wait,
 * safety, preview, handler, audit). No window opens on your screen except the small Xephyr window.
 * Needs: Xephyr, python3 with GTK 3 (PyGObject), a host DISPLAY.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPrivateBus } from "./private-bus.mjs";

process.env.AGENTHOST_TOOLS_PROFILE ??= "full";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "packages/mcp-server/dist/index.js");
const HOST_DISPLAY = process.env.DISPLAY ?? ":0";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const RUNS = Number(option("runs", "15"));

const PROBE = `
import gi, sys
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
w = Gtk.Window(title="Bench probe"); w.set_default_size(420, 260); w.move(0, 0)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8); box.set_border_width(12)
entry = Gtk.Entry(); entry.set_name("Field")
entry.get_accessible().set_name("Field")
label = Gtk.Label(label="0")
tick = Gtk.Button(label="Tick")
count = [0]
def on_tick(_b):
    count[0] += 1; label.set_text(str(count[0]))
tick.connect("clicked", on_tick)
box.pack_start(entry, False, False, 0); box.pack_start(tick, False, False, 0); box.pack_start(label, False, False, 0)
w.add(box); w.show_all(); w.connect("destroy", Gtk.main_quit); Gtk.main()
`;

function displayBusy(number) {
  const lock = `/tmp/.X${number}-lock`;
  if (!existsSync(lock)) return existsSync(`/tmp/.X11-unix/X${number}`);
  try { process.kill(Number(readFileSync(lock, "utf8").trim()), 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function freeDisplay(from) {
  for (let number = from; number < 200; number += 1) if (!displayBusy(number)) return `:${number}`;
  throw new Error("no free display number");
}
const percentile = (values, fraction) => { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))] ?? 0; };
const median = (values) => percentile(values, 0.5);

function client(server) {
  const replies = new Map();
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const message = JSON.parse(line); if (message.id !== undefined) replies.set(message.id, message); } catch { /* not a protocol message */ }
    }
  });
  let next = 100;
  const wait = async (id, ms = 120_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (replies.has(id)) return replies.get(id); await sleep(10); } throw new Error(`no reply to ${id}`); };
  return {
    async initialize() {
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "benchmark-desktop-actions", version: "1" } } })}\n`);
      await wait(1, 60_000);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(name, input) {
      const id = next; next += 1;
      const started = performance.now();
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: input } })}\n`);
      const reply = await wait(id);
      const ms = performance.now() - started;
      const text = (reply.result?.content ?? []).find((item) => item.type === "text")?.text ?? "";
      let body; try { body = JSON.parse(text); } catch { body = undefined; }
      return { ms, body, ok: body?.ok === true, error: body?.error?.code };
    }
  };
}

function numberOf(list, needle) {
  const line = String(list ?? "").split("\n").find((entry) => entry.includes(needle));
  const match = line === undefined ? undefined : /^\[(\d+)\]/.exec(line.trim());
  return match === null || match === undefined ? undefined : Number(match[1]);
}

function auditPhases(home) {
  const file = path.join(home, "logs", "agenthost.jsonl");
  const rows = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean) : [];
  const byTool = new Map();
  for (const row of rows) {
    if (row.ok !== true || row.timings === undefined) continue;
    const list = byTool.get(row.tool) ?? []; list.push(row.timings); byTool.set(row.tool, list);
  }
  const result = {};
  for (const [tool, list] of byTool) {
    result[tool] = { calls: list.length };
    for (const phase of ["overlayWait", "safetyEval", "preview", "handler", "auditWrite", "total"]) result[tool][phase] = Math.round(median(list.map((t) => t[phase] ?? 0)));
  }
  return result;
}

async function main() {
  if (!existsSync(SERVER)) { console.log("Build first: npm run build"); process.exitCode = 2; return; }
  for (const tool of ["Xephyr", "python3"]) {
    try { execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }); } catch { console.log(`Missing ${tool}.`); process.exitCode = 2; return; }
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "agenthost-bench-actions-"));
  const home = path.join(root, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(home, "config.json"), JSON.stringify({ schemaVersion: 1, overlay: { mode: flag("overlay") ? "always" : "off" }, autoInstallDependencies: false }));
  const probeScript = path.join(root, "probe.py");
  writeFileSync(probeScript, PROBE);
  const bus = startPrivateBus();
  const children = [];
  const display = freeDisplay(150);
  try {
    children.push(spawn("Xephyr", [display, "-screen", "800x600", "-no-host-grab"], { env: { ...process.env, DISPLAY: HOST_DISPLAY }, stdio: "ignore" }));
    for (let i = 0; i < 60 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i += 1) await sleep(100);
    children.push(spawn("python3", ["-W", "ignore", probeScript], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" }));
    await sleep(2500);
    const server = spawn(process.execPath, [SERVER], { env: { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: path.join(home, "config.json"), DISPLAY: display, XDG_SESSION_TYPE: "x11" }, stdio: ["pipe", "pipe", "pipe"] });
    children.push(server);
    const mcp = client(server);
    await mcp.initialize();

    const results = [];
    const record = (name, samples, failures) => results.push({ name, runs: samples.length, failures, medianMs: Math.round(median(samples)), p90Ms: Math.round(percentile(samples, 0.9)) });
    const time = async (name, runs, fn) => {
      const samples = []; let failures = 0;
      let firstError;
      for (let i = 0; i < runs; i += 1) { const r = await fn(i); samples.push(r.ms); if (!r.ok) { failures += 1; firstError ??= r.error ?? String(JSON.stringify(r.body?.observations ?? r.body ?? "no reply")).slice(0, 200); } }
      if (firstError !== undefined) console.log(`  note: ${name} failed: ${firstError}`);
      if (firstError === "pause_requested") throw new Error("the server paused itself (loop guard); the numbers after this point are invalid");
      record(name, samples, failures);
    };

    // A bare nested display has no window manager: focus the probe window first, then read the numbered list.
    const windows = await mcp.call("windows", {});
    const probeWindow = (windows.body?.data?.windows ?? []).find((entry) => /Bench probe/.test(entry.title ?? ""));
    if (probeWindow === undefined) throw new Error(`the probe window is not open: ${JSON.stringify(windows.body).slice(0, 300)}`);
    await mcp.call("windows", { focus: probeWindow.windowId });
    let seen = await mcp.call("see", { picture: "none" });
    const list = String(seen.body?.data?.list ?? "");
    const field = numberOf(list, '"Field"') ?? numberOf(list, "entry");
    const tick = numberOf(list, '"Tick"');
    if (field === undefined || tick === undefined) throw new Error(`the probe window was not listed: ${JSON.stringify(seen.body).slice(0, 400)}`);

    await time("see (accessibility tree)", Math.max(5, Math.floor(RUNS / 2)), () => mcp.call("see", { picture: "none" }));
    seen = await mcp.call("see", { picture: "none" });
    // Alternate two controls: the server's loop guard counts ten identical calls in a minute as a loop when the active window does not change.
    await time("click by number, verified", RUNS, (i) => mcp.call("click", { n: i % 2 === 0 ? tick : field }));
    await mcp.call("click", { n: field });
    // Vary the key: ten identical calls in a minute trip the server's own loop guard (a self-pause), by design.
    const pool = "bcdefghijklmnopqrstuvwxyz".split("");
    await time("key (one key)", RUNS, (i) => mcp.call("key", { keys: pool[i % pool.length] }));
    await time("type 11 characters", Math.max(5, Math.floor(RUNS / 2)), (i) => mcp.call("type", { n: field, text: `hello wor${String(i).padStart(2, "0")}` }));
    // Twenty keys the way an agent does it without batching, and in one call.
    const letters = "abcdefghijklmnopqrst".split("");
    await time("20 keys as 20 calls (total)", 3, async () => {
      const started = performance.now(); let ok = true;
      for (const letter of letters) ok = (await mcp.call("key", { keys: letter })).ok && ok;
      return { ms: performance.now() - started, ok };
    });
    await time("20 keys as 1 sequence call", 3, () => mcp.call("key", { sequence: letters }));

    console.log(`\nDesktop action latency on ${display} (overlay ${flag("overlay") ? "on" : "off"}), ${RUNS} runs per action\n`);
    console.log("| action | median ms | p90 ms | failed |");
    console.log("|---|---:|---:|---:|");
    for (const row of results) console.log(`| ${row.name} | ${row.medianMs} | ${row.p90Ms} | ${row.failures} |`);
    const phases = auditPhases(home);
    console.log("\nServer phase medians per call (ms), from the audit log:\n");
    console.log("| tool | calls | overlay wait | safety | preview | handler | audit | total |");
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const [tool, p] of Object.entries(phases).sort((a, b) => b[1].total - a[1].total)) console.log(`| ${tool} | ${p.calls} | ${p.overlayWait} | ${p.safetyEval} | ${p.preview} | ${p.handler} | ${p.auditWrite} | ${p.total} |`);
    const outFile = option("out", undefined);
    if (outFile !== undefined) writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), runs: RUNS, results, phases }, null, 1));
    const failed = results.reduce((sum, row) => sum + row.failures, 0);
    console.log(failed === 0 ? "\nAll calls succeeded." : `\n${failed} call(s) failed.`);
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    for (const child of children.reverse()) { try { child.kill("SIGTERM"); } catch { /* gone */ } }
    await sleep(800);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
    bus.stop();
  }
}

main().catch((error) => { console.log(`ERROR  ${error.message}`); process.exitCode = 1; });
