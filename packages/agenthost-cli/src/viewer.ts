import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { captureDisplayFrame, isValidDisplay } from "@agenthost/os-linux";
import { parseFlags } from "./flags.js";

/*
 * `agenthost viewer start|stop|status`: the small window that shows the
 * agent's background display. `start` launches the GTK window (viewer.py) and a
 * frame loop (`viewer frames`, internal) as detached processes. `stop` only
 * writes run/viewer.stop; both processes watch for it and exit. The window
 * never writes into the agent home; the PID file is written and removed here.
 */

type Output = { ok: boolean; command: string; data?: unknown; error?: string; warnings?: string[] };

export interface SpawnedProcess { pid?: number | undefined; unref(): void }
export interface ViewerDeps {
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => SpawnedProcess;
  processAlive?: (pid: number) => boolean;
  /** Path of viewer.py. */
  scriptPath?: string;
  /** Node and CLI entry used for the buttons and the frame loop. */
  node?: string;
  entry?: string;
  env?: NodeJS.ProcessEnv;
}

interface PidRecord { pid: number; framesPid?: number; display: string; startedAt: string }

const runDir = (agentHome: string): string => path.join(agentHome, "run");
const pidPath = (agentHome: string): string => path.join(runDir(agentHome), "viewer.pid");
const stopPath = (agentHome: string): string => path.join(runDir(agentHome), "viewer.stop");
const framesDir = (agentHome: string): string => path.join(runDir(agentHome), "viewer");

function fail(command: string, error: string): Output { return { ok: false, command, error }; }

function defaultAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function defaultSpawn(command: string, args: string[], env: NodeJS.ProcessEnv): SpawnedProcess {
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false, env });
  child.on("error", () => undefined);
  return child;
}

async function ensureRunDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function readPid(agentHome: string): Promise<PidRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(pidPath(agentHome), "utf8")) as Partial<PidRecord>;
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 && typeof value.display === "string") return value as PidRecord;
  } catch { /* Missing or damaged: treated as not running. */ }
  return undefined;
}

async function writePid(agentHome: string, record: PidRecord): Promise<void> {
  await ensureRunDir(runDir(agentHome));
  const temporary = `${pidPath(agentHome)}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, pidPath(agentHome));
}

/** The running viewer, or undefined. A PID file whose process is gone is removed. */
async function runningViewer(agentHome: string, alive: (pid: number) => boolean): Promise<PidRecord | undefined> {
  const record = await readPid(agentHome);
  if (record === undefined) { await rm(pidPath(agentHome), { force: true }); return undefined; }
  if (alive(record.pid)) return record;
  await rm(pidPath(agentHome), { force: true });
  return undefined;
}

/** The background display the server started, if it wrote run/background-display.json ({ display }). */
async function recordedDisplay(agentHome: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(runDir(agentHome), "background-display.json"), "utf8")) as { display?: unknown };
    return typeof value.display === "string" ? value.display : undefined;
  } catch { return undefined; }
}

export async function viewerCommand(args: string[], agentHome: string, deps: ViewerDeps = {}): Promise<Output> {
  const parsed = parseFlags(args);
  const action = parsed.positional[0];
  const alive = deps.processAlive ?? defaultAlive;

  if (action === "start") {
    const existing = await runningViewer(agentHome, alive);
    if (existing !== undefined) return fail("viewer start", `viewer_already_running (pid ${existing.pid}); stop it with: agenthost viewer stop`);
    const display = parsed.values.get("display") ?? (await recordedDisplay(agentHome));
    if (display === undefined) return fail("viewer start", "no_display: pass --display :N (the server does not record its background display yet)");
    if (!isValidDisplay(display)) return fail("viewer start", "bad_display: use a value like :90");
    const script = deps.scriptPath ?? fileURLToPath(new URL("../../app-overlay/runtime/viewer.py", import.meta.url));
    const node = deps.node ?? process.execPath;
    const entry = deps.entry ?? process.argv[1] ?? "";
    const spawnProcess = deps.spawnProcess ?? defaultSpawn;
    await ensureRunDir(framesDir(agentHome));
    await rm(stopPath(agentHome), { force: true });
    const frame = path.join(framesDir(agentHome), "frame.png");
    // The window opens on the person's own display, so it inherits the caller's environment.
    const viewer = spawnProcess("python3", [script, "--frame", frame, "--agent-home", agentHome, "--node", node, "--entry", entry], deps.env ?? process.env);
    if (viewer.pid === undefined) return fail("viewer start", "viewer_spawn_failed");
    viewer.unref();
    const frames = spawnProcess(node, [entry, "viewer", "frames", "--display", display, "--viewer-pid", String(viewer.pid)], deps.env ?? process.env);
    frames.unref();
    await writePid(agentHome, { pid: viewer.pid, ...(frames.pid === undefined ? {} : { framesPid: frames.pid }), display, startedAt: new Date().toISOString() });
    return { ok: true, command: "viewer start", data: { running: true, pid: viewer.pid, display } };
  }

  if (action === "stop") {
    await ensureRunDir(runDir(agentHome));
    await writeFile(stopPath(agentHome), `${JSON.stringify({ at: new Date().toISOString() })}\n`, { encoding: "utf8", mode: 0o600 });
    return { ok: true, command: "viewer stop", data: { stopRequested: true } };
  }

  if (action === "status") {
    const record = await runningViewer(agentHome, alive);
    return { ok: true, command: "viewer status", data: record === undefined ? { running: false } : { running: true, pid: record.pid, display: record.display, startedAt: record.startedAt } };
  }

  if (action === "frames") return await frameLoop(agentHome, parsed.values.get("display"), Number(parsed.values.get("viewer-pid")), alive);

  return fail("viewer", "usage: agenthost viewer start [--display :N] | stop | status");
}

/**
 * Internal: capture the display about twice a second into run/viewer/frame.png
 * until the window is gone or run/viewer.stop appears; then remove the PID file.
 */
async function frameLoop(agentHome: string, display: string | undefined, viewerPid: number, alive: (pid: number) => boolean): Promise<Output> {
  if (display === undefined || !isValidDisplay(display)) return fail("viewer frames", "bad_display");
  const { existsSync } = await import("node:fs");
  let failures = 0;
  while (!existsSync(stopPath(agentHome)) && (!Number.isInteger(viewerPid) || alive(viewerPid))) {
    const result = await captureDisplayFrame(display, { directory: framesDir(agentHome), timeoutMs: 3_000 });
    failures = result.ok ? 0 : failures + 1;
    if (failures >= 60) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const record = await readPid(agentHome);
  if (record !== undefined && record.pid === viewerPid) await rm(pidPath(agentHome), { force: true });
  await rm(path.join(framesDir(agentHome), "frame.png"), { force: true });
  return { ok: true, command: "viewer frames", data: { ended: true } };
}
