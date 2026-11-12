import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/*
 * `agenthost host status|start|stop`: the per-user host that AGENTHOST_HOST=1
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
  const reply = await ask(agentHome, { status: true });
  const pid = await readPid(agentHome);
  if (reply === "no_host") return { ok: true, command: "host status", data: { running: false, socket: socketPath(agentHome), ...(pid === undefined ? {} : { stalePid: pid }) } };
  const info = reply === "no_reply" ? undefined : (reply.status as Record<string, unknown> | undefined);
  return { ok: true, command: "host status", data: { running: true, pid: info?.pid ?? pid ?? null, socket: socketPath(agentHome), sessions: info?.sessions ?? null, leaseHolder: info?.leaseHolder ?? null, ...(info === undefined ? { note: "The host did not answer the status message." } : {}) } };
}

async function start(agentHome: string, deps: HostDeps): Promise<Output> {
  const current = await ask(agentHome, { status: true });
  if (current !== "no_host") return fail("host start", `agenthost_host_running${(await readPid(agentHome)) === undefined ? "" : `: pid ${await readPid(agentHome)}`}`);
  const entry = deps.hostEntry ?? defaultHostEntry();
  if (entry === undefined || !existsSync(entry)) return fail("host start", "host_runtime_missing: build the project first");
  const child = spawn(deps.node ?? process.execPath, [entry], { detached: true, stdio: "ignore", env: { ...(deps.env ?? process.env), AGENTHOST_HOME: agentHome } });
  child.on("error", () => undefined);
  child.unref();
  const deadline = Date.now() + (deps.startWaitMs ?? 10_000);
  while (Date.now() < deadline) {
    await sleep(100);
    if ((await ask(agentHome, { status: true })) !== "no_host") return { ok: true, command: "host start", data: { running: true, pid: (await readPid(agentHome)) ?? child.pid ?? null, socket: socketPath(agentHome) } };
  }
  return fail("host start", "host_start_timeout: the host did not open its socket within 10 s");
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
  return fail("host", "usage: agenthost host status | start | stop");
}
