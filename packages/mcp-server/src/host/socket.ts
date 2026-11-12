import net from "node:net";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * Socket and pid files of the host. Both live in <agentHome>/run (mode 0700);
 * the socket and the pid file are mode 0600, and the socket is created under
 * a 0177 umask so there is no window where another user could connect.
 */

export class HostError extends Error {
  constructor(readonly code: string, message: string, readonly pid?: number) { super(message); }
}

export interface HostPaths { runDir: string; socket: string; pid: string }

export function hostPaths(agentHome: string): HostPaths {
  const runDir = path.join(agentHome, "run");
  return { runDir, socket: path.join(runDir, "host.sock"), pid: path.join(runDir, "host.pid") };
}

export async function ensureRunDir(agentHome: string): Promise<HostPaths> {
  const paths = hostPaths(agentHome);
  await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
  await chmod(paths.runDir, 0o700).catch(() => undefined);
  return paths;
}

export async function readHostPid(agentHome: string): Promise<number | undefined> {
  try {
    const pid = Number.parseInt((await readFile(hostPaths(agentHome).pid, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

/** "live": something accepts connections; "absent": no file; "stale": a file with no listener behind it. */
export async function probeSocket(socketPath: string, timeoutMs = 1000): Promise<"live" | "stale" | "absent"> {
  return await new Promise((resolve) => {
    const client = net.connect(socketPath);
    const done = (state: "live" | "stale" | "absent"): void => { clearTimeout(timer); client.destroy(); resolve(state); };
    const timer = setTimeout(() => done("stale"), timeoutMs);
    client.once("connect", () => done("live"));
    client.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ENOENT" ? "absent" : "stale"));
  });
}

/**
 * Starts listening. Refuses with agenthost_host_running when a live host owns
 * the socket; removes a stale socket first.
 */
export async function listenOnHostSocket(agentHome: string, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  const paths = await ensureRunDir(agentHome);
  const state = await probeSocket(paths.socket);
  if (state === "live") {
    const pid = await readHostPid(agentHome);
    throw new HostError("agenthost_host_running", `An AgentHost host is already running${pid === undefined ? "" : ` (pid ${pid})`}.`, pid);
  }
  if (state === "stale") await rm(paths.socket, { force: true });
  const server = net.createServer(onConnection);
  const previousUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socket, () => { server.off("error", reject); resolve(); });
    });
  } finally {
    process.umask(previousUmask);
  }
  await chmod(paths.socket, 0o600).catch(() => undefined);
  await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
  await chmod(paths.pid, 0o600).catch(() => undefined);
  return server;
}

export async function removeHostFiles(agentHome: string): Promise<void> {
  const paths = hostPaths(agentHome);
  const pid = await readHostPid(agentHome);
  await rm(paths.socket, { force: true }).catch(() => undefined);
  if (pid === undefined || pid === process.pid) await rm(paths.pid, { force: true }).catch(() => undefined);
}
