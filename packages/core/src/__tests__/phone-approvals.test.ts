import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { consumePhoneCode, createPhonePairing, formatPhoneRequest, isValidChannelUrl, parsePhoneReply, phoneCovers, phoneRequestRef, readPhonePairing } from "../phone-approvals.js";
import type { ConfirmationRecord } from "../confirmations.js";

const directories: string[] = [];
async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenthost-phone-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const urls = { publishUrl: "https://ntfy.sh/private", pollUrl: "https://ntfy.sh/private-replies/json" };

describe("phone approvals", () => {
  it("stores only hashes, so nothing on disk can answer a request", async () => {
    const dir = await home();
    const { codes } = await createPhonePairing(dir, urls);
    expect(codes).toHaveLength(20);
    const file = path.join(dir, "run", "phone.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const raw = await readFile(file, "utf8");
    for (const code of codes) expect(raw).not.toContain(code);
  });

  it("spends each code once", async () => {
    const dir = await home();
    const { codes } = await createPhonePairing(dir, urls);
    expect(await consumePhoneCode(dir, codes[0]!)).toBe(true);
    expect(await consumePhoneCode(dir, codes[0]!)).toBe(false);
    expect(await consumePhoneCode(dir, codes[1]!.toUpperCase())).toBe(true);
    expect((await readPhonePairing(dir))?.codes).toHaveLength(18);
  });

  it("disables the channel after repeated wrong codes, even for a real code", async () => {
    const dir = await home();
    const { codes } = await createPhonePairing(dir, urls);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(await consumePhoneCode(dir, "aaaaaaaaaa")).toBe(false);
    expect((await readPhonePairing(dir))?.disabled).toBe(true);
    expect(await consumePhoneCode(dir, codes[0]!)).toBe(false);
  });

  it("parses only exact replies, so a forwarded request is not an answer", () => {
    expect(parsePhoneReply("  APPROVE ab12cd abcdefgh23 ")).toEqual({ decision: "approve", ref: "ab12cd", code: "abcdefgh23" });
    expect(parsePhoneReply("deny ab12cd abcdefgh23")?.decision).toBe("deny");
    expect(parsePhoneReply("Reply: approve ab12cd <code>  or  deny ab12cd <code>")).toBeUndefined();
    expect(parsePhoneReply("approve ab12cd short")).toBeUndefined();
  });

  it("limits risk, requires https, and never sends the token or a secret", () => {
    const pairing = { maxRisk: "medium" } as never;
    expect(phoneCovers(pairing, "medium")).toBe(true);
    expect(phoneCovers(pairing, "high")).toBe(false);
    expect(phoneCovers({ maxRisk: "high" } as never, "high")).toBe(true);
    expect(phoneCovers({ maxRisk: "high" } as never, "blocked")).toBe(false);
    expect(isValidChannelUrl("http://ntfy.sh/x")).toBe(false);
    const record = { tokenId: "conf_abc", tool: "file.delete", riskLevel: "medium", summary: "Delete a.txt api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789" } as ConfirmationRecord;
    const text = formatPhoneRequest(record);
    expect(text).toContain("Delete a.txt");
    expect(text).toContain(phoneRequestRef("conf_abc"));
    expect(text).not.toContain("conf_abc");
    expect(text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });
});
