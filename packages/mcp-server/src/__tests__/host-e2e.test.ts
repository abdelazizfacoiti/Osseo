import { describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Runs the built server and host, so `npm run build` must come first. Headless, temp home.
const ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const HOST = fileURLToPath(new URL("../../dist/host/main.js", import.meta.url));
const built = existsSync(ENTRY) && existsSync(HOST);

function env(home: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_HOST: "1", NODE_ENV: "test" };
  delete e.DISPLAY; delete e.WAYLAND_DISPLAY;
  return e;
}

class Shim {
  readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private lines: any[] = [];
  exit: Promise<number | null>;
  constructor(home: string) {
    this.child = spawn(process.execPath, [ENTRY], { env: { ...env(home), AGENTHOST_CLIENT: "e2e" }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (c: Buffer) => { this.buffer += c.toString(); let i: number; while ((i = this.buffer.indexOf("\n")) >= 0) { this.lines.push(JSON.parse(this.buffer.slice(0, i))); this.buffer = this.buffer.slice(i + 1); } });
    this.exit = new Promise((r) => this.child.once("exit", (code) => r(code)));
  }
  send(m: unknown): void { this.child.stdin.write(`${JSON.stringify(m)}\n`); }
  async reply(id: number, ms = 20_000): Promise<any> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const found = this.lines.find((l) => l.id === id);
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no reply to ${id}`);
  }
  async init(): Promise<void> {
    this.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
    await this.reply(1);
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
}

describe.skipIf(!built)("host end to end", () => {
  it("serves two shims in parallel and reports the disconnect after the host stops", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ah-e2e-"));
    const shims: Shim[] = [];
    try {
      const a = new Shim(home); const b = new Shim(home);
      shims.push(a, b);
      await Promise.all([a.init(), b.init()]);
      const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent.status", arguments: {} } };
      a.send(call); b.send(call);
      const [ra, rb] = await Promise.all([a.reply(2), b.reply(2)]);
      expect(ra.error).toBeUndefined();
      expect(rb.error).toBeUndefined();
      expect(ra.result?.content?.length).toBeGreaterThan(0);

      // Stop the host through its socket, then call again.
      const reply: string = await new Promise((resolve) => {
        const s = net.connect(path.join(home, "run", "host.sock"));
        s.setEncoding("utf8");
        s.once("connect", () => s.write('{"shutdown":true}\n'));
        s.once("data", (d: string) => { s.destroy(); resolve(d); });
        s.once("error", () => resolve("error"));
      });
      expect(reply).toContain('"ok":true');
      await new Promise((r) => setTimeout(r, 500));
      a.send({ ...call, id: 3 });
      const late = await a.reply(3);
      expect(late.error?.data?.code).toBe("host_disconnected");
      expect(await a.exit).toBe(1);
    } finally {
      for (const s of shims) s.child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
