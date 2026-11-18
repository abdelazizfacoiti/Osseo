import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShim } from "../host/shim.js";
import { ensureRunDir } from "../host/socket.js";
import { acquireStartLock, startLockPath } from "../host/start-lock.js";

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

describe("start lock and reconnect", () => {
  it("lock: exclusive create, live lock refused, stale lock recovered, release removes it", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "ah-shim-"));
    const first = await acquireStartLock(home);
    expect(first).toBeDefined();
    expect(existsSync(startLockPath(home))).toBe(true);
    expect(await acquireStartLock(home)).toBeUndefined();
    await first!.release();
    expect(existsSync(startLockPath(home))).toBe(false);
    writeFileSync(startLockPath(home), `999999999 ${Date.now() - 60_000}\n`);
    const second = await acquireStartLock(home, { isAlive: () => false });
    expect(second).toBeDefined();
    await second!.release();
    // old but alive pid: still held
    writeFileSync(startLockPath(home), `${process.pid} ${Date.now() - 60_000}\n`);
    expect(await acquireStartLock(home, { isAlive: () => true })).toBeUndefined();
  });

  it("first connect fails, one start happens under the lock, second connect succeeds, lock released", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "ah-shim-"));
    const paths = await ensureRunDir(home);
    let started = 0;
    let lockDuringStart = false;
    const input = new PassThrough();
    const done = runShim({
      agentHome: home, input, output: new PassThrough(), error: new PassThrough(),
      startHost: () => {
        started += 1;
        lockDuringStart = existsSync(startLockPath(home));
        setTimeout(() => {
          server = net.createServer((s) => { s.on("error", () => undefined); s.on("data", () => s.write('{"welcome":{"protocol":1,"hostPid":1,"sessionId":"h"}}\n')); });
          server.listen(paths.socket);
        }, 100);
      }
    });
    await until(() => started > 0 && existsSync(paths.socket));
    await new Promise((r) => setTimeout(r, 400));
    expect(started).toBe(1);
    expect(lockDuringStart).toBe(true);
    expect(existsSync(startLockPath(home))).toBe(false);
    input.end();
    expect(await done).toBe(0);
  });

  it("returns the unavailable code when no host starts, so the auto entry can fall back", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "ah-shim-"));
    const code = await runShim({ agentHome: home, input: new PassThrough(), output: new PassThrough(), error: new PassThrough(), startHost: () => undefined, startWaitMs: 200, unavailableCode: 125 });
    expect(code).toBe(125);
  });

  it("two shims starting together start one host", async () => {
    home = mkdtempSync(path.join(os.tmpdir(), "ah-shim-"));
    const paths = await ensureRunDir(home);
    let started = 0;
    const startHost = (): void => {
      started += 1;
      setTimeout(() => {
        server = net.createServer((s) => { s.on("error", () => undefined); s.on("data", () => s.write('{"welcome":{"protocol":1,"hostPid":1,"sessionId":"h"}}\n')); });
        server.listen(paths.socket);
      }, 200);
    };
    const inputs = [new PassThrough(), new PassThrough()];
    const runs = inputs.map((input) => runShim({ agentHome: home, input, output: new PassThrough(), error: new PassThrough(), startHost }));
    await new Promise((r) => setTimeout(r, 900));
    expect(started).toBe(1);
    inputs.forEach((i) => i.end());
    expect(await Promise.all(runs)).toEqual([0, 0]);
  });

  it("a mid-call drop is answered host_disconnected and the tool call is not re-sent", async () => {
    let calls = 0;
    const { sockets } = await fakeHost((line) => { if (line.includes("tools/call")) calls += 1; });
    let started = 0;
    const input = new PassThrough(); const output = new PassThrough();
    const out = collect(output);
    const done = runShim({ agentHome: home, input, output, error: new PassThrough(), deadGraceMs: 150, startHost: () => { started += 1; } });
    input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"click"}}\n');
    await until(() => calls > 0);
    sockets.forEach((s) => s.destroy());
    await until(() => out.length > 0);
    expect(JSON.parse(out[0]!).error.data.code).toBe("host_disconnected");
    expect(await done).toBe(1);
    expect(calls).toBe(1);
    expect(started).toBe(0);
  });
});
