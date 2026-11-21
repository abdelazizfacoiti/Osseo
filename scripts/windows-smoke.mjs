#!/usr/bin/env node
/*
 * Headless check of the built MCP server over stdio, on any operating system. It covers what W1
 * ports to Windows: the server starts, files, protected and credential paths, shell classification,
 * PowerShell and cmd, browser.open (Chrome or Edge), tasks, and provenance.
 *
 *   npm run build && node scripts/windows-smoke.mjs
 *
 * It uses a temporary OSSEO_HOME and removes it afterwards. It never types or clicks, and it
 * never runs a command that needs approval: a command that asks first is reported, not run.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// These scripts list and count tools, so they run the full tool list.
process.env.OSSEO_TOOLS_PROFILE ??= "full";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "packages", "mcp-server", "dist", "index.js");
const WINDOWS = process.platform === "win32";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const counts = { PASS: 0, FAIL: 0, SKIP: 0, NOTE: 0 };

function record(status, name, detail = "") {
  counts[status] += 1;
  console.log(`${status.padEnd(4)}  ${name}${detail === "" ? "" : `  (${detail})`}`);
}

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
  let next = 10;
  const wait = async (id, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (replies.has(id)) return replies.get(id);
      await sleep(40);
    }
    throw new Error(`no reply within ${ms / 1000} s`);
  };
  return {
    async initialize() {
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "windows-smoke", version: "1" } } })}\n`);
      const reply = await wait(1);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return reply;
    },
    async list() {
      const id = next;
      next += 1;
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} })}\n`);
      return (await wait(id)).result?.tools ?? [];
    },
    async call(name, args = {}) {
      const id = next;
      next += 1;
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      const reply = await wait(id);
      const text = reply.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: { code: "unparseable_reply", message: text.slice(0, 200) } };
      }
    }
  };
}

// A command that needs approval comes back as confirmation_required (or approval_required); a refused one as safety_blocked.
function expectBlocked(result) {
  return !result.ok && ["confirmation_required", "approval_required", "safety_blocked"].includes(result.error?.code);
}

async function main() {
  if (!existsSync(SERVER)) {
    console.log("FAIL  build first: npm run build");
    process.exitCode = 2;
    return;
  }
  const home = mkdtempSync(path.join(os.tmpdir(), "osseo-smoke-"));
  const config = path.join(home, "config.json");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, overlay: { mode: "off" }, autoInstallDependencies: false }));
  // No display: the desktop tools are not part of W1, and a Linux display must not leak in.
  const env = { ...process.env, OSSEO_HOME: home, OSSEO_CONFIG: config };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const server = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  console.log(`Osseo headless check on ${process.platform} ${process.arch}, Node ${process.version}`);
  try {
    const mcp = client(server);
    const init = await mcp.initialize();
    if (init.result?.serverInfo?.name !== undefined) record("PASS", "server starts and answers initialize", `${init.result.serverInfo.name} ${init.result.serverInfo.version ?? ""}`.trim());
    else record("FAIL", "server starts and answers initialize", stderr.slice(-200));

    const tools = await mcp.list();
    if (tools.length >= 60) record("PASS", "tools are registered", `${tools.length} tools`);
    else record("FAIL", "tools are registered", `${tools.length} tools`);

    const info = await mcp.call("system.get_info", {});
    if (info.ok && info.data?.platform === process.platform) record("PASS", "system.get_info reports this platform", info.data.platform);
    else record("FAIL", "system.get_info reports this platform", info.error?.code ?? "");

    const agent = await mcp.call("agent.status", {});
    if (agent.ok && typeof agent.serverVersion === "string") record("PASS", "agent.status carries provenance", `version ${agent.serverVersion}`);
    else record("FAIL", "agent.status carries provenance", agent.error?.code ?? "");

    const written = path.join(home, "smoke.txt");
    const write = await mcp.call("file.write", { path: written, content: "hello from the smoke check" });
    if (write.ok) {
      const read = await mcp.call("file.read", { path: written });
      if (read.ok && String(read.data?.content ?? "").includes("hello from the smoke check")) record("PASS", "files: write and read back inside Osseo home");
      else record("FAIL", "files: write and read back inside Osseo home", read.error?.code ?? "content differs");
    } else if (write.error?.code === "approval_required") {
      record("NOTE", "files: write inside Osseo home asks for approval under this policy");
    } else {
      record("FAIL", "files: write inside Osseo home", write.error?.code ?? "");
    }

    const systemFile = WINDOWS
      ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
      : "/etc/hosts";
    const system = await mcp.call("file.read", { path: systemFile });
    if (expectBlocked(system) || system.ok === false) record("PASS", "protected system file is refused or needs approval", system.error?.code ?? "");
    else record("FAIL", "protected system file is refused or needs approval", "read without a check");

    const credential = path.join(os.homedir(), ".ssh", "id_rsa");
    const secret = await mcp.call("file.read", { path: credential });
    if (expectBlocked(secret)) record("PASS", "credential folder (.ssh) is blocked", secret.error?.code ?? "");
    else record("FAIL", "credential folder (.ssh) is blocked", secret.error?.code ?? "read without a check");

    const harmless = WINDOWS
      ? { command: "where.exe", args: ["node"] }
      : { command: "which", args: ["node"] };
    const looked = await mcp.call("shell.run", harmless);
    if (looked.ok) record("PASS", "shell: a harmless lookup runs", `exit ${looked.data?.exitCode ?? "?"}`);
    else if (looked.error?.code === "approval_required") record("NOTE", "shell: a harmless lookup asks for approval under this policy");
    else record("FAIL", "shell: a harmless lookup runs", looked.error?.code ?? "");

    const wrapper = WINDOWS
      ? { command: "powershell.exe", args: ["-NoProfile", "-Command", "Get-Date"] }
      : { command: "sh", args: ["-c", "date"] };
    const wrapped = await mcp.call("shell.run", wrapper);
    if (expectBlocked(wrapped)) record("PASS", "shell: a PowerShell/sh wrapper asks first and is not run", wrapped.error?.code ?? "");
    else record("FAIL", "shell: a PowerShell/sh wrapper asks first and is not run", wrapped.error?.code ?? "ran");

    const destructive = WINDOWS
      ? { command: "del", args: [path.join(home, "nothing.txt")] }
      : { command: "rm", args: ["-rf", path.join(home, "nothing")] };
    const deleted = await mcp.call("shell.run", destructive);
    if (expectBlocked(deleted)) record("PASS", "shell: a delete asks first and is not run", deleted.error?.code ?? "");
    else record("FAIL", "shell: a delete asks first and is not run", deleted.error?.code ?? "ran");

    const page = path.join(home, "smoke.html");
    writeFileSync(page, "<!doctype html><title>smoke</title><p>smoke</p>");
    const opened = await mcp.call("browser.open", { url: pathToFileURL(page).toString(), headless: true });
    if (opened.ok) {
      record("PASS", "browser: headless Chrome or Edge opens a page");
      await mcp.call("browser.close", {});
    } else if (String(opened.observations?.join(" ") ?? opened.error?.message ?? "").includes("No Chrome")) {
      record("SKIP", "browser: no Chrome or Edge installed", "install Chrome or Edge to check browser.*");
    } else {
      record("FAIL", "browser: headless Chrome or Edge opens a page", opened.error?.code ?? opened.error?.message ?? "");
    }

    const created = await mcp.call("task.create", { goal: "windows smoke check" });
    const taskId = created.data?.id ?? created.data?.taskId;
    const status = taskId === undefined ? undefined : await mcp.call("task.status", { taskId });
    if (created.ok && status?.ok) record("PASS", "tasks: create and read back", taskId);
    else record("FAIL", "tasks: create and read back", created.error?.code ?? status?.error?.code ?? "no task id");
  } finally {
    server.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`\nSummary: ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.NOTE} notes, ${counts.SKIP} skipped`);
  process.exitCode = counts.FAIL === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`FAIL  harness error: ${error.message}`);
  process.exitCode = 1;
});
