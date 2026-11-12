import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShim } from "../host/shim.js";
import { ensureRunDir } from "../host/socket.js";

let home = "";
let server: net.Server | undefined;
afterEach(() => { server?.close(); server = undefined; rmSync(home, { recursive: true, force: true }); });

async function fakeHost(onLine: (line: string, socket: net.Socket) => void): Promise<{ sockets: net.Socket[] }> {
  home = mkdtempSync(path.join(os.tmpdir(), "ah-shim-"));
  const paths = await ensureRunDir(home);
  const sockets: net.Socket[] = [];
  server = net.createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.includes('"hello"')) socket.write(`${JSON.stringify({ welcome: { protocol: 1, hostPid: 1, sessionId: "h_x" } })}\n`);
        else onLine(line, socket);
      }
    });
  });
  await new Promise<void>((r) => server!.listen(paths.socket, r));
  return { sockets };
}

function collect(stream: PassThrough): string[] {
  const lines: string[] = [];
  let buffer = "";
  stream.on("data", (c: Buffer) => { buffer += c.toString(); let i: number; while ((i = buffer.indexOf("\n")) >= 0) { lines.push(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
  return lines;
}
const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 20)); };

describe("shim", () => {
  it("forwards lines both ways unchanged", async () => {
    const seen: string[] = [];
    await fakeHost((line, socket) => { seen.push(line); socket.write(`{"jsonrpc":"2.0",  "id":1,"result":{"a":[1, 2]}}\n`); });
    const input = new PassThrough(); const output = new PassThrough();
    const out = collect(output);
    const done = runShim({ agentHome: home, input, output, error: new PassThrough() });
    const request = '{"jsonrpc":"2.0",  "id":1,"method":"tools/list"}';
    input.write(`${request}\n`);
    await until(() => out.length > 0);
    expect(seen).toEqual([request]);
    expect(out).toEqual(['{"jsonrpc":"2.0",  "id":1,"result":{"a":[1, 2]}}']);
    input.end();
    expect(await done).toBe(0);
  });

  it("answers an open call with a JSON-RPC error when the host dies, and does not retry", async () => {
    const seen: string[] = [];
    const { sockets } = await fakeHost((line) => { seen.push(line); });
    const input = new PassThrough(); const output = new PassThrough();
    const out = collect(output);
    const done = runShim({ agentHome: home, input, output, error: new PassThrough(), deadGraceMs: 200 });
    input.write('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"click"}}\n');
    await until(() => seen.length > 0);
    sockets.forEach((s) => s.destroy());
    await until(() => out.length > 0);
    const reply = JSON.parse(out[0]!);
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32000, data: { code: "host_disconnected" } } });
    // A later request is answered with the error and never sent anywhere.
    input.write('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"click"}}\n');
    await until(() => out.length > 1);
    expect(JSON.parse(out[1]!).id).toBe(8);
    expect(seen).toHaveLength(1);
    expect(await done).toBe(1);
  });

  it("starts a host when none is running, then connects", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "ah-shim-"));
    const paths = await ensureRunDir(home);
    let started = 0;
    const done = runShim({
      agentHome: home, input: new PassThrough(), output: new PassThrough(), error: new PassThrough(),
      startHost: () => {
        started += 1;
        setTimeout(() => {
          server = net.createServer((s) => { s.on("error", () => undefined); s.on("data", () => s.write('{"welcome":{"protocol":1,"hostPid":1,"sessionId":"h"}}\n')); });
          server.listen(paths.socket);
        }, 150);
      }
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(started).toBe(1);
    server?.close();
    // Ends when its input closes (not closed here), so just stop waiting.
    void done;
  });
});
