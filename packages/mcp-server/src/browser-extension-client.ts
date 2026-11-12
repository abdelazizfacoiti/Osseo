import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

/*
 * Client for the native messaging host of the browser extension (packages/browser-extension/host).
 * One unix socket connection per call; frames are a 4-byte little-endian length followed by JSON,
 * the same framing as src/protocol.mjs. The framing functions are copied here because the server
 * is compiled with a rootDir that cannot reach the extension package; a test compares both copies.
 */

export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 15_000;

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_MESSAGE_BYTES) throw new Error("message_too_large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_MESSAGE_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new Error("message_too_large");
      }
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new Error("bad_json");
      }
    }
    return messages;
  }
}

export function extensionSocketPath(agentHostDir: string): string {
  return process.env.AGENTHOST_BROWSER_SOCKET || path.join(agentHostDir, "run", "browser-extension.sock");
}

export function allowedHostsFilePath(agentHostDir: string): string {
  return process.env.AGENTHOST_BROWSER_ALLOWED_HOSTS_FILE || path.join(agentHostDir, "browser-extension", "allowed-hosts.json");
}

export type ExtensionRequestType = "snapshot" | "click" | "type" | "select" | "navigate" | "read";

export interface ExtensionRequest {
  type: ExtensionRequestType;
  tabId: number;
  host: string;
  ref?: string;
  text?: string;
  value?: string;
  url?: string;
}

/** What the extension sent back, or a client-side failure. `reason` is set whenever `ok` is false. */
export interface ExtensionReply {
  ok: boolean;
  reason?: string;
  [key: string]: unknown;
}

export interface SendOptions {
  socketPath: string;
  timeoutMs?: number;
}

/** Sends one request and resolves with the reply that carries the same id. Never rejects. */
export function sendExtensionRequest(request: ExtensionRequest, options: SendOptions): Promise<ExtensionReply> {
  const id = randomUUID();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return new Promise<ExtensionReply>((resolve) => {
    let settled = false;
    const decoder = new FrameDecoder();
    const socket = net.createConnection(options.socketPath);
    const finish = (reply: ExtensionReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    socket.on("connect", () => {
      try {
        socket.write(encodeFrame({ ...request, id }));
      } catch (error) {
        finish({ ok: false, reason: error instanceof Error && error.message === "message_too_large" ? "message_too_large" : "write_failed" });
      }
    });
    socket.on("data", (chunk) => {
      let messages: unknown[];
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        return finish({ ok: false, reason: error instanceof Error ? error.message : "bad_frame" });
      }
      for (const message of messages) {
        if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
        const reply = message as Record<string, unknown>;
        if (reply.id !== id || typeof reply.ok !== "boolean") continue;
        const { id: _id, ...rest } = reply;
        return finish(rest as ExtensionReply);
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish({ ok: false, reason: error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "extension_not_running" : "socket_error" });
    });
    socket.on("close", () => finish({ ok: false, reason: "extension_disconnected" }));
  });
}
