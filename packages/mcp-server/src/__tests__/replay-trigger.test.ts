import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cliEntryFor, triggerReplay } from "../replay-trigger.js";

const serverDir = path.join("/opt", "agenthost", "packages", "mcp-server", "dist");
const entry = path.join("/opt", "agenthost", "packages", "agenthost-cli", "dist", "index.js");

function fake() {
  const unref = vi.fn();
  const spawn = vi.fn(() => ({ unref, on: vi.fn() }));
  return { spawn, unref };
}

describe("triggerReplay", () => {
  it("spawns nothing when the switch is off", () => {
    const { spawn } = fake();
    expect(triggerReplay({ enabled: false, taskId: "task_abc", serverDir, spawn, exists: () => true })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("spawns the CLI detached with the exact fixed arguments and no shell", () => {
    const { spawn, unref } = fake();
    expect(triggerReplay({ enabled: true, taskId: "task_abc", serverDir, spawn, exists: (f) => f === entry })).toBe(true);
    expect(cliEntryFor(serverDir)).toBe(entry);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([entry, "replay", "build", "--task", "task_abc"]);
    expect(opts).toMatchObject({ detached: true, stdio: "ignore", shell: false });
    expect(unref).toHaveBeenCalled();
  });
  it("skips silently when the CLI entry is missing or the id is odd", () => {
    const { spawn } = fake();
    expect(triggerReplay({ enabled: true, taskId: "task_abc", serverDir, spawn, exists: () => false })).toBe(false);
    expect(triggerReplay({ enabled: true, taskId: "x; rm -rf /", serverDir, spawn, exists: () => true })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("never throws when spawn fails", () => {
    const spawn = vi.fn(() => { throw new Error("EAGAIN"); });
    expect(triggerReplay({ enabled: true, taskId: "task_abc", serverDir, spawn, exists: () => true })).toBe(false);
  });
});
