import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readRunState, requestPause, requestStop } from "@agenthost/core";
import { helpFor, wantsHelp } from "../help.js";

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function freshHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "agenthost-cli-"));
  homes.push(home);
  return home;
}
function snapshot(home: string): string {
  return JSON.stringify(readdirSync(home, { recursive: true, encoding: "utf8" }).sort().map((entry) => {
    const stat = statSync(path.join(home, entry));
    return [entry, stat.size, stat.mtimeMs, stat.isDirectory()];
  }));
}
function cli(home: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: path.join(home, "config.json") },
    encoding: "utf8"
  });
}

describe("agenthost help", () => {
  it("recognises help anywhere on the line", () => {
    expect(wantsHelp(["agent", "resume", "--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["help", "task"])).toBe(true);
    expect(wantsHelp(["task", "approve", "help"])).toBe(true);
    expect(wantsHelp(["agent", "resume", "--stop"])).toBe(false);
  });

  it("names the command it was asked about", () => {
    expect(helpFor(["agent", "resume", "--help"])).toContain("resume [--stop]");
    expect(helpFor(["--help"])).toContain("version|doctor");
  });

  const COMMANDS: string[][] = [
    ["version"], ["doctor"], ["setup"], ["setup", "deps"], ["start"], ["stop"], ["status"], ["task"], ["task", "approve"],
    ["confirmations"], ["confirm"], ["deny"], ["agent"], ["agent", "resume"], ["agent", "pause"], ["attention"],
    ["workflow"], ["workflow", "run"], ["schedule"], ["schedule", "add"], ["memory"], ["memory", "clear"], ["phone"],
    ["phone", "pair"], ["policy"], ["policy", "add"], ["policy", "remove"], ["capabilities"], ["permissions"], ["sessions"], ["overlay"], ["overlay", "check-input"],
    ["integrations"], ["config"], ["update"], ["uninstall"]
  ];
  it.each(COMMANDS)("agenthost %s --help prints usage and changes nothing", (...parts: string[]) => {
    const home = freshHome();
    mkdirSync(path.join(home, "run"), { recursive: true });
    writeFileSync(path.join(home, "run", "stop.requested"), "{}");
    const before = snapshot(home);
    const out = cli(home, [...parts, "--help"]);
    expect(out.startsWith("usage: agenthost")).toBe(true);
    expect(snapshot(home)).toBe(before);
  });

  it("bare resume clears a pause and names any other active flag", async () => {
    const home = freshHome();
    await requestPause(home, "test pause");
    await requestStop(home, "test stop");
    const out = JSON.parse(cli(home, ["agent", "resume", "--json"]));
    expect(out.ok).toBe(true);
    expect(out.data.note).toBe("Pause cleared.");
    expect(out.data.stillActive.join(" ")).toContain("agenthost agent resume --stop");
    const state = await readRunState(home);
    expect(state.pause.requested).toBe(false);
    expect(state.stop.requested).toBe(true);
  });
});
