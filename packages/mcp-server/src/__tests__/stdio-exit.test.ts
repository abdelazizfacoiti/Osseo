import { describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs the built stdio server, so `npm run build` must come first (the repo's test order).
const SERVER = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

function startServer(home: string): ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = { ...process.env, OSSEO_HOME: home, NODE_ENV: "test" };
  // Headless on purpose: no display means no overlay renderer, and the test never touches the desktop.
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  return spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
}

function initialized(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("no initialize reply within 15 s")), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.split("\n").some((line) => line.includes('"id":1'))) return;
      clearTimeout(timer);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      resolve();
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "stdio-exit-test", version: "1" } } })}\n`);
  });
}

function exitWithin(child: ChildProcessWithoutNullStreams, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), ms);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("stdio server lifetime", () => {
  it("exits when the client closes stdin, so overlay cards cannot outlive the session", async () => {
    expect(existsSync(SERVER), "Build first: npm run build").toBe(true);
    const home = mkdtempSync(path.join(os.tmpdir(), "osseo-stdio-exit-"));
    const child = startServer(home);
    try {
      await initialized(child);
      child.stdin.end();
      const outcome = await exitWithin(child, 5_000);
      expect(outcome).not.toBe("timeout");
      expect(outcome).toEqual({ code: 0, signal: null });
    } finally {
      child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("exits on SIGHUP after cleanup, the way a closed terminal ends it", async () => {
    expect(existsSync(SERVER), "Build first: npm run build").toBe(true);
    const home = mkdtempSync(path.join(os.tmpdir(), "osseo-stdio-hup-"));
    const child = startServer(home);
    try {
      await initialized(child);
      child.kill("SIGHUP");
      const outcome = await exitWithin(child, 5_000);
      expect(outcome).not.toBe("timeout");
      expect(outcome).toEqual({ code: 129, signal: null });
    } finally {
      child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
