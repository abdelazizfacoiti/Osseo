import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessTreeOptions {
  /** Defaults to the host platform. Tests pass "win32" to check the Windows command. */
  platform?: NodeJS.Platform;
  /** Test seam for the taskkill run. Defaults to spawning taskkill with no window. */
  runTaskkill?: (args: string[], fallback: () => void) => void;
}

/**
 * Ends a process and everything it started. On Windows a plain kill ends only the named process,
 * so the tree is walked with `taskkill /T`, and SIGKILL adds `/F`. Elsewhere the signal goes to the
 * process itself, which is what the callers did before.
 */
export function killProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  options: ProcessTreeOptions = {}
): void {
  const platform = options.platform ?? process.platform;
  const fallback = (): void => {
    child.kill(signal);
  };
  if (platform !== "win32" || child.pid === undefined) {
    fallback();
    return;
  }
  const args = ["/pid", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
  if (options.runTaskkill !== undefined) {
    options.runTaskkill(args, fallback);
    return;
  }
  try {
    const tool = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    tool.on("error", fallback);
  } catch {
    fallback();
  }
}
