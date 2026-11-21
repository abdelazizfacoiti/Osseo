#!/usr/bin/env node
/**
 * Starts the built MCP server once per tool profile and prints how many tools tools/list returns
 * and how many bytes the reply is. Needs `npm run build` first. No display, no windows.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "packages", "mcp-server", "dist", "index.js");
if (!existsSync(SERVER)) {
  console.error("Built MCP server not found. Run `npm run build` first.");
  process.exit(1);
}

function measure(profile) {
  const home = mkdtempSync(path.join(os.tmpdir(), "osseo-measure-"));
  const env = { ...process.env, OSSEO_HOME: home, OSSEO_CONFIG: path.join(home, "none.json"), OSSEO_TOOLS_PROFILE: profile, OSSEO_OVERLAY_MODE: "disabled", NODE_ENV: "test" };
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const timer = setTimeout(() => { server.kill(); reject(new Error(`timeout (${profile})`)); }, 30_000);
    server.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        if (message.id === 1) {
          server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        } else if (message.id === 2) {
          clearTimeout(timer);
          server.stdin.end();
          rmSync(home, { recursive: true, force: true });
          resolve({ profile, tools: message.result.tools.length, bytes: Buffer.byteLength(line, "utf8") });
        }
      }
    });
    server.on("error", reject);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "measure-tools", version: "1" } } })}\n`);
  });
}

for (const profile of ["desktop", "full"]) {
  const result = await measure(profile);
  console.log(`${result.profile.padEnd(8)} ${String(result.tools).padStart(3)} tools  ${String(result.bytes).padStart(6)} bytes`);
}
