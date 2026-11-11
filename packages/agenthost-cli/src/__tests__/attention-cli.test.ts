import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAttention } from "@agenthost/core";
import { attentionCli } from "../attention.js";
import { parseFlags } from "../flags.js";

vi.mock("@agenthost/os-linux", () => ({
  findHostWindow: async () => undefined,
  getLinuxActiveWindow: async () => undefined,
  raiseLinuxWindow: async () => undefined,
  focusLinuxWindow: async () => undefined
}));

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agenthost attention request with Codex's trailing JSON argument", () => {
  it("records source codex and reason done and ignores the appended payload", async () => {
    const agentHome = await mkdtemp(path.join(os.tmpdir(), "agenthost-attention-"));
    roots.push(agentHome);
    const payload = JSON.stringify({ type: "agent-turn-complete", "turn-id": "1", cwd: "/tmp/x", "last-assistant-message": "done --source other" });
    const args = parseFlags(["attention", "request", "--source", "codex", "--reason", "done", payload]);
    const { action, result } = await attentionCli(agentHome, args);
    expect(action).toBe("request");
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ source: "codex", reason: "done" });
    expect(await readAttention(agentHome)).toMatchObject({ source: "codex", reason: "done" });
  });
});
