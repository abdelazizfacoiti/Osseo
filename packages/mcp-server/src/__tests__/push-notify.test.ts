import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { PUSH_MESSAGES, createPushNotifier, isValidPushUrl } from "../push-notify.js";

describe("phone notification", () => {
  it("accepts https and loopback http only", () => {
    expect(isValidPushUrl("https://ntfy.sh/private-topic")).toBe(true);
    expect(isValidPushUrl("http://127.0.0.1:9/x")).toBe(true);
    expect(isValidPushUrl("http://ntfy.sh/topic")).toBe(false);
    expect(isValidPushUrl("not a url")).toBe(false);
  });

  it("does nothing unless configured", async () => {
    let called = false;
    const notify = createPushNotifier(undefined, { fetchImpl: (async () => { called = true; return new Response(); }) as typeof fetch });
    expect(await notify("approval")).toBe(false);
    expect(called).toBe(false);
  });

  it("posts only the fixed generic text, rate limits, and survives failure", async () => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => { bodies.push(body); response.end("ok"); });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let clock = 0;
    const notify = createPushNotifier(`http://127.0.0.1:${(server.address() as AddressInfo).port}/t`, { now: () => clock });
    expect(await notify("approval")).toBe(true);
    expect(await notify("handoff")).toBe(false);
    clock = 31_000;
    expect(await notify("handoff")).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(bodies).toEqual([PUSH_MESSAGES.approval, PUSH_MESSAGES.handoff]);
    const failing = createPushNotifier("https://example.invalid/x", { fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch });
    expect(await failing("approval")).toBe(false);
  });
});
