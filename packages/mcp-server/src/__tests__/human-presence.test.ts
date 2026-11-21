import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { humanActiveNow, waitForHumanToPause } from "../human-presence.js";

const directories: string[] = [];
async function home(agentInputAgoMs?: number): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "osseo-presence-"));
  directories.push(directory);
  if (agentInputAgoMs !== undefined) {
    await mkdir(path.join(directory, "run"), { recursive: true });
    const marker = path.join(directory, "run", "input-active");
    await writeFile(marker, "");
    const at = new Date(Date.now() - agentInputAgoMs);
    await utimes(marker, at, at);
  }
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("yield to the human", () => {
  it("treats recent input as human only when it is newer than the agent's own injection", async () => {
    // Idle 300ms; the agent injected 200ms ago, so that input was the agent's.
    expect(await humanActiveNow({ osseoDir: await home(200), readIdleMs: async () => 300 })).toBe(false);
    // Idle 300ms; the agent injected 5s ago, so something else touched the input.
    expect(await humanActiveNow({ osseoDir: await home(5_000), readIdleMs: async () => 300 })).toBe(true);
    // No agent marker yet and recent input: the human.
    expect(await humanActiveNow({ osseoDir: await home(), readIdleMs: async () => 300 })).toBe(true);
    // Long idle or unknown idle never blocks the agent.
    expect(await humanActiveNow({ osseoDir: await home(5_000), readIdleMs: async () => 4_000 })).toBe(false);
    expect(await humanActiveNow({ osseoDir: await home(5_000), readIdleMs: async () => undefined })).toBe(false);
  });

  it("waits for a pause, and reports busy after the deadline", async () => {
    const osseoDir = await home(60_000);
    const start = Date.now();
    let clock = start;
    const idleReadings = [100, 100, 100, 5_000];
    const sleeps: number[] = [];
    const quiet = await waitForHumanToPause({
      osseoDir, readIdleMs: async () => idleReadings.shift() ?? 5_000, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; }
    });
    expect(quiet).toEqual({ busy: false, waitedMs: 750 });
    expect(sleeps).toEqual([250, 250, 250]);

    clock = start;
    const stuck = await waitForHumanToPause({
      osseoDir, readIdleMs: async () => 50, maxWaitMs: 1_000, now: () => clock, sleep: async (ms) => { clock += ms; }
    });
    expect(stuck.busy).toBe(true);
  });
});
