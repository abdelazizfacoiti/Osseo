import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { integrationStatus } from "../integrations.js";

async function claudeHome(entry: Record<string, unknown>): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agenthost-checkout-"));
  await writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { agenthost: entry } }));
  return home;
}

describe("integration status for a checkout", () => {
  it("counts a registration by the server's path as AgentHost (what the setup guide prints without agenthost on PATH)", async () => {
    const home = await claudeHome({ type: "stdio", command: "node", args: ["C:\\work\\AgentHost\\packages\\mcp-server\\dist\\index.js"], env: {} });
    // `matches` says the entry is AgentHost's; `configured` only says the key exists.
    const report = await integrationStatus("claude", { home, project: home });
    expect(report.configured).toBe(true);
    expect(report.matches).toBe(true);
  });

  it("counts the global agenthost start command, as before", async () => {
    const home = await claudeHome({ type: "stdio", command: "agenthost", args: ["start"] });
    expect((await integrationStatus("claude", { home, project: home })).matches).toBe(true);
  });

  it("does not count another node program that happens to be under the agenthost key", async () => {
    const home = await claudeHome({ type: "stdio", command: "node", args: ["C:\\other\\server.js"] });
    expect((await integrationStatus("claude", { home, project: home })).matches).toBe(false);
  });
});
