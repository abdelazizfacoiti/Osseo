import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAllowAdd, claudeAllowRemove } from "../hooks.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function home(settings?: unknown) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-allow-")); dirs.push(dir);
  if (settings !== undefined) { await mkdir(path.join(dir, ".claude"), { recursive: true }); await writeFile(path.join(dir, ".claude", "settings.json"), JSON.stringify(settings)); }
  return dir;
}
const read = async (dir: string) => JSON.parse(await readFile(path.join(dir, ".claude", "settings.json"), "utf8"));

describe("Claude Code allow rules for AgentHost", () => {
  it("previews without writing, then adds the read rules and keeps the person's own rules", async () => {
    const dir = await home({ permissions: { allow: ["Bash(npm test)"] }, theme: "dark" });
    const preview = await claudeAllowAdd(dir, "read", false);
    expect(preview).toMatchObject({ changed: true, applied: false });
    expect((await read(dir)).permissions.allow).toEqual(["Bash(npm test)"]);
    const applied = await claudeAllowAdd(dir, "read", true);
    expect(applied).toMatchObject({ applied: true, backup: true });
    const settings = await read(dir);
    expect(settings.theme).toBe("dark");
    expect(settings.permissions.allow).toEqual(["Bash(npm test)", "mcp__agenthost__status", "mcp__agenthost__windows", "mcp__agenthost__see", "mcp__agenthost__wait"]);
    expect(await claudeAllowAdd(dir, "read", true)).toMatchObject({ configured: true, changed: false });
  });

  it("switches read to all without leaving duplicates, and remove takes only our rules out", async () => {
    const dir = await home({ permissions: { allow: ["Bash(ls)"] } });
    await claudeAllowAdd(dir, "read", true);
    await claudeAllowAdd(dir, "all", true);
    expect((await read(dir)).permissions.allow).toEqual(["Bash(ls)", "mcp__agenthost"]);
    expect(await claudeAllowRemove(dir, true)).toMatchObject({ changed: true, applied: true });
    expect((await read(dir)).permissions.allow).toEqual(["Bash(ls)"]);
  });

  it("creates the file when missing and refuses a settings file it cannot parse", async () => {
    const fresh = await home();
    await claudeAllowAdd(fresh, "all", true);
    expect((await read(fresh)).permissions.allow).toEqual(["mcp__agenthost"]);
    const broken = await home();
    await mkdir(path.join(broken, ".claude"), { recursive: true });
    await writeFile(path.join(broken, ".claude", "settings.json"), "{ not json");
    expect((await claudeAllowAdd(broken, "all", true)).error).toBe("settings_invalid_json");
  });
});
