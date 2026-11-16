import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandOnPath, integrationStatus, serverCommand } from "../integrations.js";

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

describe("server command", () => {
  it("uses cmd /c agenthost on Windows when agenthost is on PATH", () => {
    expect(serverCommand("win32", () => true)).toEqual({ command: "cmd", args: ["/c", "agenthost", "start"] });
  });

  it("runs this copy of the CLI under node on Windows when agenthost is not on PATH", () => {
    const command = serverCommand("win32", () => false);
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toMatch(/(index\.js|agenthost\.mjs)$/);
    expect(command.args[1]).toBe("start");
  });

  it("keeps the agenthost start command on other platforms", () => {
    expect(serverCommand("linux")).toEqual({ command: "agenthost", args: ["start"] });
  });

  it("counts the node form that a checkout writes as AgentHost", async () => {
    const entry = serverCommand("win32", () => false);
    const home = await claudeHome({ type: "stdio", command: entry.command, args: entry.args });
    expect((await integrationStatus("claude", { home, project: home })).matches).toBe(true);
  });
});

describe("commandOnPath", () => {
  it("finds a Windows command by its PATHEXT extension, and a Linux command by its bare name only", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-onpath-"));
    await writeFile(path.join(dir, "claude.exe"), "");
    expect(commandOnPath("claude", "win32", { PATH: dir, PATHEXT: ".COM;.EXE" })).toBe(true);
    expect(commandOnPath("claude", "linux", { PATH: dir })).toBe(false);
    expect(commandOnPath("missing", "win32", { PATH: dir, PATHEXT: ".COM;.EXE" })).toBe(false);
  });
});
