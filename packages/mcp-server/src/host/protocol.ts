/*
 * Host wire protocol: newline-delimited JSON over the host socket, both ways.
 * First message from a shim: {"hello":{"protocol":1,"client":"<name>"}}.
 * Host answers {"welcome":{...}} or {"refused":{"code":"protocol_mismatch"}}.
 * After that every line is an MCP JSON-RPC message, forwarded unchanged.
 * Operator messages ({"status":true}, {"shutdown":true}) need no handshake.
 */

export const HOST_PROTOCOL = 1;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export type HelloMessage = { hello: { protocol: number; client: string } };

export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseHello(value: unknown): { protocol: number; client: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const hello = (value as { hello?: unknown }).hello;
  if (typeof hello !== "object" || hello === null) return undefined;
  const { protocol, client } = hello as { protocol?: unknown; client?: unknown };
  if (typeof protocol !== "number") return undefined;
  return { protocol, client: typeof client === "string" ? client.slice(0, 80) : "unknown" };
}

export function jsonRpcError(id: unknown, code: number, message: string, data?: Record<string, unknown>): unknown {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Splits a text stream into lines. A line past `maxBytes` is dropped (to its newline) and reported once. */
export class LineReader {
  private buffer = "";
  private discarding = false;
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOversize: () => void,
    private readonly maxBytes = MAX_MESSAGE_BYTES
  ) {}

  push(chunk: string): void {
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf("\n");
      if (newline < 0) {
        if (this.discarding) return;
        this.buffer += rest;
        if (this.buffer.length > this.maxBytes) {
          this.buffer = "";
          this.discarding = true;
          this.onOversize();
        }
        return;
      }
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      const line = this.buffer + piece;
      this.buffer = "";
      if (Buffer.byteLength(line, "utf8") > this.maxBytes) {
        this.onOversize();
        continue;
      }
      if (line.trim() !== "") this.onLine(line);
    }
  }
}
