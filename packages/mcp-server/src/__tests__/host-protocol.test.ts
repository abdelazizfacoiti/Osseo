import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHost, type CreateHostSession, type RunningHost } from "../host/host.js";
import { hostPaths } from "../host/socket.js";
import { LineReader, MAX_MESSAGE_BYTES } from "../host/protocol.js";

let host: RunningHost | undefined;
let home = "";
afterEach(async () => { await host?.close(); host = undefined; rmSync(home, { recursive: true, force: true }); });

/** A fake MCP session: echoes each request as a result; `slow` calls are state changing and wait for release(). */
const gates: Array<() => void> = [];
const ran: string[] = [];
const echoSession: CreateHostSession = async (transport) => {
  const classify = (name: string): boolean => name === "slow" || name === "fast" || name === "boom";
  transport.setClassifier(classify);
  transport.onmessage = (message) => {
    const m = message as { id?: number; method?: string; params?: { name?: string } };
    if (m.id === undefined) return;
    const reply = (): void => { ran.push(m.params?.name ?? m.method ?? ""); void transport.send({ jsonrpc: "2.0", id: m.id as number, result: { echo: m.params?.name ?? m.method } }); };
    if (m.params?.name === "slow") gates.push(reply); else reply();
  };
  return { close: async () => undefined, isStateChanging: classify };
};

async function begin(options: Parameters<typeof startHost>[0] extends infer _ ? { leaseWaitMs?: number } : never = {}): Promise<string> {
  home = mkdtempSync(path.join(os.tmpdir(), "ah-proto-"));
  host = await startHost({ agentHome: home, createSession: echoSession, ...options });
  return hostPaths(home).socket;
}

class Client {
  lines: string[] = [];
  private waiters: Array<() => void> = [];
  closed = false;
  private constructor(readonly socket: net.Socket) {
    socket.setEncoding("utf8");
    const reader = new LineReader((l) => { this.lines.push(l); this.waiters.splice(0).forEach((w) => w()); }, () => undefined, 64 * 1024 * 1024);
    socket.on("data", (c: string) => reader.push(c));
    socket.on("close", () => { this.closed = true; this.waiters.splice(0).forEach((w) => w()); });
    socket.on("error", () => undefined);
  }
  static async connect(p: string): Promise<Client> {
    const s = net.connect(p);
    await new Promise<void>((r) => s.once("connect", () => r()));
    return new Client(s);
  }
  send(value: unknown): void { this.socket.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`); }
  async next(): Promise<any> {
    for (let i = 0; i < 200 && this.lines.length === 0 && !this.closed; i += 1) await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 50); });
    const line = this.lines.shift();
    if (line === undefined) throw new Error("no line");
    return JSON.parse(line);
  }
  async hello(client = "t"): Promise<any> { this.send({ hello: { protocol: 1, client } }); return await this.next(); }
}

describe("host protocol", () => {
  it("accepts a hello and forwards JSON-RPC lines", async () => {
    const c = await Client.connect(await begin());
    const welcome = await c.hello("codex");
    expect(welcome.welcome).toMatchObject({ protocol: 1, hostPid: process.pid });
    expect(welcome.welcome.sessionId).toMatch(/^h_/);
    c.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    expect(await c.next()).toEqual({ jsonrpc: "2.0", id: 5, result: { echo: "tools/list" } });
    c.socket.destroy();
  });

  it("refuses a wrong protocol and closes", async () => {
    const c = await Client.connect(await begin());
    c.send({ hello: { protocol: 2, client: "x" } });
    expect((await c.next()).refused.code).toBe("protocol_mismatch");
    await new Promise((r) => setTimeout(r, 100));
    expect(c.closed).toBe(true);
  });

  it("answers a malformed line without closing, before and after the handshake", async () => {
    const c = await Client.connect(await begin());
    c.send("not json {");
    expect((await c.next()).error.code).toBe("malformed_message");
    await c.hello();
    c.send("still not json");
    expect((await c.next()).error.code).toBe(-32700);
    c.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect((await c.next()).result.echo).toBe("ping");
    expect(c.closed).toBe(false);
    c.socket.destroy();
  });

  it("refuses a message over 4 MB and keeps the connection", async () => {
    const c = await Client.connect(await begin());
    await c.hello();
    c.socket.write(`${"x".repeat(MAX_MESSAGE_BYTES + 10)}\n`);
    const reply = await c.next();
    expect(reply.error.data.code).toBe("message_too_large");
    c.send({ jsonrpc: "2.0", id: 2, method: "ping" });
    expect((await c.next()).id).toBe(2);
    c.socket.destroy();
  });

  it("answers status and shutdown without a handshake", async () => {
    const c = await Client.connect(await begin());
    c.send({ status: true });
    expect((await c.next()).status).toMatchObject({ pid: process.pid, sessions: 0 });
    c.send({ shutdown: true });
    expect((await c.next()).shutdown.ok).toBe(true);
    await expect(host!.closed).resolves.toBe("shutdown_message");
  });

  it("serializes state-changing calls, frees the lease on disconnect, and returns host_busy after the wait", async () => {
    gates.length = 0; ran.length = 0;
    const socketPath = await begin({ leaseWaitMs: 300 });
    const a = await Client.connect(socketPath); await a.hello("a");
    const b = await Client.connect(socketPath); await b.hello("b");
    a.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "slow" } });
    await new Promise((r) => setTimeout(r, 80));
    expect(host!.lease.holderLabel).toContain("a/");
    // Read-only calls are not leased.
    b.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await b.next()).result.echo).toBe("tools/list");
    // A second state-changing call waits, then fails with host_busy and never runs.
    b.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fast" } });
    const busy = await b.next();
    expect(busy.id).toBe(3);
    expect(JSON.parse(busy.result.content[0].text).error.code).toBe("host_busy");
    expect(ran).not.toContain("fast");
    // Holder disconnects: the lease frees at once and b can run.
    a.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(host!.lease.holderLabel).toBeUndefined();
    b.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "fast" } });
    expect((await b.next()).result.echo).toBe("fast");
    b.socket.destroy();
  });
});
