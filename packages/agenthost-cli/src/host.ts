import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * `agenthost host status|start|stop|restart`: the per-user host that AGENTHOST_HOST=1
 * MCP clients connect to. Paths match packages/mcp-server/src/host/socket.ts.
 */

type Output = { ok: boolean; command: string; data?: unknown; error?: string };

export interface HostDeps {
  /** Path of the host entry (mcp-server dist/host/main.js). */
  hostEntry?: string;
  node?: string;
  env?: NodeJS.ProcessEnv;
  startWaitMs?: number;
  stopWaitMs?: number;
  /** Reads the command line of a pid; default /proc on Linux. */
  readCmdline?: (pid: number) => Promise<string | undefined>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Starts the host process; default a detached `node <entry>`. Returns the pid if known. */
  spawnHost?: (node: string, entry: string, env: NodeJS.ProcessEnv) => number | undefined;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

const LOCK_STALE_MS = 30_000;
const lockPath = (agentHome: string): string => path.join(agentHome, "run", "host.lock");
const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

async function readLock(agentHome: string): Promise<{ pid: number; at: number } | undefined> {
  try {
    const [pid, at] = (await readFile(lockPath(agentHome), "utf8")).trim().split(/\s+/).map((part) => Number.parseInt(part, 10));
    if (Number.isInteger(pid) && Number.isInteger(at)) return { pid: pid!, at: at! };
    // Created but not yet written by its holder: age it by the file's mtime and treat the holder as alive.
    return { pid: process.pid, at: (await stat(lockPath(agentHome))).mtimeMs };
  } catch { return undefined; }
}

async function lockIsHeld(agentHome: string, deps: HostDeps): Promise<boolean> {
  const held = await readLock(agentHome);
  if (held === undefined) return false;
  return !((deps.now ?? Date.now)() - held.at > LOCK_STALE_MS && !(deps.isAlive ?? pidAlive)(held.pid));
}

/** Start lock: run/host.lock, O_EXCL, "<pid> <epoch ms>". Same file and rules as mcp-server/src/host/start-lock.ts. */
async function acquireLock(agentHome: string, deps: HostDeps): Promise<(() => Promise<void>) | undefined> {
  await mkdir(path.dirname(lockPath(agentHome)), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath(agentHome), "wx", 0o600);
      await handle.writeFile(`${process.pid} ${(deps.now ?? Date.now)()}\n`);
      await handle.close();
      return async () => { if ((await readLock(agentHome))?.pid === process.pid) await rm(lockPath(agentHome), { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await lockIsHeld(agentHome, deps)) return undefined;
      await rm(lockPath(agentHome), { force: true });
    }
  }
  return undefined;
}

const socketPath = (agentHome: string): string => path.join(agentHome, "run", "host.sock");
const pidPath = (agentHome: string): string => path.join(agentHome, "run", "host.pid");
const fail = (command: string, error: string): Output => ({ ok: false, command, error });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function readPid(agentHome: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(pidPath(agentHome), "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

/** Sends one operator message; resolves with the reply object, "no_host", or "no_reply". */
async function ask(agentHome: string, message: unknown, timeoutMs = 2000): Promise<Record<string, unknown> | "no_host" | "no_reply"> {
  return await new Promise((resolve) => {
    const client = net.connect(socketPath(agentHome));
    let buffer = "";
    const done = (value: Record<string, unknown> | "no_host" | "no_reply"): void => { clearTimeout(timer); client.destroy(); resolve(value); };
    const timer = setTimeout(() => done("no_reply"), timeoutMs);
    client.setEncoding("utf8");
    client.once("connect", () => client.write(`${JSON.stringify(message)}\n`));
    client.once("error", () => done("no_host"));
    client.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try { done(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>); } catch { done("no_reply"); }
    });
    client.once("close", () => done("no_reply"));
  });
}

function defaultHostEntry(): string {
  const explicit = process.env.AGENTHOST_MCP_ENTRY;
  if (explicit) return path.join(path.dirname(path.resolve(explicit)), "host", "main.js");
  return fileURLToPath(new URL("../../mcp-server/dist/host/main.js", import.meta.url));
}

async function defaultCmdline(pid: number): Promise<string | undefined> {
  try { return (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " "); } catch { return undefined; }
}

async function status(agentHome: string): Promise<Output> {
  const pong = await ask(agentHome, { ping: true });
  const pid = await readPid(agentHome);
  const socket = socketPath(agentHome);
  if (pong === "no_host") return { ok: true, command: "host status", data: { running: false, socket, ...(pid === undefined ? {} : { stalePid: pid }) } };
  if (pong === "no_reply" || pong.pong !== true) return { ok: true, command: "host status", data: { running: false, socket, note: "The socket accepts connections but did not answer a ping, so it is not reported as running.", ...(pid === undefined ? {} : { stalePid: pid }) } };
  const reply = await ask(agentHome, { status: true });
  const info = typeof reply === "object" ? (reply.status as Record<string, unknown> | undefined) : undefined;
  return { ok: true, command: "host status", data: { running: true, pid: pong.pid ?? info?.pid ?? pid ?? null, socket, uptimeMs: pong.uptimeMs ?? null, sessions: info?.sessions ?? null, leaseHolder: info?.leaseHolder ?? null, ...(info === undefined ? { note: "The host did not answer the status message." } : {}) } };
}

/** Never starts anything. For `agenthost doctor`. */
export async function hostDoctorLine(agentHome: string, deps: HostDeps = {}): Promise<{ state: "not_running" | "running" | "stale_socket" | "lock_held"; detail: string }> {
  const pong = await ask(agentHome, { ping: true });
  if (typeof pong === "object" && pong.pong === true) return { state: "running", detail: `host running (pid ${String(pong.pid)}, protocol ${String(pong.protocol)}, up ${Math.round(Number(pong.uptimeMs ?? 0) / 1000)} s)` };
  if (await lockIsHeld(agentHome, deps)) return { state: "lock_held", detail: "a host start is in progress (run/host.lock is held)" };
  if (existsSync(socketPath(agentHome))) return { state: "stale_socket", detail: `${socketPath(agentHome)} exists but no host answers; run agenthost host start (it replaces the stale socket) or remove the file` };
  return { state: "not_running", detail: "no host running (AGENTHOST_HOST=1 clients start one on demand)" };
}

async function start(agentHome: string, deps: HostDeps): Promise<Output> {
  const running = async (): Promise<Output> => fail("host start", `agenthost_host_running${(await readPid(agentHome)) === undefined ? "" : `: pid ${await readPid(agentHome)}`}`);
  if ((await ask(agentHome, { status: true })) !== "no_host") return await running();
  const entry = deps.hostEntry ?? defaultHostEntry();
  if (entry === undefined || !existsSync(entry)) return fail("host start", "host_runtime_missing: build the project first");
  const waitMs = deps.startWaitMs ?? 10_000;
  const release = await acquireLock(agentHome, deps);
  if (release === undefined) {
    // Another start is under way: wait for its host instead of starting a second one.
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await sleep(100);
      if ((await ask(agentHome, { status: true })) !== "no_host") return await running();
      if (!(await lockIsHeld(agentHome, deps))) break;
    }
    return fail("host start", "host_start_in_progress: another start holds run/host.lock; try again, or run agenthost host status");
  }
  try {
    if ((await ask(agentHome, { status: true })) !== "no_host") return await running();
    const env = { ...(deps.env ?? process.env), AGENTHOST_HOME: agentHome };
    let childPid: number | undefined;
    if (deps.spawnHost !== undefined) childPid = deps.spawnHost(deps.node ?? process.execPath, entry, env);
    else {
      const child = spawn(deps.node ?? process.execPath, [entry], { detached: true, stdio: "ignore", env });
      child.on("error", () => undefined);
      child.unref();
      childPid = child.pid;
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(100);
      if ((await ask(agentHome, { status: true })) !== "no_host") return { ok: true, command: "host start", data: { running: true, pid: (await readPid(agentHome)) ?? childPid ?? null, socket: socketPath(agentHome) } };
    }
    return fail("host start", `host_start_timeout: the host did not open its socket within ${Math.round(waitMs / 1000)} s`);
  } finally {
    await release();
  }
}

async function restart(agentHome: string, deps: HostDeps): Promise<Output> {
  const stopped = await stop(agentHome, deps);
  if (!stopped.ok) return fail("host restart", `restart_refused: ${stopped.error ?? "stop failed"}`);
  // Wait until nothing answers on the socket before starting again.
  const deadline = Date.now() + (deps.stopWaitMs ?? 5000);
  while ((await ask(agentHome, { status: true }, 300)) !== "no_host") {
    if (Date.now() > deadline) return fail("host restart", "restart_refused: the old host is still answering after stop; nothing was started");
    await sleep(100);
  }
  const started = await start(agentHome, deps);
  if (!started.ok) return fail("host restart", started.error ?? "start failed");
  return { ok: true, command: "host restart", data: { restarted: true, stopped: stopped.data, started: started.data } };
}

async function stop(agentHome: string, deps: HostDeps): Promise<Output> {
  const pid = await readPid(agentHome);
  const reply = await ask(agentHome, { shutdown: true });
  if (reply === "no_host") return { ok: true, command: "host stop", data: { stopped: false, running: false } };
  const deadline = Date.now() + (deps.stopWaitMs ?? 5000);
  while (Date.now() < deadline) {
    if ((await ask(agentHome, { status: true }, 300)) === "no_host") return { ok: true, command: "host stop", data: { stopped: true, via: "socket" } };
    await sleep(100);
  }
  if (pid === undefined) return fail("host stop", "host_did_not_exit: no pid file to fall back on");
  const cmdline = await (deps.readCmdline ?? defaultCmdline)(pid);
  if (cmdline === undefined || !/host[\\/]main\.js/.test(cmdline)) return fail("host stop", `host_did_not_exit: pid ${pid} is not verifiably the AgentHost host, so it was not signalled`);
  (deps.kill ?? ((p, s) => process.kill(p, s)))(pid, "SIGTERM");
  return { ok: true, command: "host stop", data: { stopped: true, via: "sigterm", pid } };
}

export async function hostCommand(args: string[], agentHome: string, deps: HostDeps = {}): Promise<Output> {
  const sub = args[0];
  if (sub === "status") return await status(agentHome);
  if (sub === "start") return await start(agentHome, deps);
  if (sub === "stop") return await stop(agentHome, deps);
  if (sub === "restart") return await restart(agentHome, deps);
  return fail("host", "usage: agenthost host status | start | stop | restart");
}
