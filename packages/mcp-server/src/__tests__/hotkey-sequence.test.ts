import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultPolicy } from "@osseo/core";
import type { OsseoMcpContext } from "../context.js";
import { applyProductionExecutionMetadata } from "../tool-metadata.js";
import { createDesktopTools } from "../tools/desktop.js";
import { runTool } from "../tool-runner.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const tool = applyProductionExecutionMetadata(createDesktopTools()).find((entry) => entry.name === "desktop.hotkey")!;
const window = { windowId: "w1", title: "Blender", appName: "blender", pid: 7 };

async function context(failAt?: number) {
  const home = await mkdtemp(path.join(os.tmpdir(), "osseo-seq-"));
  dirs.push(home);
  const pressed: string[][] = [];
  const ctx = {
    sessionId: "seq",
    config: { osseoDir: home, configPath: path.join(home, "config.json"), logFile: path.join(home, "logs", "audit.jsonl") },
    policy: getDefaultPolicy(),
    logger: { log: async () => undefined },
    linux: {
      getActiveWindow: async () => ({ supported: true, backend: "fake", activeWindow: window }),
      hotkey: async (input: { keys: string[] }) => {
        pressed.push(input.keys);
        const sent = failAt === undefined || pressed.length !== failAt;
        return { supported: true, backend: "fake", sent, keys: input.keys, activeWindow: window, reason: sent ? "ok" : "key refused" };
      }
    }
  } as unknown as OsseoMcpContext;
  return { ctx, pressed };
}

describe("desktop.hotkey sequence", () => {
  it("presses every key or chord in order inside one action", async () => {
    const { ctx, pressed } = await context();
    const result = await runTool(tool, { sequence: ["shift+d", "Escape", "s", "x", "KP_0", "KP_Decimal", "KP_1", "Return"], activeWindow: { windowId: "w1" }, verify: false }, ctx);
    expect(result.ok).toBe(true);
    expect(pressed).toEqual([["shift", "d"], ["Escape"], ["s"], ["x"], ["KP_0"], ["KP_Decimal"], ["KP_1"], ["Return"]]);
  });

  it("stops at the first key that is not sent and says which", async () => {
    const { ctx, pressed } = await context(3);
    const result = await runTool(tool, { sequence: ["a", "b", "c", "d"], activeWindow: { windowId: "w1" }, verify: false }, ctx);
    expect(result.ok).toBe(false);
    expect(pressed).toHaveLength(3);
    expect(JSON.stringify(result)).toContain("step 3 of 4");
  });

  it("refuses keys and sequence together", async () => {
    const { ctx } = await context();
    const result = await runTool(tool, { keys: ["a"], sequence: ["b"], activeWindow: { windowId: "w1" } }, ctx);
    expect(result.error?.code).toBe("invalid_input");
  });
});
