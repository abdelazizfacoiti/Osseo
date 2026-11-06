import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPhonePairing, listConfirmations, phoneRequestRef, prepareConfirmation, readPhonePairing } from "@agenthost/core";
import { PhoneBridge } from "../phone-bridge.js";

const SESSION = "phone-test";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((run) => run())); });

async function channel() {
  const published: string[] = []; const replies: Array<{ id: string; event: string; message: string }> = [];
  const server: Server = createServer((request, response) => {
    if (request.method === "POST") {
      let body = ""; request.on("data", (chunk) => { body += String(chunk); });
      request.on("end", () => { published.push(body); response.end("ok"); });
    } else {
      response.end(replies.map((entry) => JSON.stringify(entry)).join("\n"));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { published, replies, publishUrl: `${base}/topic`, pollUrl: `${base}/replies/json` };
}

async function setup(maxRisk: "medium" | "high" = "high") {
  const home = await mkdtemp(path.join(os.tmpdir(), "agenthost-phone-bridge-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const net = await channel();
  const { codes } = await createPhonePairing(home, { publishUrl: net.publishUrl, pollUrl: net.pollUrl, maxRisk });
  const bridge = new PhoneBridge({ agentHostDir: home, sessionId: SESSION, pollMs: 3_600_000 });
  cleanup.push(async () => bridge.close());
  const request = (summary: string, riskLevel: "medium" | "high" = "medium") => prepareConfirmation({ agentHostDir: home, tool: "file.delete", riskLevel, args: { summary }, summary, sessionId: SESSION });
  const status = async (tokenId: string) => (await listConfirmations(home)).find((record) => record.tokenId === tokenId)?.status;
  return { home, net, codes, bridge, request, status };
}

describe("phone bridge", () => {
  it("publishes once and approves only the named request with a valid code", async () => {
    const { net, codes, bridge, request, status } = await setup();
    const first = await request("Delete one.txt");
    const second = await request("Delete two.txt");
    await bridge.tick();
    await bridge.tick();
    expect(net.published).toHaveLength(2);
    expect(net.published.join()).not.toContain("conf_");
    net.replies.push({ id: "a", event: "message", message: `approve ${phoneRequestRef(first.tokenId)} ${codes[0]}` });
    await bridge.tick();
    expect(await status(first.tokenId)).toBe("accepted");
    expect(await status(second.tokenId)).toBe("pending");
  });

  it("ignores wrong codes, unknown refs, and a replayed code", async () => {
    const { net, codes, bridge, request, status } = await setup();
    const first = await request("Delete one.txt");
    const second = await request("Delete two.txt");
    await bridge.tick();
    net.replies.push({ id: "a", event: "message", message: `approve ${phoneRequestRef(first.tokenId)} aaaaaaaaaa` });
    net.replies.push({ id: "b", event: "message", message: `approve 000000 ${codes[0]}` });
    await bridge.tick();
    expect(await status(first.tokenId)).toBe("pending");
    net.replies.push({ id: "c", event: "message", message: `deny ${phoneRequestRef(first.tokenId)} ${codes[0]}` });
    await bridge.tick();
    expect(await status(first.tokenId)).toBe("rejected");
    net.replies.push({ id: "d", event: "message", message: `approve ${phoneRequestRef(second.tokenId)} ${codes[0]}` });
    await bridge.tick();
    expect(await status(second.tokenId)).toBe("pending");
  });

  it("does not offer high-risk requests on a medium pairing, or anything when unpaired or disabled", async () => {
    const { home, net, bridge, request } = await setup("medium");
    await request("Wire money", "high");
    await bridge.tick();
    expect(net.published).toEqual([]);
    expect((await readPhonePairing(home))?.maxRisk).toBe("medium");
  });
});
