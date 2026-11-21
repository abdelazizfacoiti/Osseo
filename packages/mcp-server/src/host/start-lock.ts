import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

/*
 * Start lock: <home>/run/host.lock, created O_EXCL with "<pid> <epoch ms>".
 * Held by the process that is starting a host; removed once the host socket
 * is listening, or on failure. A lock older than 30 s whose pid is dead is
 * stale and is taken over. (The CLI keeps an equal copy in osseo-cli/src/host.ts.)
 */

export const START_LOCK_STALE_MS = 30_000;

export const startLockPath = (agentHome: string): string => path.join(agentHome, "run", "host.lock");

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export interface StartLockOptions { now?: () => number; isAlive?: (pid: number) => boolean }
export interface StartLock { release(): Promise<void> }

async function readLock(file: string): Promise<{ pid: number; at: number } | undefined> {
  try {
    const [pid, at] = (await readFile(file, "utf8")).trim().split(/\s+/).map((part) => Number.parseInt(part, 10));
    if (Number.isInteger(pid) && Number.isInteger(at)) return { pid: pid!, at: at! };
    // Created but not yet written by its holder: age it by the file's mtime and treat the holder as alive.
    return { pid: process.pid, at: (await stat(file)).mtimeMs };
  } catch { return undefined; }
}

/** True when a lock file exists and is not stale. */
export async function startLockHeld(agentHome: string, options: StartLockOptions = {}): Promise<boolean> {
  const held = await readLock(startLockPath(agentHome));
  if (held === undefined) return false;
  return !((options.now ?? Date.now)() - held.at > START_LOCK_STALE_MS && !(options.isAlive ?? pidAlive)(held.pid));
}

/** Takes the lock, or returns undefined when another live start holds it. */
export async function acquireStartLock(agentHome: string, options: StartLockOptions = {}): Promise<StartLock | undefined> {
  const file = startLockPath(agentHome);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${(options.now ?? Date.now)()}\n`);
      await handle.close();
      return { release: async () => {
        const mine = await readLock(file);
        if (mine?.pid === process.pid) await rm(file, { force: true });
      } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await startLockHeld(agentHome, options)) return undefined;
      await rm(file, { force: true });
    }
  }
  return undefined;
}
