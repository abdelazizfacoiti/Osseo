#!/usr/bin/env node
/*
 * Form benchmark: one task, three routes, measured the same way.
 *
 *   npm run benchmark:form
 *
 * The task: type a name, choose a country, save. The page (benchmarks/tasks/form/index.html)
 * moves the form down 60px when the name is typed, as real pages do.
 *
 *   pixel-before  The pixel path as the 2026-11-09 audit showed it: after each action a wait and a
 *                 picture, then the next action at the coordinates that picture shows.
 *   pixel-after   The same page through the current desktop tools: a target that focuses and acts
 *                 in one call, set_field with read-back, label clicks, and a picture returned
 *                 with the save click.
 *   browser       browser.open, snapshot, fill, select, click, wait_for (headless Chrome).
 *
 * "calls" counts the MCP calls a route makes. "bytes" counts what each reply puts in front of the
 * agent: text and image bytes. "misclicks" counts clicks that reported no visible change where one
 * was expected. "unverified" counts successes whose own result says nothing was confirmed. The
 * final state is checked by the harness itself, outside the counts.
 *
 * The routes are scripts written by hand. The numbers measure the tool surface on this task,
 * not a model's choices, so read them as a regression gate, not a claim about any one agent.
 *
 * Not in the timed task: file upload. Headed Chrome did not open its file chooser under the
 * nested display here, so upload is covered by check:live (browser.upload through CDP, and
 * desktop.file_dialog_select against a GTK dialog) instead.
 *
 * Gate (pixel-after against pixel-before): at least 50% fewer calls, at least 40% fewer bytes,
 * no unverified successes, and the final state correct. The pixel routes need a headed Chrome,
 * Xephyr, and python3 with GTK 3, the same as check:live.
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "packages/mcp-server/dist/index.js");
const FIXTURE = path.join(REPO, "benchmarks/tasks/form/index.html");
const HOST_DISPLAY = process.env.DISPLAY ?? ":0";
const EXPECTED = "saved: Ada Lovelace | beta | no file";
// What a picture must show, by OCR. OCR reads words, not phrases, so each word is looked for on its own.
const EXPECTED_WORDS = ["saved", "Lovelace", "beta", "file"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Where the pixel routes click: the layout a picture shows before the name is typed, and after.
const LAYOUT = {
  before: { name: [240, 56], country: [240, 116], save: [120, 238] },
  after: { name: [240, 116], country: [240, 176], save: [120, 298] }
};

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

function freeDisplay(from) {
  for (let number = from; number < 160; number += 1) {
    if (!displayBusy(number)) return `:${number}`;
  }
  throw new Error(`no free display number between :${from} and :159`);
}

/** Counts what a route makes the agent read. The probe is the harness's own check and is not counted. */
function client(server) {
  const replies = new Map();
  let buffer = "";
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
  const stats = { calls: 0, bytes: 0, misclicks: 0, unverified: 0, failed: 0 };
  let next = 100;
  const wait = async (id, ms = 120_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (replies.has(id)) return replies.get(id);
      await sleep(40);
    }
    throw new Error(`no reply to request ${id}`);
  };
  const send = async (name, args) => {
    const id = next;
    next += 1;
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
    const reply = await wait(id);
    const content = reply.result?.content ?? [];
    const text = content.find((item) => item.type === "text")?.text ?? "";
    const images = content.filter((item) => item.type === "image");
    const bytes = Buffer.byteLength(text, "utf8") + images.reduce((sum, item) => sum + item.data.length, 0);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { body, bytes, ok: body?.ok === true, error: body?.error?.code };
  };
  return {
    stats,
    async initialize() {
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "benchmark-form", version: "1" } } })}\n`);
      await wait(1, 60_000);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    /** A call the route makes: counted, and its result bytes counted, and its verification counted. */
    async call(name, args = {}) {
      const result = await send(name, args);
      if (process.env.BENCH_VERBOSE === "1") console.log(`  ${name} ${result.ok ? "ok" : `failed: ${result.error ?? "?"} ${result.body?.error?.message ?? ""}`.slice(0, 220)}`);
      stats.calls += 1;
      stats.bytes += result.bytes;
      if (!result.ok) stats.failed += 1;
      if (result.ok && isUnverified(name, result.body)) stats.unverified += 1;
      return result;
    },
    /** The harness's own check of the final page state. Not counted: the agent never makes it. */
    async probe(name, args = {}) {
      return (await send(name, args)).body ?? {};
    }
  };
}

/** A success the result itself does not confirm: no measured effect, or a read-back that is unknown. */
function isUnverified(tool, body) {
  const data = body?.data ?? {};
  if (tool.startsWith("desktop.") && data.effect !== undefined && data.effect.screenChanged === null) return true;
  if (tool === "desktop.set_field" && data.confirmed === "unknown") return true;
  if (tool === "browser.click" && data.domChanged === undefined && data.navigated === undefined) return true;
  return false;
}

async function findWindow(mcp, title) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const listed = await mcp.call("window.list", { includeTitles: true });
    const found = listed.body?.data?.windows?.find((item) => item.title === title);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`window "${title}" never appeared`);
}

function misclickIf(result, expectedChange) {
  return expectedChange && result.ok && result.body?.data?.effect?.screenChanged === false ? 1 : 0;
}

/**
 * The pixel path as the 2026-11-09 audit showed it: act, wait for the page to settle, take a picture,
 * then act again from that picture. Waits and pictures were the bulk of those calls.
 */
async function pixelBefore(mcp) {
  const picture = () => mcp.call("desktop.screenshot", { includeActiveWindowOnly: true });
  const settle = () => mcp.call("computer.wait", { ms: 300 });
  const page = await findWindow(mcp, "Application form");
  const activeWindow = { windowId: page.windowId };
  await mcp.call("window.focus", { windowId: page.windowId });
  await picture();
  const name = await mcp.call("desktop.click", { x: LAYOUT.before.name[0], y: LAYOUT.before.name[1], activeWindow });
  let misclicks = misclickIf(name, false);
  await settle();
  await picture();
  await mcp.call("desktop.type_text", { text: "Ada Lovelace", activeWindow });
  await settle();
  await picture();
  const country = await mcp.call("desktop.click", { x: LAYOUT.after.country[0], y: LAYOUT.after.country[1], activeWindow });
  misclicks += misclickIf(country, true);
  await settle();
  await mcp.call("desktop.hotkey", { keys: ["Down"], repeat: 2, activeWindow });
  await settle();
  await mcp.call("desktop.hotkey", { keys: ["Return"], activeWindow });
  await settle();
  await picture();
  const save = await mcp.call("desktop.click", { x: LAYOUT.after.save[0], y: LAYOUT.after.save[1], activeWindow });
  misclicks += misclickIf(save, true);
  await settle();
  await picture();
  return { misclicks, finalOk: await pictureShows(mcp, EXPECTED_WORDS) };
}

/**
 * The same page through the current tools. Web pages are not in AT-SPI here, so the labels native
 * apps offer do not exist: the route uses screenshot ids. The country is chosen before the name is
 * typed, because the name is what shifts the layout: one fresh picture then covers the rest, and
 * the save click's picture is only the region around the button.
 */
async function pixelAfter(mcp) {
  const page = await findWindow(mcp, "Application form");
  const activeWindow = { windowId: page.windowId };
  await mcp.call("window.focus", { windowId: page.windowId });
  const first = await mcp.call("desktop.screenshot", { includeActiveWindowOnly: true });
  const firstId = first.body?.data?.screenshotMetadata?.screenshotId;
  await mcp.call("desktop.click", { screenshotId: firstId, imageX: LAYOUT.before.country[0], imageY: LAYOUT.before.country[1], activeWindow });
  await mcp.call("desktop.hotkey", { keys: ["Down"], repeat: 2, activeWindow });
  await mcp.call("desktop.hotkey", { keys: ["Return"], activeWindow });
  await mcp.call("desktop.click", { screenshotId: firstId, imageX: LAYOUT.before.name[0], imageY: LAYOUT.before.name[1], activeWindow });
  const typed = await mcp.call("desktop.type_text", { text: "Ada Lovelace", activeWindow, returnScreenshot: "window" });
  const afterId = typed.body?.data?.inline?.screenshotId;
  const save = await mcp.call("desktop.click", { screenshotId: afterId, imageX: LAYOUT.after.save[0], imageY: LAYOUT.after.save[1], activeWindow, returnScreenshot: "region" });
  const misclicks = misclickIf(save, true);
  return { misclicks, finalOk: await pictureShows(mcp, EXPECTED_WORDS) };
}

/** Whether the screen shows the text, by OCR. The harness's own check: not counted. */
async function pictureShows(mcp, words) {
  const frame = await mcp.probe("desktop.screenshot", { includeActiveWindowOnly: true, inline: false });
  const missing = [];
  for (const word of words) {
    const found = await mcp.probe("vision.find_text_on_screen", { query: word, match: "contains", limit: 5 });
    if ((found.data?.matches ?? []).length === 0) missing.push(word);
  }
  if (process.env.BENCH_VERBOSE === "1") console.log(`  final frame: ${frame.data?.path ?? "none"}; missing words: ${missing.join(", ") || "none"}`);
  if (process.env.BENCH_FRAME_DIR && frame.data?.path) copyFileSync(frame.data.path, path.join(process.env.BENCH_FRAME_DIR, `${mcp.label ?? "route"}-final.png`));
  return missing.length === 0;
}

/** The browser route: refs from one snapshot, fill and select, click, then wait for the result text. */
async function browserRoute(mcp) {
  await mcp.call("browser.open", { url: pathToFileURL(FIXTURE).toString(), headless: true });
  const snap = await mcp.call("browser.snapshot", {});
  const elements = snap.body?.data?.elements ?? [];
  const ref = (predicate) => elements.find(predicate)?.ref;
  const name = ref((item) => item.name === "Name");
  const country = ref((item) => item.tag === "select");
  const save = ref((item) => item.name === "Save draft");
  await mcp.call("browser.fill", { fields: [{ ref: name, text: "Ada Lovelace" }] });
  await mcp.call("browser.select", { ref: country, value: "beta" });
  await mcp.call("browser.click", { ref: save });
  const done = await mcp.call("browser.wait_for", { text: EXPECTED, timeoutMs: 5000 });
  return { misclicks: 0, finalOk: done.body?.data?.matched === true };
}

async function runPixelRoute(name, display, run, root) {
  const home = path.join(root, `home-${name}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = path.join(home, "config.json");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, overlay: { mode: "off" }, autoInstallDependencies: false }));
  const env = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: config, DISPLAY: display, XDG_SESSION_TYPE: "x11" };
  const xephyr = spawn("Xephyr", [display, "-screen", "800x600", "-no-host-grab"], { env: { ...process.env, DISPLAY: HOST_DISPLAY }, stdio: "ignore", detached: true });
  xephyr.unref();
  for (let attempt = 0; attempt < 60 && !existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); attempt += 1) await sleep(100);
  const chrome = spawn("google-chrome-stable", [
    `--app=${pathToFileURL(FIXTURE).toString()}`,
    `--user-data-dir=${path.join(root, `chrome-${name}`)}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-position=0,0",
    "--window-size=640,460",
    // Without this, Chrome exposes only the window frame to AT-SPI and the page's controls are invisible.
    "--force-renderer-accessibility"
  ], { env: { ...process.env, DISPLAY: display }, stdio: "ignore", detached: true });
  chrome.unref();
  const server = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  const mcp = client(server);
  mcp.label = name;
  try {
    await mcp.initialize();
    await sleep(2000);
    const started = Date.now();
    const outcome = await run(mcp);
    return summarize(name, mcp.stats, outcome, (Date.now() - started) / 1000);
  } finally {
    await stopServer(server);
    for (const child of [chrome, xephyr]) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
  }
}

async function runBrowserRoute(root) {
  const home = path.join(root, "home-browser");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = path.join(home, "config.json");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, overlay: { mode: "off" }, autoInstallDependencies: false }));
  const env = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: config };
  const server = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  const mcp = client(server);
  try {
    await mcp.initialize();
    const started = Date.now();
    const outcome = await browserRoute(mcp);
    return summarize("browser", mcp.stats, outcome, (Date.now() - started) / 1000);
  } finally {
    await stopServer(server);
  }
}

/** Close stdin so the server closes its own Chrome; SIGKILL alone leaves the browser running. */
async function stopServer(server) {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  try { server.stdin.end(); } catch { /* Already closed. */ }
  const timer = setTimeout(() => server.kill("SIGKILL"), 8000);
  await exited;
  clearTimeout(timer);
}

function summarize(route, stats, outcome, seconds) {
  return {
    route,
    calls: stats.calls,
    bytes: stats.bytes,
    misclicks: stats.misclicks + outcome.misclicks,
    unverified: stats.unverified,
    failed: stats.failed,
    finalOk: outcome.finalOk,
    seconds: Math.round(seconds * 10) / 10
  };
}

async function main() {
  for (const required of [SERVER, FIXTURE]) {
    if (!existsSync(required)) {
      console.log(`Missing ${path.relative(REPO, required)}. Run npm run build first.`);
      process.exitCode = 2;
      return;
    }
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "agenthost-form-bench-"));
  const results = [];
  try {
    results.push(await runPixelRoute("pixel-before", freeDisplay(131), pixelBefore, root));
    results.push(await runPixelRoute("pixel-after", freeDisplay(140), pixelAfter, root));
    results.push(await runBrowserRoute(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log("| route | calls | bytes | failed calls | misclicks | unverified | final state | seconds |");
  console.log("|---|---:|---:|---:|---:|---:|---|---:|");
  for (const row of results) {
    console.log(`| ${row.route} | ${row.calls} | ${row.bytes} | ${row.failed} | ${row.misclicks} | ${row.unverified} | ${row.finalOk ? "correct" : "WRONG"} | ${row.seconds} |`);
  }
  const before = results.find((row) => row.route === "pixel-before");
  const after = results.find((row) => row.route === "pixel-after");
  const browser = results.find((row) => row.route === "browser");
  const saved = (row, field) => (before[field] - row[field]) / before[field];
  console.log("");
  console.log(`pixel-after vs pixel-before: calls -${Math.round(saved(after, "calls") * 100)}%, bytes -${Math.round(saved(after, "bytes") * 100)}%`);
  console.log(`browser vs pixel-before:     calls -${Math.round(saved(browser, "calls") * 100)}%, bytes -${Math.round(saved(browser, "bytes") * 100)}%`);
  const gate = saved(after, "calls") >= 0.5 && saved(after, "bytes") >= 0.4 && after.unverified === 0 && after.failed === 0 && after.finalOk;
  console.log(`gate (>=50% fewer calls, >=40% fewer bytes, 0 unverified, correct final state): ${gate ? "PASS" : "FAIL"}`);
  process.exitCode = gate ? 0 : 1;
}

main().catch((error) => {
  console.log(`ERROR  ${error.message}`);
  process.exitCode = 1;
});
