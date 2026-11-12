import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHost, type RunningHost } from "../host/host.js";
import { hostPaths, probeSocket, ensureRunDir } from "../host/socket.js";

const homes: string[] = [];
const hosts: RunningHost[] = [];
function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "ah-host-"));
  homes.push(home);
  return home;
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const fakeSession = async (): Promise<{ close(): Promise<void>; isStateChanging(): boolean }> => ({ close: async () => undefined, isStateChanging: () => false });

describe("host socket", () => {
  it("removes a stale socket and starts", async () => {
    const home = tempHome();
    const paths = await ensureRunDir(home);
    // A socket file with no listener: bind, then kill the server without unlinking.
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(paths.socket, r));
    // closing unlinks on most platforms; recreate a plain file to stand in for a leftover.
    await new Promise<void>((r) => dead.close(() => r()));
    if (!existsSync(paths.socket)) writeFileSync(paths.socket, "");
    expect(await probeSocket(paths.socket)).toBe("stale");
    const host = await startHost({ agentHome: home, createSession: fakeSession });
    hosts.push(host);
    expect(await probeSocket(paths.socket)).toBe("live");
  });

  it("refuses a second host while one is live", async () => {
    const home = tempHome();
    hosts.push(await startHost({ agentHome: home, createSession: fakeSession }));
    await expect(startHost({ agentHome: home, createSession: fakeSession })).rejects.toMatchObject({ code: "agenthost_host_running", pid: process.pid });
    // The first host is still serving.
    expect(await probeSocket(hostPaths(home).socket)).toBe("live");
  });

  it("uses private modes and removes its files on close", async () => {
    const home = tempHome();
    const host = await startHost({ agentHome: home, createSession: fakeSession });
    const paths = hostPaths(home);
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
    expect(statSync(paths.pid).mode & 0o777).toBe(0o600);
    expect(statSync(paths.runDir).mode & 0o777).toBe(0o700);
    await host.close();
    expect(existsSync(paths.socket)).toBe(false);
    expect(existsSync(paths.pid)).toBe(false);
  });

  it("exits after the idle time with no connections and no running task", async () => {
    const home = tempHome();
    const host = await startHost({ agentHome: home, createSession: fakeSession, idleExitMs: 120, idleCheckMs: 30, hasRunningTask: async () => false });
    await expect(host.closed).resolves.toBe("idle");
  });

  it("does not exit while a task is running", async () => {
    const home = tempHome();
    const host = await startHost({ agentHome: home, createSession: fakeSession, idleExitMs: 60, idleCheckMs: 20, hasRunningTask: async () => true });
    hosts.push(host);
    const winner = await Promise.race([host.closed, new Promise((r) => setTimeout(() => r("still"), 400))]);
    expect(winner).toBe("still");
  });
});
