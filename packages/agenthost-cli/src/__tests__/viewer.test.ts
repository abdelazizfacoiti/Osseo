import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findXephyr, startBackgroundDisplay } from "@agenthost/os-linux";
import { viewerCommand, type ViewerDeps } from "../viewer.js";

const home = () => mkdtempSync(path.join(os.tmpdir(), "agenthost-viewer-"));
function stub(alive = true) {
  let next = 4000;
  const calls: Array<{ command: string; args: string[] }> = [];
  const deps: ViewerDeps = {
    spawnProcess: vi.fn((command: string, args: string[]) => { calls.push({ command, args }); return { pid: next++, unref: () => undefined }; }),
    processAlive: () => alive,
    scriptPath: "/x/viewer.py", node: "/usr/bin/node", entry: "/x/index.js", env: {}
  };
  return { deps, calls };
}

describe("agenthost viewer", () => {
  it("status says not running without a PID file", async () => {
    const result = await viewerCommand(["status"], home(), stub().deps);
    expect(result).toEqual({ ok: true, command: "viewer status", data: { running: false } });
  });

  it("start spawns a viewer and a frame loop with fixed arguments and writes a 0600 PID file", async () => {
    const agentHome = home();
    const { deps, calls } = stub();
    const result = await viewerCommand(["start", "--display", ":90"], agentHome, deps);
    expect(result).toMatchObject({ ok: true, data: { running: true, pid: 4000, display: ":90" } });
    expect(calls[0]!.command).toBe("python3");
    expect(calls[0]!.args.slice(0, 1)).toEqual(["/x/viewer.py"]);
    expect(calls[1]!.args).toEqual(["/x/index.js", "viewer", "frames", "--display", ":90", "--viewer-pid", "4000"]);
    const pidFile = path.join(agentHome, "run", "viewer.pid");
    expect(statSync(pidFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(pidFile, "utf8"))).toMatchObject({ pid: 4000, display: ":90" });
    expect(await viewerCommand(["status"], agentHome, deps)).toMatchObject({ data: { running: true, pid: 4000 } });
  });

  it("refuses to start twice", async () => {
    const agentHome = home();
    const { deps } = stub();
    await viewerCommand(["start", "--display", ":90"], agentHome, deps);
    const again = await viewerCommand(["start", "--display", ":90"], agentHome, deps);
    expect(again.ok).toBe(false);
    expect(again.error).toContain("viewer_already_running");
    expect(deps.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("removes a PID file whose process is gone and then starts again", async () => {
    const agentHome = home();
    await viewerCommand(["start", "--display", ":90"], agentHome, stub().deps);
    const gone = stub(false).deps;
    expect(await viewerCommand(["status"], agentHome, gone)).toMatchObject({ data: { running: false } });
    expect(existsSync(path.join(agentHome, "run", "viewer.pid"))).toBe(false);
    expect((await viewerCommand(["start", "--display", ":91"], agentHome, stub().deps)).ok).toBe(true);
  });

  it("needs a display and rejects a bad one without spawning", async () => {
    const { deps } = stub();
    expect((await viewerCommand(["start"], home(), deps)).error).toContain("no_display");
    expect((await viewerCommand(["start", "--display", ":1;ls"], home(), deps)).error).toContain("bad_display");
    expect(deps.spawnProcess).not.toHaveBeenCalled();
  });

  it("reads the display from run/background-display.json when present", async () => {
    const agentHome = home();
    mkdirSync(path.join(agentHome, "run"), { recursive: true });
    writeFileSync(path.join(agentHome, "run", "background-display.json"), JSON.stringify({ display: ":93" }));
    expect(await viewerCommand(["start"], agentHome, stub().deps)).toMatchObject({ ok: true, data: { display: ":93" } });
  });

  it("stop writes the stop file and nothing else", async () => {
    const agentHome = home();
    const result = await viewerCommand(["stop"], agentHome, stub().deps);
    expect(result).toMatchObject({ ok: true, data: { stopRequested: true } });
    expect(readdirSync(path.join(agentHome, "run"))).toEqual(["viewer.stop"]);
    expect(readdirSync(agentHome)).toEqual(["run"]);
  });

  it("start clears an old stop file", async () => {
    const agentHome = home();
    await viewerCommand(["stop"], agentHome, stub().deps);
    await viewerCommand(["start", "--display", ":90"], agentHome, stub().deps);
    expect(existsSync(path.join(agentHome, "run", "viewer.stop"))).toBe(false);
  });

  it("shows usage for an unknown subcommand", async () => {
    expect((await viewerCommand(["bogus"], home(), stub().deps)).ok).toBe(false);
  });
});

const script = fileURLToPath(new URL("../../../app-overlay/runtime/viewer.py", import.meta.url));
function has(command: string, args: string[]): boolean { try { execFileSync(command, args, { stdio: "ignore" }); return true; } catch { return false; } }
const nestedAvailable = findXephyr() !== undefined && Boolean(process.env.DISPLAY) && has("python3", ["-c", "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk"]);

describe("viewer.py", () => {
  it.skipIf(!has("python3", ["--version"]))("compiles", () => {
    execFileSync("python3", ["-m", "py_compile", script], { stdio: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPYCACHEPREFIX: mkdtempSync(path.join(os.tmpdir(), "pyc-")) } });
  });

  describe.skipIf(!nestedAvailable)("on a nested display", () => {
    let nested: Extract<Awaited<ReturnType<typeof startBackgroundDisplay>>, { ok: true }>;
    beforeAll(async () => {
      const started = await startBackgroundDisplay({ width: 800, height: 600, firstDisplay: 117 });
      if (!started.ok) throw new Error(started.reason);
      nested = started;
    }, 30_000);
    afterAll(async () => { await nested?.stop(); });

    const selftest = (agentHome: string, frame: string) => JSON.parse(execFileSync("python3", ["-I", script, "--frame", frame, "--agent-home", agentHome, "--selftest"], { env: { ...nested.env, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8", timeout: 20_000 }).trim().split("\n").pop()!);

    it("builds the window and reads the status from the run-state files", () => {
      const agentHome = home();
      const run = path.join(agentHome, "run");
      mkdirSync(run, { recursive: true });
      const frame = path.join(run, "frame.png");
      expect(selftest(agentHome, frame)).toEqual({ title: "AgentHost background view", status: "Waiting for the first picture", buttons: ["pause", "resume", "stop"], hasFrame: false });
      writeFileSync(path.join(run, "pause.requested"), "{}");
      expect(selftest(agentHome, frame).status).toBe("Paused");
      writeFileSync(path.join(run, "takeover.active"), "{}");
      expect(selftest(agentHome, frame).status).toBe("Waiting for you");
      writeFileSync(path.join(run, "stop.requested"), "{}");
      expect(selftest(agentHome, frame).status).toBe("Stopped");
      expect(readdirSync(run).sort()).toEqual(["pause.requested", "stop.requested", "takeover.active"]);
    }, 60_000);
  });
});
