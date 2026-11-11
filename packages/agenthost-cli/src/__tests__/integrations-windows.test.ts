import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAttentionHooks, claudeHooksAdd, claudeHooksRemove, claudeHooksStatus, claudeSettingsPath } from "../hooks.js";
import { integrationAdd, integrationConfigPath, integrationRemove, integrationStatus, serverCommand, type IntegrationPaths } from "../integrations.js";
import { codexNotifyAdd, codexNotifyLine, codexNotifyRemove, codexNotifyState } from "../codex-notify.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function paths(extra: Partial<IntegrationPaths> = {}): Promise<IntegrationPaths> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agenthost-winint-"));
  roots.push(home);
  return { home, project: path.join(home, "project"), platform: "win32", ...extra };
}

describe("integrations with the Windows server command", () => {
  it("starts the server through cmd /c", () => {
    expect(serverCommand("win32")).toEqual({ command: "cmd", args: ["/c", "agenthost", "start"] });
    expect(serverCommand("linux")).toEqual({ command: "agenthost", args: ["start"] });
  });

  it("writes cmd /c entries for JSON clients and reads them back as configured", async () => {
    const p = await paths();
    const copilot = await integrationAdd("copilot", p, true);
    expect(JSON.parse(await readFile(copilot.configPath, "utf8"))).toEqual({ servers: { agenthost: { type: "stdio", command: "cmd", args: ["/c", "agenthost", "start"] } } });
    expect((await integrationStatus("copilot", p)).matches).toBe(true);
    const cli = await integrationAdd("copilot-cli", p, true);
    expect(JSON.parse(await readFile(cli.configPath, "utf8")).mcpServers.agenthost).toEqual({ type: "local", command: "cmd", args: ["/c", "agenthost", "start"], tools: ["*"] });
    const opencode = await integrationAdd("opencode", p, true);
    expect(JSON.parse(await readFile(opencode.configPath, "utf8")).mcp.agenthost).toEqual({ type: "local", command: ["cmd", "/c", "agenthost", "start"] });
    expect((await integrationRemove("copilot", p, true)).applied).toBe(true);
  });

  it("accepts a config file with a byte order mark", async () => {
    const p = await paths();
    const file = integrationConfigPath("cursor", p);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `\uFEFF${JSON.stringify({ mcpServers: { other: { command: "x" } } })}`);
    const report = await integrationAdd("cursor", p, true);
    expect(report.applied).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8")).mcpServers.other).toEqual({ command: "x" });
  });

  it("follows CLAUDE_CONFIG_DIR for the Claude config and hooks", async () => {
    const p = await paths();
    const dir = path.join(p.home, "claude-config");
    const q = { ...p, claudeConfigDir: dir };
    expect(integrationConfigPath("claude", q)).toBe(path.join(dir, ".claude.json"));
    expect(integrationConfigPath("claude", p)).toBe(path.join(p.home, ".claude.json"));
    expect(claudeSettingsPath(p.home, dir)).toBe(path.join(dir, "settings.json"));
    expect(claudeSettingsPath(p.home)).toBe(path.join(p.home, ".claude", "settings.json"));
  });

  it("writes the Codex entry and notify through cmd, including in a CRLF file", async () => {
    const p = await paths({ codexHome: path.join(os.tmpdir(), "unused") });
    const home = path.join(p.home, "codex");
    const q = { ...p, codexHome: home };
    const file = integrationConfigPath("codex", q);
    await mkdir(home, { recursive: true });
    await writeFile(file, "model = \"x\"\r\n\r\n[mcp_servers.agenthost]\r\ncommand = \"agenthost\"\r\nargs = [\"start\"]\r\n\r\n[other]\r\na = 1\r\n");
    const report = await integrationAdd("codex", q, true);
    expect(report.applied).toBe(true);
    const text = await readFile(file, "utf8");
    expect(text).toContain("command = \"cmd\"");
    expect(text).toContain("args = [\"/c\", \"agenthost\", \"start\"]");
    expect(text).toContain("notify = [\"cmd\", \"/c\", \"agenthost\", \"attention\", \"request\", \"--source\", \"codex\", \"--reason\", \"done\"]");
    expect(text).toContain("[other]");
    expect((text.match(/\[mcp_servers\.agenthost\]/g) ?? []).length).toBe(1);
    expect((await integrationStatus("codex", q)).matches).toBe(true);
    expect((await integrationAdd("codex", q, true)).changed).toBe(false);
    expect((await integrationRemove("codex", q, true)).applied).toBe(true);
    const after = await readFile(file, "utf8");
    expect(after).not.toContain("agenthost");
    expect(after).toContain("[other]");
  });

  it("recognises both notify forms and never replaces a foreign one", () => {
    expect(codexNotifyState(`${codexNotifyLine("win32")}\n`)).toMatchObject({ ours: true, matches: true });
    expect(codexNotifyState(`${codexNotifyLine("linux")}\n`)).toMatchObject({ ours: true, matches: true });
    expect(codexNotifyAdd("notify = [\"other\"]\n", "win32").text).toBe("notify = [\"other\"]\n");
    expect(codexNotifyAdd(`${codexNotifyLine("linux")}\n`, "win32").text).toBe(`${codexNotifyLine("win32")}\n`);
    expect(codexNotifyAdd("", "linux").text).toBe(`${codexNotifyLine("linux")}\n`);
    expect(codexNotifyRemove(`${codexNotifyLine("win32")}\n`).removed).toBe(true);
  });
});

describe("Claude hooks on Windows", () => {
  it("uses a plain program call instead of the POSIX shell guard", () => {
    const windows = claudeAttentionHooks("win32");
    const post = JSON.stringify(windows.PostToolUse);
    expect(post).toContain("agenthost attention clear --restore");
    expect(post).not.toMatch(/\[ -f|\|\| true|\$HOME|\$\{/);
    for (const entries of Object.values(windows)) for (const entry of entries) for (const hook of entry.hooks) expect(hook.command).not.toMatch(/[\[\]|&;$]/);
    expect(JSON.stringify(claudeAttentionHooks("linux").PostToolUse)).toContain("[ -f");
  });

  it("replaces the Linux form on upgrade and removes only its own entries", async () => {
    const p = await paths();
    const file = claudeSettingsPath(p.home);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } }));
    await claudeHooksAdd(p.home, true, { platform: "linux" });
    expect((await claudeHooksStatus(p.home, { platform: "win32" })).configured).toBe(false);
    expect(await claudeHooksAdd(p.home, true, { platform: "win32" })).toMatchObject({ applied: true, configured: true });
    const settings = JSON.parse(await readFile(file, "utf8")) as { hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(JSON.stringify(settings)).not.toContain("[ -f");
    expect(await claudeHooksAdd(p.home, true, { platform: "win32" })).toMatchObject({ changed: false });
    await claudeHooksRemove(p.home, true, { platform: "win32" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }] } });
  });
});
