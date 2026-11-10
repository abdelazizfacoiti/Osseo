import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";

export type PrivateDirectoryResult =
  | { ok: true; method: "posix_mode" | "icacls" }
  | { ok: false; reason: string };

export interface PrivateDirectoryOptions {
  /** Defaults to the host platform. */
  platform?: NodeJS.Platform;
  /** The account to keep. Defaults to DOMAIN\\user from the environment, or the local user name. */
  user?: string;
  /** Test seam for the icacls run. */
  run?: (command: string, args: string[]) => Promise<void>;
}

function runIcacls(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

function currentWindowsUser(env: NodeJS.ProcessEnv): string {
  if (env.USERDOMAIN !== undefined && env.USERNAME !== undefined && env.USERNAME !== "") {
    return `${env.USERDOMAIN}\\${env.USERNAME}`;
  }
  return os.userInfo().username;
}

/**
 * Creates a directory only its owner can read. On POSIX that is mode 0700. File modes do nothing on
 * Windows, so the folder's access list is set instead: inheritance off, then only the current user
 * and SYSTEM kept (icacls). Files written inside inherit that list.
 */
export async function ensurePrivateDirectory(directory: string, options: PrivateDirectoryOptions = {}): Promise<PrivateDirectoryResult> {
  const platform = options.platform ?? process.platform;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform !== "win32") {
    await chmod(directory, 0o700);
    return { ok: true, method: "posix_mode" };
  }
  const user = options.user ?? currentWindowsUser(process.env);
  const run = options.run ?? runIcacls;
  try {
    await run("icacls", [directory, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "/grant:r", "SYSTEM:(OI)(CI)F"]);
    return { ok: true, method: "icacls" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "icacls failed";
    return { ok: false, reason: `Could not restrict ${directory} to the current user: ${message.slice(0, 200)}` };
  }
}
