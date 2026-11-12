import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostCommand } from "../host.js";

let home = "";
let server: net.Server | undefined;
afterEach(() => { server?.close(); server = undefined; rmSync(home, { recursive: true, force: true }); });

async function fakeHost(handler: (message: any, socket: net.Socket) => void): Promise<void> {
  home = mkdtempSync(path.join(os.tmpdir(), "ah-cli-"));
  mkdirSync(path.join(home, "run"), { recursive: true });
  writeFileSync(path.join(home, "run", "host.pid"), "4242\n");
  server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (c: string) => { buffer += c; const i = buffer.indexOf("\n"); if (i >= 0) { handler(JSON.parse(buffer.slice(0, i)), socket); buffer = buffer.slice(i + 1); } });
  });
  await new Promise<void>((r) => server!.listen(path.join(home, "run", "host.sock"), r));
}

describe("agenthost host", () => {
  it("reports not running", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "ah-cli-"));
    const out = await hostCommand(["status"], home);
    expect(out).toMatchObject({ ok: true, command: "host status", data: { running: false } });
  });

  it("reports pid, socket and sessions of a running host", async () => {
    await fakeHost((_m, socket) => socket.write(`${JSON.stringify({ status: { pid: 4242, sessions: 2, leaseHolder: null } })}\n`));
    const out = await hostCommand(["status"], home);
    expect(out).toMatchObject({ ok: true, data: { running: true, pid: 4242, sessions: 2 } });
    expect((out.data as any).socket).toBe(path.join(home, "run", "host.sock"));
  });

  it("start refuses when a host is running", async () => {
    await fakeHost((_m, socket) => socket.write(`${JSON.stringify({ status: { pid: 4242, sessions: 0 } })}\n`));
    const out = await hostCommand(["start"], home);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^agenthost_host_running/);
  });

  it("stop sends a shutdown message and waits for the socket to go", async () => {
    await fakeHost((message, socket) => {
      if (message.shutdown === true) { socket.write(`${JSON.stringify({ shutdown: { ok: true } })}\n`); setTimeout(() => server!.close(), 20); }
      else socket.write(`${JSON.stringify({ status: { pid: 4242 } })}\n`);
    });
    const out = await hostCommand(["stop"], home, { stopWaitMs: 3000 });
    expect(out).toMatchObject({ ok: true, data: { stopped: true, via: "socket" } });
  });

  it("falls back to SIGTERM only when the pid's command line names the host", async () => {
    const handler = (_m: any, socket: net.Socket): void => { socket.write(`${JSON.stringify({ status: { pid: 4242 } })}\n`); };
    await fakeHost(handler);
    const killed: number[] = [];
    const refused = await hostCommand(["stop"], home, { stopWaitMs: 300, readCmdline: async () => "node /usr/bin/other", kill: (p) => { killed.push(p); } });
    expect(refused.ok).toBe(false);
    expect(killed).toEqual([]);
    const ok = await hostCommand(["stop"], home, { stopWaitMs: 300, readCmdline: async () => "node /x/dist/host/main.js", kill: (p) => { killed.push(p); } });
    expect(ok).toMatchObject({ ok: true, data: { via: "sigterm", pid: 4242 } });
    expect(killed).toEqual([4242]);
  });
});
