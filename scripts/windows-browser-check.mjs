#!/usr/bin/env node
/*
 * Checks the agent's own Chrome on Windows (the browser.* tools, W3 step 3). It opens a visible Chrome window on the
 * dedicated agent profile (never the person's profile), reads a local form by DOM, fills it and submits it, and
 * waits for the confirmation page. It serves the form on 127.0.0.1 and sends nothing anywhere else.
 *
 *   npm run build && node scripts\windows-browser-check.mjs
 *
 * Each step prints PASS or FAIL. Exit 0 only when every step passes. Chrome stays on the screen for a moment so
 * you can see it, then the session closes.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OS_LINUX = path.join(REPO, "packages", "os-linux", "dist", "index.js");
const counts = { PASS: 0, FAIL: 0, SKIP: 0, NOTE: 0 };
const record = (status, name, detail = "") => {
  counts[status] += 1;
  console.log(`${status.padEnd(4)}  ${name}${detail === "" ? "" : `  (${detail})`}`);
};
const check = (name, ok, detail = "") => record(ok ? "PASS" : "FAIL", name, ok ? "" : detail);

if (process.platform !== "win32") {
  console.log(`SKIP  this check drives the Windows Chrome; nothing to do on ${process.platform}`);
  process.exit(0);
}
if (!existsSync(OS_LINUX)) {
  console.log("FAIL  build first: npm run build");
  process.exit(2);
}

const { BrowserSession, findChromeExecutable } = await import(pathToFileURL(OS_LINUX).href);
const executable = findChromeExecutable(process.env);
check("Chrome is found", executable !== undefined, "no chrome.exe in the usual places or on PATH");
if (executable === undefined) process.exit(1);
record("NOTE", "executable", path.basename(executable));

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url.startsWith("/done")) {
    response.end("<title>Thanks</title><h1>Thanks</h1>");
    return;
  }
  response.end('<title>Form check</title><form action="/done" method="get"><label>Name <input id="name" name="name"></label> <button type="submit">Send form</button></form>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const session = new BrowserSession({ osseoDir: path.join(os.homedir(), ".osseo") });
let exitCode = 1;
try {
  const started = Date.now();
  const opened = await session.open({ url, headless: false });
  check("browser.open shows a visible Chrome window on the form page", opened.opened === true && opened.headless === false && opened.title === "Form check", opened.reason ?? JSON.stringify(opened));
  record("NOTE", "open", `${Date.now() - started} ms`);

  const snapshot = await session.snapshot({ maxElements: 50 });
  const field = snapshot.elements.find((element) => element.tag === "input");
  const button = snapshot.elements.find((element) => element.tag === "button" || element.role === "button");
  check("the snapshot lists the field and the button by reference", field !== undefined && button !== undefined, JSON.stringify(snapshot.elements));

  if (field !== undefined && button !== undefined) {
    const typed = await session.type({ ref: field.ref, text: "Ada", clear: true });
    check("the field takes the typed text", typed.ok === true, typed.reason);
    const clicked = await session.click({ ref: button.ref });
    check("the button submits the form", clicked.ok === true && clicked.navigated === true, clicked.reason ?? JSON.stringify(clicked));
    const waited = await session.waitFor({ text: "Thanks", timeoutMs: 8_000 });
    check("the confirmation page is reached", waited.matched === true && waited.url.includes("name=Ada"), JSON.stringify(waited));
  }
  await sleep(2_000);
  exitCode = counts.FAIL === 0 ? 0 : 1;
} catch (error) {
  record("FAIL", "harness", error instanceof Error ? error.message : String(error));
} finally {
  await session.close().catch(() => undefined);
  server.close();
}
const titles = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object { $_.MainWindowTitle }"], { encoding: "utf8", windowsHide: true });
record("NOTE", "chrome windows still open after close", String(titles.stdout).trim().split(/\r?\n/).filter((title) => title.includes("Form check") || title.includes("Thanks")).length.toString());
console.log(`\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.NOTE} notes, ${counts.SKIP} skipped`);
// The CDP socket can keep the event loop alive after close, so exit explicitly.
process.exit(exitCode);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
