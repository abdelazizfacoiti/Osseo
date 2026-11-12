import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { encodeLine } from "./protocol.js";
import { HostBusyError, LeaseCancelled, type HostLease, type LeaseRelease } from "./lease.js";

/**
 * MCP transport over one host connection. A state-changing `tools/call` waits
 * for the host lease before the server sees it; the lease is released when the
 * reply for that call is sent, or at once when the connection closes. A call
 * that waits too long is answered with host_busy and never reaches the server.
 */
export class SocketTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private readonly held = new Map<string | number, LeaseRelease>();
  private readonly abort = new AbortController();
  private closed = false;
  private classify: (toolName: string) => boolean = () => false;

  constructor(
    private readonly write: (line: string) => void,
    private readonly lease: HostLease,
    private readonly label: string
  ) {}

  setClassifier(classify: (toolName: string) => boolean): void { this.classify = classify; }

  async start(): Promise<void> { /* The host feeds lines through receive(). */ }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return;
    this.write(encodeLine(message));
    const id = (message as { id?: string | number }).id;
    if (id !== undefined && ("result" in message || "error" in message)) {
      const release = this.held.get(id);
      if (release !== undefined) { this.held.delete(id); release(); }
    }
  }

  async close(): Promise<void> { this.handleClosed(); }

  /** The socket is gone: free the lease and stop waiting. */
  handleClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    for (const release of this.held.values()) release();
    this.held.clear();
    this.onclose?.();
  }

  receive(message: JSONRPCMessage): void {
    const request = message as { id?: string | number; method?: string; params?: { name?: unknown } };
    const name = request.params?.name;
    if (request.method !== "tools/call" || request.id === undefined || typeof name !== "string" || !this.classify(name)) {
      this.onmessage?.(message);
      return;
    }
    const id = request.id;
    this.lease.acquire(`${this.label}:${name}`, this.abort.signal).then((release) => {
      if (this.closed) { release(); return; }
      this.held.set(id, release);
      this.onmessage?.(message);
    }, (error: unknown) => {
      if (error instanceof LeaseCancelled || this.closed) return;
      const busy = error instanceof HostBusyError;
      const text = JSON.stringify({ ok: false, error: { code: busy ? "host_busy" : "lease_failed", message: error instanceof Error ? error.message : "lease_failed" } });
      this.write(encodeLine({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text }] } }));
    });
  }
}
