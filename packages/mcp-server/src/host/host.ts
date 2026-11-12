import type net from "node:net";
import { randomBytes } from "node:crypto";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { HOST_PROTOCOL, LineReader, encodeLine, jsonRpcError, parseHello } from "./protocol.js";
import { DEFAULT_LEASE_WAIT_MS, HostLease } from "./lease.js";
import { SocketTransport } from "./session-transport.js";
import { SharedRendererHub } from "./shared-renderer.js";
import type { OverlayRenderer } from "@agenthost/app-overlay";
import { listenOnHostSocket, removeHostFiles } from "./socket.js";

/*
 * The host process: one MCP server session per accepted connection, exactly
 * as startStdioServer builds one, over the socket instead of stdio. Opt-in
 * (AGENTHOST_HOST=1 on the MCP entry); the in-process server stays the default.
 */

export interface HostSession {
  close(): Promise<void>;
  /** True when the named tool changes state and so needs the lease. */
  isStateChanging(toolName: string): boolean;
}

export interface HostSessionInfo {
  sessionId: string;
  client: string;
  /** This session's view of the host's one shared renderer. A session must never close it. */
  overlayRenderer?: OverlayRenderer;
}

export type CreateHostSession = (transport: SocketTransport, info: HostSessionInfo) => Promise<HostSession>;

export interface HostOptions {
  agentHome: string;
  createSession?: CreateHostSession;
  /**
   * Builds the one renderer all sessions share. Default (with the default
   * session factory): the same renderer server.ts builds for one session.
   * With a custom createSession and no factory there is no shared renderer.
   */
  createRenderer?: () => Promise<OverlayRenderer> | OverlayRenderer;
  leaseWaitMs?: number;
  idleExitMs?: number;
  idleCheckMs?: number;
  /** True while a task is running. Default reads the task files. */
  hasRunningTask?: () => Promise<boolean>;
  /** Called after the host has closed itself (idle exit, shutdown message). */
  onExit?: (reason: string) => void;
}

export interface RunningHost {
  readonly lease: HostLease;
  sessionCount(): number;
  close(reason?: string): Promise<void>;
  closed: Promise<string>;
}

export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;

async function defaultCreateRenderer(): Promise<OverlayRenderer> {
  // Same renderer options as the per-session path in server.ts, built once for the host.
  const { loadAgentHostConfig } = await import("@agenthost/core");
  const { createOverlayRenderer } = await import("@agenthost/app-overlay");
  const { inputGuardPath } = await import("../input-guard.js");
  const config = await loadAgentHostConfig();
  return createOverlayRenderer(config.overlay?.rendererMode ?? config.overlayRendererMode ?? "auto", {
    sessionId: `host_${process.pid}`,
    inputGuardPath: inputGuardPath(config.agentHostDir),
    visual: {
      layout: config.overlay?.layout ?? "dock",
      dockSide: config.overlay?.dockSide ?? "right",
      dockWidthPercent: config.overlay?.dockWidthPercent ?? 18,
      dockReserveSpace: config.overlay?.dockReserveSpace ?? true,
      allowSyntheticControl: config.overlay?.allowSyntheticControl ?? false,
      maxWidth: config.overlay?.maxWidth ?? 520
    }
  });
}

async function defaultCreateSession(transport: SocketTransport, info: HostSessionInfo): Promise<HostSession> {
  const { createAgentHostMcpServer } = await import("../server.js");
  const { server, context, closeResources } = await createAgentHostMcpServer({
    sessionId: info.sessionId,
    ...(info.overlayRenderer === undefined ? {} : { overlayRenderer: info.overlayRenderer })
  });
  transport.setClassifier((name) => context.tools?.get(name)?.execution?.executionClass === "state_changing");
  await server.connect(transport);
  return {
    isStateChanging: (name) => context.tools?.get(name)?.execution?.executionClass === "state_changing",
    close: async () => {
      await server.close().catch(() => undefined);
      await closeResources().catch(() => undefined);
    }
  };
}

async function defaultHasRunningTask(agentHome: string): Promise<boolean> {
  try {
    const { listTasks } = await import("@agenthost/core");
    return (await listTasks(agentHome)).some((task) => task.status === "active");
  } catch {
    return false;
  }
}

export async function startHost(options: HostOptions): Promise<RunningHost> {
  const { agentHome } = options;
  const lease = new HostLease(options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS);
  const createSession = options.createSession ?? defaultCreateSession;
  // One renderer for every session. Only built when the host builds its own sessions or is given a factory.
  const rendererFactory = options.createRenderer ?? (options.createSession === undefined ? defaultCreateRenderer : undefined);
  const hub = rendererFactory === undefined ? undefined : new SharedRendererHub(await rendererFactory());
  const idleExitMs = options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
  const hasRunningTask = options.hasRunningTask ?? (() => defaultHasRunningTask(agentHome));
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const connections = new Set<net.Socket>();
  const sessions = new Map<string, HostSession>();
  let idleSince = Date.now();
  let closing: Promise<void> | undefined;
  let resolveClosed: (reason: string) => void = () => undefined;
  const closed = new Promise<string>((resolve) => { resolveClosed = resolve; });

  const server = await listenOnHostSocket(agentHome, (socket) => handle(socket));

  const status = (): Record<string, unknown> => ({
    pid: process.pid, protocol: HOST_PROTOCOL, startedAt, sessions: sessions.size,
    leaseHolder: lease.holderLabel ?? null, waiting: lease.waiting
  });

  function handle(socket: net.Socket): void {
    connections.add(socket);
    socket.setEncoding("utf8");
    const write = (line: string): void => { if (!socket.destroyed && socket.writable) socket.write(line); };
    let phase: "new" | "starting" | "ready" = "new";
    let transport: SocketTransport | undefined;
    let session: HostSession | undefined;
    let sessionId = "";
    const backlog: string[] = [];

    const dispatch = (line: string): void => {
      let message: unknown;
      try { message = JSON.parse(line); } catch {
        write(encodeLine(jsonRpcError(null, -32700, "Parse error: not JSON")));
        return;
      }
      if (typeof message !== "object" || message === null || Array.isArray(message)) {
        write(encodeLine(jsonRpcError(null, -32600, "Invalid request")));
        return;
      }
      transport?.receive(message as JSONRPCMessage);
    };

    const onLine = (line: string): void => {
      if (phase === "starting") { backlog.push(line); return; }
      if (phase === "ready") { dispatch(line); return; }
      let message: unknown;
      try { message = JSON.parse(line); } catch {
        write(encodeLine({ error: { code: "malformed_message" } }));
        return;
      }
      const record = (typeof message === "object" && message !== null ? message : {}) as Record<string, unknown>;
      if (record.shutdown === true) {
        write(encodeLine({ shutdown: { ok: true } }));
        socket.end();
        void close("shutdown_message");
        return;
      }
      if (record.ping === true) { write(encodeLine({ pong: true, protocol: HOST_PROTOCOL, pid: process.pid, uptimeMs: Date.now() - startedMs })); return; }
      if (record.status === true) { write(encodeLine({ status: status() })); return; }
      const hello = parseHello(record);
      if (hello === undefined) { write(encodeLine({ error: { code: "hello_required" } })); return; }
      if (hello.protocol !== HOST_PROTOCOL) {
        write(encodeLine({ refused: { code: "protocol_mismatch", hostProtocol: HOST_PROTOCOL } }));
        socket.end();
        return;
      }
      phase = "starting";
      sessionId = `h_${randomBytes(6).toString("hex")}`;
      const created = new SocketTransport(write, lease, `${hello.client}/${sessionId}`);
      transport = created;
      const proxy = hub?.proxyFor(sessionId);
      createSession(created, { sessionId, client: hello.client, ...(proxy === undefined ? {} : { overlayRenderer: proxy }) }).then((made) => {
        session = made;
        sessions.set(sessionId, made);
        phase = "ready";
        write(encodeLine({ welcome: { protocol: HOST_PROTOCOL, hostPid: process.pid, sessionId } }));
        for (const queued of backlog.splice(0)) dispatch(queued);
        if (socket.destroyed) void end();
      }, (error: unknown) => {
        void hub?.release(sessionId);
        write(encodeLine({ refused: { code: "session_failed", message: error instanceof Error ? error.message : "session_failed" } }));
        socket.end();
      });
    };

    const reader = new LineReader(onLine, () => {
      write(encodeLine(phase === "ready" ? jsonRpcError(null, -32600, "Message too large (limit 4 MB)", { code: "message_too_large" }) : { error: { code: "message_too_large" } }));
    });
    socket.on("data", (chunk: string) => reader.push(chunk));
    socket.on("error", () => undefined);

    const end = async (): Promise<void> => {
      connections.delete(socket);
      transport?.handleClosed();
      if (session !== undefined) {
        sessions.delete(sessionId);
        await session.close().catch(() => undefined);
      }
      // After the session's own close: take its cards off the shared renderer.
      await hub?.release(sessionId);
      if (connections.size === 0) idleSince = Date.now();
    };
    socket.on("close", () => { void end(); });
  }

  const timer = setInterval(() => {
    if (connections.size > 0) { idleSince = Date.now(); return; }
    if (Date.now() - idleSince < idleExitMs) return;
    void hasRunningTask().then((running) => {
      if (running) { idleSince = Date.now(); return; }
      if (connections.size === 0) void close("idle");
    });
  }, options.idleCheckMs ?? Math.min(30_000, Math.max(50, Math.floor(idleExitMs / 2))));

  function close(reason = "closed"): Promise<void> {
    closing ??= (async () => {
      clearInterval(timer);
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      await stopped;
      await Promise.all([...sessions.values()].map((s) => s.close().catch(() => undefined)));
      await hub?.close().catch(() => undefined);
      await removeHostFiles(agentHome);
      resolveClosed(reason);
      options.onExit?.(reason);
    })();
    return closing;
  }

  return { lease, sessionCount: () => sessions.size, close, closed };
}
