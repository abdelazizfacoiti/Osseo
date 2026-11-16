#!/usr/bin/env node
/*
 * Checks the numbered tools on the agent's own Chrome on Windows (W3 task 4): the built MCP server over stdio runs
 * open, see, type, click and wait on a local form. `see` must answer from the browser DOM (source "dom") and list the
 * field and the button by number. The form is served on 127.0.0.1 and nothing leaves this machine.
 *
 *   npm run build && node scripts\windows-see-check.mjs
 *
 * It uses a temporary AGENTHOST_HOME, so the agent profile it opens is a throwaway one, not the person's. It does
 * not touch the person's own Chrome. Each step prints PASS or FAIL; exit 0 only when every step passes.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "packages", "mcp-server", "dist", "index.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
if (!existsSync(SERVER)) {
  console.log("FAIL  build first: npm run build");
  process.exit(2);
}

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url.startsWith("/done")) {
    response.end("<title>Thanks</title><h1>Thanks</h1>");
    return;
  }
  response.end('<title>See check</title><form action="/done" method="get"><label>Name <input id="name" name="name"></label> <button type="submit">Save</button></form>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const home = mkdtempSync(path.join(os.tmpdir(), "agenthost-see-check-"));
const config = path.join(home, "config.json");
writeFileSync(config, JSON.stringify({ schemaVersion: 1, overlay: { mode: "off" }, autoInstallDependencies: false }));
const env = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: config };
const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
const replies = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
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
let nextId = 10;
async function wait(id, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (replies.has(id)) return replies.get(id);
    await sleep(40);
  }
  throw new Error(`no reply within ${ms / 1000} s`);
}
async function call(name, args = {}, ms) {
  const id = nextId;
  nextId += 1;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
  const reply = await wait(id, ms);
  const text = reply.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: { code: "unparseable_reply", message: text.slice(0, 200) } };
  }
}

try {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "windows-see-check", version: "1" } } })}\n`);
  await wait(1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listId = nextId;
  nextId += 1;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: listId, method: "tools/list", params: {} })}\n`);
  const tools = ((await wait(listId)).result?.tools ?? []).map((tool) => tool.name);
  check("the numbered tools are listed (open, see, type, click, wait)", ["open", "see", "type", "click", "wait"].every((name) => tools.includes(name)), `${tools.length} tools listed`);

  const opened = await call("open", { url }, 60_000);
  check("open loads the form in the agent's own browser", opened.ok === true, opened.error?.message ?? "");

  const seen = await call("see", { picture: "none" }, 60_000);
  const list = String(seen.data?.list ?? "");
  check("see answers from the browser DOM", seen.ok === true && seen.data?.source === "dom", `source ${seen.data?.source ?? "none"}`);
  // The numbered list uses the Linux role names: a text field is an "entry".
  const field = /\[(\d+)\]\s+(?:entry|textbox)\s+"Name"/.exec(list);
  const button = /\[(\d+)\]\s+button\s+"Save"/.exec(list);
  check("see lists the field and the Save button by number", field !== null && button !== null, list.slice(0, 300));

  if (field !== null && button !== null) {
    const typed = await call("type", { n: Number(field[1]), text: "Ada", clear: true }, 60_000);
    check("type fills the numbered field", typed.ok === true, typed.error?.message ?? "");
    const clicked = await call("click", { n: Number(button[1]) }, 60_000);
    check("click submits the form by number", clicked.ok === true, clicked.error?.code ?? clicked.error?.message ?? "");
    const waited = await call("wait", { text: "Thanks", timeoutMs: 8_000 }, 60_000);
    check("wait sees the confirmation page", waited.ok === true, waited.error?.message ?? "");
  }
} catch (error) {
  record("FAIL", "harness", error instanceof Error ? error.message : String(error));
} finally {
  child.stdin.end();
  child.kill();
  server.close();
  await sleep(500);
  rmSync(home, { recursive: true, force: true });
}
console.log(`\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.NOTE} notes, ${counts.SKIP} skipped`);
process.exit(counts.FAIL === 0 ? 0 : 1);
