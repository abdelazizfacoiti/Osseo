import { spawn } from "node:child_process";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/*
 * Frame source for the background viewer. It captures the whole nested display
 * with scrot (DISPLAY set to that display, no shell) and writes one file in a
 * directory the caller owns. The viewer window only reads that file. Pictures
 * are never returned through logs or tool results; only timings are reported.
 */

export interface CaptureFrameOptions {
  /** Directory for the frame file; created with mode 0700. */
  directory: string;
  /** File name inside the directory. Default "frame.png" ("frame.jpg" gives a JPEG). */
  fileName?: string;
  timeoutMs?: number;
  /** Capture program; tests point this at a fake. Default "scrot". */
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export type CaptureFrameResult =
  | { ok: true; path: string; bytes: number; ms: number }
  | { ok: false; reason: "bad_display" | "bad_file_name" | "capture_failed" | "timeout" | "empty"; detail?: string };

const DISPLAY_PATTERN = /^:\d{1,4}(\.\d{1,2})?$/;
const FILE_PATTERN = /^[A-Za-z0-9_-]{1,40}\.(png|jpg)$/;

export function isValidDisplay(display: string): boolean { return DISPLAY_PATTERN.test(display); }

export async function captureDisplayFrame(display: string, options: CaptureFrameOptions): Promise<CaptureFrameResult> {
  if (!isValidDisplay(display)) return { ok: false, reason: "bad_display" };
  const fileName = options.fileName ?? "frame.png";
  if (!FILE_PATTERN.test(fileName)) return { ok: false, reason: "bad_file_name" };
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await chmod(options.directory, 0o700);
  const target = path.join(options.directory, fileName);
  // scrot picks the format from the extension, so the temporary name keeps it.
  const temporary = path.join(options.directory, `.tmp-${process.pid}-${fileName}`);
  const started = Date.now();
  const base = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = { ...base, DISPLAY: display };
  delete env.XAUTHORITY;
  delete env.WAYLAND_DISPLAY;
  const outcome = await new Promise<"ok" | "timeout" | string>((resolve) => {
    let settled = false;
    const finish = (value: string): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let child;
    try { child = spawn(options.command ?? "scrot", ["-o", temporary], { env, stdio: "ignore", shell: false }); } catch (error) { resolve(`spawn:${(error as Error).message}`); return; }
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish("timeout"); }, options.timeoutMs ?? 5_000);
    child.once("error", (error) => finish(`spawn:${error.message}`));
    child.once("close", (code) => finish(code === 0 ? "ok" : `exit:${code}`));
  });
  if (outcome !== "ok") {
    await rm(temporary, { force: true });
    return outcome === "timeout" ? { ok: false, reason: "timeout" } : { ok: false, reason: "capture_failed", detail: outcome };
  }
  const info = await stat(temporary).catch(() => undefined);
  if (info === undefined || info.size === 0) { await rm(temporary, { force: true }); return { ok: false, reason: "empty" }; }
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  return { ok: true, path: target, bytes: info.size, ms: Date.now() - started };
}
