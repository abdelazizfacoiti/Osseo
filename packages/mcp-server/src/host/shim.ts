import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { HOST_PROTOCOL, LineReader, encodeLine, jsonRpcError } from "./protocol.js";
import { hostPaths, probeSocket } from "./socket.js";
import { acquireStartLock } from "./start-lock.js";

/*
 * The stdio process an MCP client spawns when AGENTHOST_HOST=1. It connects to
 * the host (starting one detached through the start lock if none is running) and forwards lines both
 * ways unchanged. If the host dies it answers the open requests with a
 * JSON-RPC error and exits. It never re-sends a request.
 */

export interface ShimOptions {
  agentHome: string;
  input?: Readable;
  output?: Writable;
  error?: Writable;
  client?: string;
  /** Starts a host. Default: `node <host/main.js>` detached with stdio ignored. */
  startHost?: () => void;
  startWaitMs?: number;
  /** After the host is gone, how long the shim keeps answering new requests with the error. */
  deadGraceMs?: number;
  /** Exit code when no host could be reached or it refused the connection (default 1). The auto-host entry uses it to fall back to an in-process server. */
  unavailableCode?: number;
}

export function defaultHostEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
}

function defaultStartHost(): void {
  const child = spawn(process.execPath, [defaultHostEntry()], { detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => undefined);
  child.unref();
}

async function connectWithStart(options: ShimOptions): Promise<net.Socket> {
  const { socket: socketPath } = hostPaths(options.agentHome);
  const attempt = (): Promise<net.Socket | undefined> => new Promise((resolve) => {
    const client = net.connect(socketPath);
    client.once("connect", () => { client.removeAllListeners("error"); resolve(client); });
    client.once("error", () => { client.destroy(); resolve(undefined); });
  });
  let connected = await attempt();
  if (connected !== undefined) return connected;
  // Connect failed: start a host through the start lock (one starter wins; the others only retry), then connect again.
  const lock = await acquireStartLock(options.agentHome).catch(() => undefined);
  try {
    if (lock !== undefined) {
      connected = await attempt();
      if (connected !== undefined) return connected;
      if ((await probeSocket(socketPath, 300)) !== "live") (options.startHost ?? defaultStartHost)();
    }
    const deadline = Date.now() + (options.startWaitMs ?? 10_000);
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      connected = await attempt();
      if (connected !== undefined) return connected;
    }
  } finally {
    await lock?.release();
  }
  throw new Error("host_unavailable: the AgentHost host did not start within 10 s. Run agenthost doctor.");
}

/** Returns the exit code. */
export async function runShim(options: ShimOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errors = options.error ?? process.stderr;
  const fail = (id: unknown, message: string): void => {
    output.write(encodeLine(jsonRpcError(id, -32000, message, { code: "host_disconnected" })));
  };

  let socket: net.Socket;
  try { socket = await connectWithStart(options); } catch (error) {
    errors.write(`${error instanceof Error ? error.message : "host_unavailable"}\n`);
    return options.unavailableCode ?? 1;
  }
  socket.setEncoding("utf8");

  const open = new Set<string | number>();
  let hostGone = false;

  // Handshake first; client lines wait unread until the host has said welcome.
  const welcome = await new Promise<{ ok: boolean; rest: string; message?: string }>((resolve) => {
    let buffer = "";
    const onData = (chunk: string): void => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", onData);
      socket.off("close", onClose);
      const line = buffer.slice(0, newline);
      const rest = buffer.slice(newline + 1);
      try {
        const reply = JSON.parse(line) as { welcome?: { protocol?: number }; refused?: { code?: string; message?: string } };
        if (reply.welcome?.protocol === HOST_PROTOCOL) resolve({ ok: true, rest });
        else resolve({ ok: false, rest, message: reply.refused?.code ?? "handshake_failed" });
      } catch { resolve({ ok: false, rest, message: "handshake_failed" }); }
    };
    const onClose = (): void => resolve({ ok: false, rest: "", message: "host_closed_during_handshake" });
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.write(encodeLine({ hello: { protocol: HOST_PROTOCOL, client: options.client ?? process.env.AGENTHOST_CLIENT ?? "mcp-client" } }));
  });
  if (!welcome.ok) {
    errors.write(`AgentHost host refused the connection: ${welcome.message}. Run agenthost doctor.\n`);
    socket.destroy();
    return options.unavailableCode ?? 1;
  }

  return await new Promise<number>((resolve) => {
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(code);
    };

    const fromHost = new LineReader((line) => {
      try {
        const reply = JSON.parse(line) as { id?: string | number; result?: unknown; error?: unknown };
        if (reply.id !== undefined && ("result" in reply || "error" in reply)) open.delete(reply.id);
      } catch { /* forwarded as is */ }
      output.write(`${line}\n`);
    }, () => undefined, 64 * 1024 * 1024);
    if (welcome.rest !== "") fromHost.push(welcome.rest);
    socket.on("data", (chunk: string) => fromHost.push(chunk));
    socket.on("error", () => undefined);

    const fromClient = new LineReader((line) => {
      let id: string | number | undefined;
      let isRequest = false;
      try {
        const message = JSON.parse(line) as { id?: string | number; method?: string };
        id = message.id;
        isRequest = id !== undefined && typeof message.method === "string";
      } catch { /* the host answers a malformed line */ }
      if (hostGone) {
        if (isRequest) fail(id, "AgentHost host is not running; the call was not executed. Restart the client session.");
        return;
      }
      if (isRequest) open.add(id as string | number);
      socket.write(`${line}\n`);
    }, () => {
      fail(null, "Message too large (limit 4 MB)");
    });
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => fromClient.push(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    input.on("end", () => finish(0));
    input.on("close", () => finish(0));

    socket.once("close", () => {
      if (finished) return;
      hostGone = true;
      for (const id of open) fail(id, "AgentHost host stopped while this call was open; the call was not retried and its outcome is unknown. Check the screen before repeating it.");
      open.clear();
      errors.write("AgentHost host disconnected.\n");
      // Late requests still get the error, for a short grace period, then the shim exits.
      setTimeout(() => finish(1), options.deadGraceMs ?? 2000);
    });
  });
}

export async function runShimFromEnv(): Promise<void> {
  const agentHome = path.resolve(process.env.AGENTHOST_HOME ?? (await import("@agenthost/core")).defaultAgentHostHome(os.homedir()));
  // AGENTHOST_HOST_AUTO=1 (set by `agenthost start`): if the host cannot be reached, run the in-process server instead.
  const auto = process.env.AGENTHOST_HOST_AUTO === "1";
  const code = await runShim({ agentHome, ...(auto ? { unavailableCode: 125 } : {}) });
  if (auto && code === 125) {
    const { startStdioServer } = await import("../server.js");
    await startStdioServer();
    return;
  }
  process.exit(code);
}
