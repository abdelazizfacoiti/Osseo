import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostCommand, hostDoctorLine } from "../host.js";

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

describe("osseo host", () => {
  it("reports not running", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "ah-cli-"));
    const out = await hostCommand(["status"], home);
    expect(out).toMatchObject({ ok: true, command: "host status", data: { running: false } });
  });

  it("reports pid, socket and sessions of a running host", async () => {
    await fakeHost((m, socket) => socket.write(`${JSON.stringify(m.ping === true ? { pong: true, protocol: 1, pid: 4242, uptimeMs: 5 } : { status: { pid: 4242, sessions: 2, leaseHolder: null } })}\n`));
    const out = await hostCommand(["status"], home);
    expect(out).toMatchObject({ ok: true, data: { running: true, pid: 4242, sessions: 2 } });
    expect((out.data as any).socket).toBe(path.join(home, "run", "host.sock"));
  });

  it("start refuses when a host is running", async () => {
    await fakeHost((_m, socket) => socket.write(`${JSON.stringify({ status: { pid: 4242, sessions: 0 } })}\n`));
    const out = await hostCommand(["start"], home);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/^osseo_host_running/);
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

  it("status reports running only when the ping answers", async () => {
    await fakeHost((_m, socket) => socket.write(`${JSON.stringify({ error: { code: "hello_required" } })}\n`));
    const out = await hostCommand(["status"], home);
    expect(out).toMatchObject({ ok: true, data: { running: false } });
    expect((out.data as any).note).toMatch(/ping/);
  });
});

const pong = (pid: number) => ({ pong: true, protocol: 1, pid, uptimeMs: 7 });
const noSleep = { startWaitMs: 3000, stopWaitMs: 2000 };

/** A fake host process: "spawning" it opens the socket after a delay. */
function makeSpawner(): { spawnHost: () => number; count: () => number; servers: net.Server[]; stopAll: () => void } {
  let spawned = 0;
  const servers: net.Server[] = [];
  const spawnHost = (): number => {
    spawned += 1;
    const pid = 5000 + spawned;
    setTimeout(() => {
      const sock = path.join(home, "run", "host.sock");
      rmSync(sock, { force: true });
      const srv = net.createServer((socket) => {
        socket.on("error", () => undefined);
        socket.setEncoding("utf8");
        socket.on("data", (c: string) => {
          const m = JSON.parse(c.split("\n")[0]!);
          if (m.ping) socket.write(`${JSON.stringify(pong(pid))}\n`);
          else if (m.shutdown) { socket.write('{"shutdown":{"ok":true}}\n'); setTimeout(() => srv.close(), 20); }
          else socket.write(`${JSON.stringify({ status: { pid, sessions: 0 } })}\n`);
        });
      });
      servers.push(srv);
      srv.listen(sock);
      writeFileSync(path.join(home, "run", "host.pid"), `${pid}\n`);
    }, 150);
    return pid;
  };
  return { spawnHost, count: () => spawned, servers, stopAll: () => servers.forEach((x) => x.close()) };
}
function emptyHome(): string {
  home = mkdtempSync(path.join(os.tmpdir(), "ah-cli-"));
  mkdirSync(path.join(home, "run"), { recursive: true });
  return home;
}
const entry = (): string => { const f = path.join(home, "main.js"); writeFileSync(f, ""); return f; };

describe("host start lock", () => {
  it("two concurrent starts give one host", async () => {
    emptyHome();
    const sp = makeSpawner();
    const deps = { hostEntry: entry(), spawnHost: sp.spawnHost, ...noSleep };
    const [a, b] = await Promise.all([hostCommand(["start"], home, deps), hostCommand(["start"], home, deps)]);
    expect(sp.count()).toBe(1);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a, b].find((x) => !x.ok)?.error).toMatch(/osseo_host_running/);
    expect(existsSync(path.join(home, "run", "host.lock"))).toBe(false);
    sp.stopAll();
  });

  it("a live lock refuses the start; a stale lock is recovered", async () => {
    emptyHome();
    const sp = makeSpawner();
    const lock = path.join(home, "run", "host.lock");
    writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
    const refused = await hostCommand(["start"], home, { hostEntry: entry(), spawnHost: sp.spawnHost, startWaitMs: 400 });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/host_start_in_progress/);
    expect(sp.count()).toBe(0);
    writeFileSync(lock, `999999999 ${Date.now() - 60_000}\n`);
    const ok = await hostCommand(["start"], home, { hostEntry: entry(), spawnHost: sp.spawnHost, isAlive: () => false, ...noSleep });
    expect(ok.ok).toBe(true);
    expect(sp.count()).toBe(1);
    expect(existsSync(lock)).toBe(false);
    sp.stopAll();
  });

  it("a fresh lock of a dead pid is still held; the lock is removed on failure", async () => {
    emptyHome();
    const lock = path.join(home, "run", "host.lock");
    writeFileSync(lock, `999999999 ${Date.now()}\n`);
    expect((await hostDoctorLine(home, { isAlive: () => false })).state).toBe("lock_held");
    rmSync(lock);
    const timedOut = await hostCommand(["start"], home, { hostEntry: entry(), spawnHost: () => undefined, startWaitMs: 300 });
    expect(timedOut.error).toMatch(/host_start_timeout/);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("host restart", () => {
  it("stops the old host and starts a new one", async () => {
    emptyHome();
    const sp = makeSpawner();
    const deps = { hostEntry: entry(), spawnHost: sp.spawnHost, ...noSleep };
    expect((await hostCommand(["start"], home, deps)).ok).toBe(true);
    const out = await hostCommand(["restart"], home, deps);
    expect(out).toMatchObject({ ok: true, command: "host restart", data: { restarted: true, stopped: { stopped: true, via: "socket" } } });
    expect(sp.count()).toBe(2);
    expect((await hostCommand(["status"], home)).data).toMatchObject({ running: true, pid: 5002 });
    sp.stopAll();
  });

  it("refuses when the stop leaves a live host", async () => {
    await fakeHost((m, socket) => socket.write(`${JSON.stringify(m.ping ? pong(4242) : { status: { pid: 4242 } })}\n`));
    const sp = makeSpawner();
    const out = await hostCommand(["restart"], home, { hostEntry: entry(), spawnHost: sp.spawnHost, stopWaitMs: 300, readCmdline: async () => "node other" });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/restart_refused/);
    expect(sp.count()).toBe(0);
  });
});

describe("hostDoctorLine", () => {
  const boom = { spawnHost: () => { throw new Error("must not spawn"); } };
  it("reports each state and never spawns", async () => {
    emptyHome();
    expect((await hostDoctorLine(home, boom)).state).toBe("not_running");
    // stale socket: a file nobody listens on
    const sock = path.join(home, "run", "host.sock");
    const dead = net.createServer(); await new Promise<void>((r) => dead.listen(sock, r));
    await new Promise<void>((r) => dead.close(() => r()));
    writeFileSync(sock, "");
    expect((await hostDoctorLine(home, boom)).state).toBe("stale_socket");
    writeFileSync(path.join(home, "run", "host.lock"), `${process.pid} ${Date.now()}\n`);
    expect((await hostDoctorLine(home, boom)).state).toBe("lock_held");
    rmSync(path.join(home, "run", "host.lock")); rmSync(sock, { force: true });
    server = net.createServer((s) => { s.on("error", () => undefined); s.on("data", () => s.write(`${JSON.stringify(pong(77))}\n`)); });
    await new Promise<void>((r) => server!.listen(sock, r));
    const line = await hostDoctorLine(home, boom);
    expect(line.state).toBe("running");
    expect(line.detail).toMatch(/pid 77/);
  });
});
