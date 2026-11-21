import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { trayCommand, type TrayDeps } from "../tray.js";

const home = () => mkdtempSync(path.join(os.tmpdir(), "osseo-tray-"));
function stub(alive = true) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const killed: number[] = [];
  const deps: TrayDeps = {
    spawnProcess: vi.fn((command: string, args: string[]) => { calls.push({ command, args }); return { pid: 5000, unref: () => undefined }; }),
    processAlive: () => alive,
    killProcess: (pid) => { killed.push(pid); },
    scriptPath: "/x/tray.py", node: "/usr/bin/node", entry: "/x/index.js", env: {}
  };
  return { deps, calls, killed };
}
const pidFile = (agentHome: string) => path.join(agentHome, "run", "tray.pid");

describe("osseo tray", () => {
  it("status reports not running without a PID file", async () => {
    expect(await trayCommand(["status"], home(), stub().deps)).toEqual({ ok: true, command: "tray status", data: { running: false } });
  });

  it("start spawns with fixed arguments and writes a 0600 PID file", async () => {
    const agentHome = home();
    const { deps, calls } = stub();
    const result = await trayCommand(["start"], agentHome, deps);
    expect(result).toMatchObject({ ok: true, data: { running: true, pid: 5000 } });
    expect(calls).toEqual([{ command: "python3", args: ["/x/tray.py", "--agent-home", agentHome, "--node", "/usr/bin/node", "--entry", "/x/index.js"] }]);
    expect(statSync(pidFile(agentHome)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pidFile(agentHome), "utf8"))).toMatchObject({ pid: 5000 });
    expect(await trayCommand(["status"], agentHome, deps)).toMatchObject({ data: { running: true, pid: 5000 } });
  });

  it("refuses a second start", async () => {
    const agentHome = home();
    const { deps } = stub();
    await trayCommand(["start"], agentHome, deps);
    const again = await trayCommand(["start"], agentHome, deps);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("tray_already_running");
    expect(deps.spawnProcess).toHaveBeenCalledTimes(1);
  });

  it("stop ends the process and removes the PID file", async () => {
    const agentHome = home();
    const { deps, killed } = stub();
    await trayCommand(["start"], agentHome, deps);
    const result = await trayCommand(["stop"], agentHome, deps);
    expect(result).toMatchObject({ ok: true, data: { stopped: true, pid: 5000 } });
    expect(killed).toEqual([5000]);
    expect(existsSync(pidFile(agentHome))).toBe(false);
  });

  it("stop without a tray does nothing", async () => {
    const { deps, killed } = stub();
    expect(await trayCommand(["stop"], home(), deps)).toMatchObject({ ok: true, data: { stopped: false } });
    expect(killed).toEqual([]);
  });

  it("removes a stale PID file and starts again", async () => {
    const agentHome = home();
    mkdirSync(path.join(agentHome, "run"), { recursive: true });
    writeFileSync(pidFile(agentHome), `${JSON.stringify({ pid: 999999, startedAt: "x" })}\n`);
    const { deps } = stub(false);
    expect(await trayCommand(["status"], agentHome, deps)).toMatchObject({ data: { running: false } });
    expect(existsSync(pidFile(agentHome))).toBe(false);
    writeFileSync(pidFile(agentHome), `${JSON.stringify({ pid: 999999, startedAt: "x" })}\n`);
    expect(await trayCommand(["start"], agentHome, deps)).toMatchObject({ ok: true });
  });

  it("fails when the spawn has no pid and writes no PID file", async () => {
    const agentHome = home();
    const { deps } = stub();
    deps.spawnProcess = () => ({ pid: undefined, unref: () => undefined });
    expect(await trayCommand(["start"], agentHome, deps)).toMatchObject({ ok: false, error: "tray_spawn_failed" });
    expect(existsSync(pidFile(agentHome))).toBe(false);
  });

  it("prints usage for an unknown action", async () => {
    expect((await trayCommand(["wat"], home(), stub().deps)).ok).toBe(false);
  });
});
