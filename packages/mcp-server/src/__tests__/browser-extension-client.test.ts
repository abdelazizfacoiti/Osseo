import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FrameDecoder, encodeFrame, sendExtensionRequest } from "../browser-extension-client.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function tempSocket(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ah-ext-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "s.sock");
}

/** A fake native host: replies through `respond(request, send)`. */
async function fakeHost(respond: (request: Record<string, unknown>, send: (body: unknown) => void) => void) {
  const socketPath = await tempSocket();
  const received: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk)) {
        received.push(message as Record<string, unknown>);
        respond(message as Record<string, unknown>, (body) => socket.write(encodeFrame(body)));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { socketPath, received };
}

const request = { type: "snapshot" as const, tabId: 3, host: "example.com" };

describe("browser extension client", () => {
  it("round-trips one framed request and returns the reply without the id", async () => {
    const host = await fakeHost((message, send) => send({ id: message.id, ok: true, elements: [{ ref: "s1-e0" }] }));
    const reply = await sendExtensionRequest(request, { socketPath: host.socketPath });
    expect(reply).toEqual({ ok: true, elements: [{ ref: "s1-e0" }] });
    expect(host.received).toHaveLength(1);
    expect(host.received[0]).toMatchObject({ type: "snapshot", tabId: 3, host: "example.com" });
    expect(typeof host.received[0]!.id).toBe("string");
  });

  it("ignores a reply with a different id", async () => {
    const host = await fakeHost((message, send) => {
      send({ id: "someone-else", ok: false, reason: "host_not_allowed" });
      send({ id: message.id, ok: true });
    });
    expect(await sendExtensionRequest(request, { socketPath: host.socketPath })).toEqual({ ok: true });
  });

  it("times out when no matching reply arrives", async () => {
    const host = await fakeHost(() => undefined);
    const reply = await sendExtensionRequest(request, { socketPath: host.socketPath, timeoutMs: 100 });
    expect(reply).toEqual({ ok: false, reason: "timeout" });
  });

  it("reports extension_not_running for a missing socket", async () => {
    const socketPath = await tempSocket();
    expect(await sendExtensionRequest(request, { socketPath })).toEqual({ ok: false, reason: "extension_not_running" });
  });

  it("passes refusals through", async () => {
    const host = await fakeHost((message, send) => send({ id: message.id, ok: false, reason: "password_field" }));
    expect(await sendExtensionRequest({ ...request, type: "type", ref: "s1-e1", text: "x" }, { socketPath: host.socketPath })).toEqual({ ok: false, reason: "password_field" });
  });

  it("keeps the framing copy equal to the extension's protocol.mjs", async () => {
    const protocolPath = path.resolve(__dirname, "../../../browser-extension/src/protocol.mjs");
    const protocol = await import(/* @vite-ignore */ pathToFileURL(protocolPath).href) as { encodeFrame: (m: unknown) => Buffer; FrameDecoder: new () => { push: (c: Buffer) => unknown[] } };
    const message = { id: "a", type: "read", text: "é ✓", n: [1, 2] };
    expect(encodeFrame(message).equals(protocol.encodeFrame(message))).toBe(true);
    const frames = Buffer.concat([protocol.encodeFrame(message), protocol.encodeFrame({ id: "b", ok: true })]);
    const mine = new FrameDecoder();
    const theirs = new protocol.FrameDecoder();
    const split = 7;
    expect([...mine.push(frames.subarray(0, split)), ...mine.push(frames.subarray(split))]).toEqual([...theirs.push(frames.subarray(0, split)), ...theirs.push(frames.subarray(split))]);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(2 * 1024 * 1024, 0);
    expect(() => new FrameDecoder().push(oversized)).toThrow("message_too_large");
    expect(() => new protocol.FrameDecoder().push(oversized)).toThrow("message_too_large");
  });
});
