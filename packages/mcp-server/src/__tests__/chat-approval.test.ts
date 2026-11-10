import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareConfirmation, readConfirmation } from "@agenthost/core";
import { askInChat, type ElicitFn } from "../chat-approval.js";

const SESSION = "chat-approval-test";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

async function pending(summary = "Send message to a friend (api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789)") {
  const home = await mkdtemp(path.join(os.tmpdir(), "agenthost-chat-approval-"));
  homes.push(home);
  const record = await prepareConfirmation({ agentHostDir: home, tool: "browser.click", riskLevel: "high", args: { ref: "s1-e1" }, summary, sessionId: SESSION });
  return { home, record };
}

describe("chat approval", () => {
  it("approves on accept with approve=true, and the prompt never shows the token or secrets", async () => {
    const { home, record } = await pending();
    let prompt = "";
    const elicit: ElicitFn = async (params) => { prompt = params.message; return { action: "accept", content: { approve: true } }; };
    expect(await askInChat({ agentHostDir: home, sessionId: SESSION, tokenId: record.tokenId, elicit })).toBe("approved");
    expect((await readConfirmation(home, record.tokenId))?.status).toBe("accepted");
    expect(prompt).toContain("browser.click");
    expect(prompt).not.toContain(record.tokenId);
    expect(prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("denies on decline or approve=false", async () => {
    for (const answer of [{ action: "decline" as const }, { action: "accept" as const, content: { approve: false } }]) {
      const { home, record } = await pending();
      expect(await askInChat({ agentHostDir: home, sessionId: SESSION, tokenId: record.tokenId, elicit: async () => answer })).toBe("denied");
      expect((await readConfirmation(home, record.tokenId))?.status).toBe("rejected");
    }
  });

  it("leaves the token pending when the prompt is cancelled or the client cannot ask", async () => {
    const { home, record } = await pending();
    expect(await askInChat({ agentHostDir: home, sessionId: SESSION, tokenId: record.tokenId, elicit: async () => ({ action: "cancel" }) })).toBe("dismissed");
    expect(await askInChat({ agentHostDir: home, sessionId: SESSION, tokenId: record.tokenId, elicit: async () => { throw new Error("timeout"); } })).toBe("unavailable");
    expect((await readConfirmation(home, record.tokenId))?.status).toBe("pending");
  });

  it("ignores tokens from another session", async () => {
    const { home, record } = await pending();
    let asked = false;
    const outcome = await askInChat({ agentHostDir: home, sessionId: "someone-else", tokenId: record.tokenId, elicit: async () => { asked = true; return { action: "accept", content: { approve: true } }; } });
    expect(outcome).toBe("unavailable");
    expect(asked).toBe(false);
  });
});
