import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

/*
 * A nested X display (Xephyr) the agent can work in while the person keeps
 * their own screen, mouse, and keyboard. The nested screen shows up as one
 * window on the person's desktop that they can watch, minimize, or close.
 *
 * Everything that acts on the desktop (screenshots, input, windows, app
 * launch) is pointed at it by passing `env` with the nested DISPLAY. It has no
 * window manager unless one is installed in it: windows open at the corner and
 * "active window" means X input focus, which the desktop layer handles.
 */

export interface BackgroundDisplayOptions {
  width?: number;
  height?: number;
  /** First display number to try. */
  firstDisplay?: number;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  startupTimeoutMs?: number;
}

export type BackgroundDisplayResult =
  | { ok: true; display: string; env: NodeJS.ProcessEnv; stop: () => Promise<void> }
  | { ok: false; reason: string };

export function findXephyr(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, "Xephyr");
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Keep looking. */ }
  }
  return undefined;
}

function displayInUse(number: number): boolean {
  return existsSync(`/tmp/.X11-unix/X${number}`) || existsSync(`/tmp/.X${number}-lock`);
}

/** Environment for desktop commands aimed at the nested display. */
export function backgroundEnvironment(base: NodeJS.ProcessEnv, display: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, DISPLAY: display, XDG_SESSION_TYPE: "x11" };
  // The nested server has its own authority rules; the person's cookie is for their display.
  delete env.XAUTHORITY;
  delete env.WAYLAND_DISPLAY;
  return env;
}

export async function startBackgroundDisplay(options: BackgroundDisplayOptions = {}): Promise<BackgroundDisplayResult> {
  const base = options.env ?? process.env;
  const executable = options.executable ?? findXephyr(base);
  if (executable === undefined) return { ok: false, reason: "Xephyr is not installed (apt package xserver-xephyr)." };
  if (base.DISPLAY === undefined || base.DISPLAY === "") return { ok: false, reason: "A nested display needs a running X session to appear in." };
  let number = options.firstDisplay ?? 90;
  while (number < 120 && displayInUse(number)) number += 1;
  if (number >= 120) return { ok: false, reason: "No free display number between :90 and :119." };
  const display = `:${number}`;
  const width = options.width ?? 1280;
  const height = options.height ?? 800;
  const child: ChildProcess = spawn(executable, [display, "-screen", `${width}x${height}`, "-title", "AgentHost background desktop", "-no-host-grab", "-noreset", "-nolisten", "tcp"], { stdio: "ignore", env: base });
  let exited = false;
  child.once("exit", () => { exited = true; });
  child.once("error", () => { exited = true; });
  const deadline = Date.now() + (options.startupTimeoutMs ?? 8_000);
  while (!existsSync(`/tmp/.X11-unix/X${number}`)) {
    if (exited || Date.now() > deadline) {
      if (!exited) child.kill("SIGTERM");
      return { ok: false, reason: exited ? "Xephyr exited during startup." : "Xephyr did not open its display in time." };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stop = (): Promise<void> => new Promise((resolve) => {
    if (exited) { resolve(); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
  return { ok: true, display, env: backgroundEnvironment(base, display), stop };
}
