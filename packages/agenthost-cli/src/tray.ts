import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/*
 * `agenthost tray start|stop|status`: a status-notifier tray icon (tray.py)
 * that shows the agent's state and offers Stop, Pause, Resume and Open viewer.
 * `start` launches it detached and writes run/tray.pid (0600). `stop` asks the
 * process to quit (SIGTERM); the tray removes its own PID file on exit, and a
 * stale file is removed here. The tray never writes into the agent home.
 */

type Output = { ok: boolean; command: string; data?: unknown; error?: string; warnings?: string[] };

export interface TraySpawned { pid?: number | undefined; unref(): void }
export interface TrayDeps {
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => TraySpawned;
  processAlive?: (pid: number) => boolean;
  /** Ends a process (SIGTERM). */
  killProcess?: (pid: number) => void;
  /** Path of tray.py. */
  scriptPath?: string;
  node?: string;
  entry?: string;
  env?: NodeJS.ProcessEnv;
}

interface PidRecord { pid: number; startedAt: string }

const pidPath = (agentHome: string): string => path.join(agentHome, "run", "tray.pid");

function fail(command: string, error: string): Output { return { ok: false, command, error }; }

function defaultAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function defaultKill(pid: number): void { process.kill(pid, "SIGTERM"); }

function defaultSpawn(command: string, args: string[], env: NodeJS.ProcessEnv): TraySpawned {
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false, env });
  child.on("error", () => undefined);
  return child;
}

async function readPid(agentHome: string): Promise<PidRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(pidPath(agentHome), "utf8")) as Partial<PidRecord>;
    if (typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0) return value as PidRecord;
  } catch { /* Missing or damaged: treated as not running. */ }
  return undefined;
}

async function writePid(agentHome: string, record: PidRecord): Promise<void> {
  const directory = path.dirname(pidPath(agentHome));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${pidPath(agentHome)}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, pidPath(agentHome));
}

/** The running tray, or undefined. A PID file whose process is gone is removed. */
async function runningTray(agentHome: string, alive: (pid: number) => boolean): Promise<PidRecord | undefined> {
  const record = await readPid(agentHome);
  if (record !== undefined && alive(record.pid)) return record;
  await rm(pidPath(agentHome), { force: true });
  return undefined;
}

export async function trayCommand(args: string[], agentHome: string, deps: TrayDeps = {}): Promise<Output> {
  const action = args.find((item) => !item.startsWith("--"));
  const alive = deps.processAlive ?? defaultAlive;

  if (action === "start") {
    const existing = await runningTray(agentHome, alive);
    if (existing !== undefined) return fail("tray start", `tray_already_running (pid ${existing.pid}); stop it with: agenthost tray stop`);
    const script = deps.scriptPath ?? fileURLToPath(new URL("../../app-overlay/runtime/tray.py", import.meta.url));
    const node = deps.node ?? process.execPath;
    const entry = deps.entry ?? process.argv[1] ?? "";
    const spawnProcess = deps.spawnProcess ?? defaultSpawn;
    // The icon goes on the person's own session bus, so it inherits the caller's environment.
    const tray = spawnProcess("python3", [script, "--agent-home", agentHome, "--node", node, "--entry", entry], deps.env ?? process.env);
    if (tray.pid === undefined) return fail("tray start", "tray_spawn_failed");
    tray.unref();
    await writePid(agentHome, { pid: tray.pid, startedAt: new Date().toISOString() });
    return { ok: true, command: "tray start", data: { running: true, pid: tray.pid } };
  }

  if (action === "stop") {
    const record = await runningTray(agentHome, alive);
    if (record === undefined) return { ok: true, command: "tray stop", data: { running: false, stopped: false } };
    try { (deps.killProcess ?? defaultKill)(record.pid); } catch { /* Already gone. */ }
    await rm(pidPath(agentHome), { force: true });
    return { ok: true, command: "tray stop", data: { running: false, stopped: true, pid: record.pid } };
  }

  if (action === "status") {
    const record = await runningTray(agentHome, alive);
    return { ok: true, command: "tray status", data: record === undefined ? { running: false } : { running: true, pid: record.pid, startedAt: record.startedAt } };
  }

  return fail("tray", "usage: agenthost tray start | stop | status");
}
