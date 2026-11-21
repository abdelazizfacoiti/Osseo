import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/*
 * Opt-in automatic replay (replay.onTaskFinish). The server never imports the CLI:
 * it starts the installed CLI detached with fixed arguments and no shell, and moves on.
 */

export type ReplaySpawn = (command: string, args: string[], options: SpawnOptions) => { unref(): void; on?(event: "error", listener: () => void): unknown };

export interface ReplayTriggerOptions {
  enabled: boolean;
  taskId: string;
  /** Directory of the running server module (packages/mcp-server/dist). */
  serverDir: string;
  spawn?: ReplaySpawn;
  exists?: (file: string) => boolean;
}

/** The CLI entry next to this package: packages/osseo-cli/dist/index.js, in the monorepo and in a release. */
export function cliEntryFor(serverDir: string): string {
  return path.resolve(serverDir, "..", "..", "osseo-cli", "dist", "index.js");
}

/** Starts one detached replay build for the task. Returns true when a child was started. Never throws. */
export function triggerReplay(options: ReplayTriggerOptions): boolean {
  if (!options.enabled || !/^[A-Za-z0-9_-]{1,120}$/.test(options.taskId)) return false;
  try {
    const entry = cliEntryFor(options.serverDir);
    if (!(options.exists ?? existsSync)(entry)) return false;
    const child = (options.spawn ?? (nodeSpawn as unknown as ReplaySpawn))(process.execPath, [entry, "replay", "build", "--task", options.taskId], { detached: true, stdio: "ignore", shell: false, env: process.env });
    child.on?.("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
