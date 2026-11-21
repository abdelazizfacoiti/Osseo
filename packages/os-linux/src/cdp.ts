import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Socket } from "node:net";

/*
 * A small Chrome DevTools Protocol client over a minimal RFC 6455 WebSocket.
 * It exists because Node 20 has no built-in WebSocket and Osseo avoids a
 * new runtime dependency for one local loopback connection. It speaks only to
 * 127.0.0.1 and handles text frames, fragmentation, ping/pong, and close.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "CdpError";
    this.code = code;
  }
}

export class CdpConnection {
  readonly #socket: Socket;
  readonly #pending = new Map<number, Pending>();
  readonly #handlers = new Map<string, Set<CdpEventHandler>>();
  #buffer: Buffer = Buffer.alloc(0);
  #fragments: Buffer[] = [];
  #nextId = 1;
  #closed = false;
  #onClose: Array<() => void> = [];

  private constructor(socket: Socket, head: Buffer) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("close", () => this.#teardown(new CdpError("connection_closed")));
    socket.on("error", () => this.#teardown(new CdpError("connection_error")));
    if (head.length > 0) this.#receive(head);
  }

  static connect(wsUrl: string, timeoutMs = 5_000): Promise<CdpConnection> {
    const url = new URL(wsUrl);
    if (url.protocol !== "ws:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")) {
      return Promise.reject(new CdpError("cdp_loopback_only"));
    }
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const req = request({
        host: url.hostname,
        port: Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" },
        timeout: timeoutMs
      });
      req.on("timeout", () => { req.destroy(); reject(new CdpError("cdp_connect_timeout")); });
      req.on("error", () => reject(new CdpError("cdp_connect_failed")));
      req.on("response", () => reject(new CdpError("cdp_upgrade_refused")));
      req.on("upgrade", (response, socket, head) => {
        const expected = createHash("sha1").update(key + GUID).digest("base64");
        if (response.headers["sec-websocket-accept"] !== expected) {
          socket.destroy();
          reject(new CdpError("cdp_bad_handshake"));
          return;
        }
        socket.setTimeout(0);
        resolve(new CdpConnection(socket, head));
      });
      req.end();
    });
  }

  get closed(): boolean { return this.#closed; }

  onClose(callback: () => void): void { this.#onClose.push(callback); }

  on(event: string, handler: CdpEventHandler): () => void {
    const set = this.#handlers.get(event) ?? new Set();
    set.add(handler);
    this.#handlers.set(event, set);
    return () => { set.delete(handler); };
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new CdpError("connection_closed"));
    const id = this.#nextId++;
    const message = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(`cdp_timeout:${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#writeFrame(0x1, Buffer.from(message, "utf8"));
    });
  }

  close(): void {
    if (this.#closed) return;
    try { this.#writeFrame(0x8, Buffer.alloc(0)); } catch { /* Already gone. */ }
    this.#socket.end();
    this.#teardown(new CdpError("connection_closed"));
  }

  #teardown(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#socket.destroy();
    for (const callback of this.#onClose) { try { callback(); } catch { /* Listener errors are not ours. */ } }
  }

  #writeFrame(opcode: number, payload: Buffer): void {
    // Client frames must be masked.
    const mask = randomBytes(4);
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
    else if (payload.length < 65_536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) masked[index] = payload[index]! ^ mask[index % 4]!;
    this.#socket.write(Buffer.concat([header, mask, masked]));
  }

  #receive(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const first = this.#buffer[0]!;
      const second = this.#buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        const big = this.#buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) { this.close(); return; }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) { this.close(); return; }
      const maskBytes = masked ? 4 : 0;
      if (this.#buffer.length < offset + maskBytes + length) return;
      let payload = this.#buffer.subarray(offset + maskBytes, offset + maskBytes + length);
      if (masked) {
        const key = this.#buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ key[index % 4]!));
      } else {
        payload = Buffer.from(payload);
      }
      this.#buffer = this.#buffer.subarray(offset + maskBytes + length);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.#writeFrame(0xa, payload); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.#fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(this.#fragments).toString("utf8");
          this.#fragments = [];
          this.#dispatch(message);
        }
      }
    }
  }

  #dispatch(raw: string): void {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string; code?: number }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try { message = JSON.parse(raw); } catch { return; }
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new CdpError(String(message.error.message ?? "cdp_error").slice(0, 300), message.error.code));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of this.#handlers.get(message.method) ?? []) {
        try { handler(message.params ?? {}, message.sessionId); } catch { /* Handler errors are not ours. */ }
      }
    }
  }
}
