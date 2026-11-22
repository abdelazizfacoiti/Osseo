import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  classifyAppSensitivity,
  normalizePathForPolicy,
  redactSensitiveText,
  type DesktopCapabilitiesResult,
  type DesktopCapabilitySupport,
  type DesktopClickResult,
  type DesktopPointerResult,
  type DesktopGetActiveWindowResult,
  type DesktopHotkeyResult,
  type DesktopMouseButton,
  type DesktopScreenshotResult,
  type DesktopSessionType,
  type DesktopTypeTextResult,
  type DesktopWindowBounds,
  type DesktopWindowContext,
  type DesktopWindowSummary,
  type WindowFocusResult,
  type WindowListResult
} from "@osseo/core";
import { detectLinuxAccessibilitySupport, type LinuxAccessibilityContext } from "./accessibility.js";
import { findCommandPath, type LinuxLookupContext } from "./dependencies.js";
import { leaseGtkClipboard, readGtkClipboard, restoreGtkClipboard } from "./gtk-clipboard.js";
import { runSafeLinuxCommand } from "./shell.js";

export interface LinuxDesktopContext extends LinuxLookupContext {
  osseoDir?: string;
}

export interface LinuxDesktopScreenshotInput {
  path: string;
  includeActiveWindowOnly?: boolean;
  format?: "png" | "jpeg";
  quality?: number;
  scale?: number;
  region?: { x: number; y: number; width: number; height: number };
  /** Pixels to cut from each side of the finished picture (for example the always-on edge frame). Needs ffmpeg. */
  trim?: { left: number; top: number; right: number; bottom: number };
}

export interface LinuxDesktopHotkeyInput {
  keys: string[];
  /** Times to send the chord (1-50). Repeats are spaced 20 ms apart. */
  repeat?: number;
  activeWindow: DesktopWindowContext;
}

export interface LinuxDesktopTypeTextInput {
  text: string;
  activeWindow: DesktopWindowContext;
}

export interface LinuxDesktopClickInput {
  x: number;
  y: number;
  button?: DesktopMouseButton;
  activeWindow: DesktopWindowContext;
}
export interface LinuxDesktopPointerInput { action: "move_mouse" | "scroll" | "double_click" | "right_click" | "drag"; activeWindow: DesktopWindowContext; x?: number; y?: number; direction?: "up" | "down" | "left" | "right"; amount?: number; startX?: number; startY?: number; endX?: number; endY?: number; durationMs?: number; }

export interface LinuxWindowListInput {
  limit?: number;
  includeTitles?: boolean;
}

export interface LinuxWindowFocusInput {
  windowId?: string;
  appName?: string;
  title?: string;
  pid?: number;
}

interface SessionInfo {
  sessionType: DesktopSessionType;
  displayAvailable: boolean;
  backend: string;
}

interface RawWindowSummary extends DesktopWindowSummary {
  title?: string;
}

function sessionInfo(context: LinuxDesktopContext = {}): SessionInfo {
  const env = context.env ?? process.env;
  const raw = (env.XDG_SESSION_TYPE ?? "").trim().toLowerCase();

  if (raw === "x11") {
    return {
      sessionType: "x11",
      displayAvailable: Boolean(env.DISPLAY),
      backend: "x11"
    };
  }

  if (raw === "wayland") {
    // A Wayland session that also exposes XWayland (DISPLAY) can be driven with
    // the X11 tools, but only for X11 clients: native Wayland windows are
    // invisible to xdotool, wmctrl, and scrot.
    const xwayland = Boolean(env.DISPLAY);
    return {
      sessionType: "wayland",
      displayAvailable: Boolean(env.WAYLAND_DISPLAY) || xwayland,
      backend: xwayland ? "xwayland" : "wayland"
    };
  }

  if (env.DISPLAY !== undefined && env.DISPLAY.length > 0) {
    return {
      sessionType: "x11",
      displayAvailable: true,
      backend: "x11"
    };
  }

  if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY.length > 0) {
    return {
      sessionType: "wayland",
      displayAvailable: true,
      backend: "wayland"
    };
  }

  return {
    sessionType: "unknown",
    displayAvailable: false,
    backend: "unavailable"
  };
}

function support(backend: string, reason: string): DesktopCapabilitySupport {
  return {
    supported: true,
    backend,
    reason
  };
}

function unsupported(backend: string, reason: string): DesktopCapabilitySupport {
  return {
    supported: false,
    backend,
    reason
  };
}

function unsupportedResult<T extends { supported: boolean; backend: string; reason: string }>(
  backend: string,
  reason: string,
  extra: Omit<T, "supported" | "backend" | "reason">
): T {
  return {
    ...extra,
    supported: false,
    backend,
    reason
  } as T;
}

function trimLine(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Canonical window-id form is the decimal string. xdotool prints decimal
 * ids while wmctrl prints `0x...` hex for the same window; comparing or
 * echoing raw values across backends never matches, so hex is folded to
 * decimal at every boundary. `wmctrl -i -a` accepts decimal ids.
 */
function normalizeWindowId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    return String(parseInt(trimmed, 16));
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

async function statBytes(filePath: string): Promise<number | undefined> {
  try {
    const stats = await lstat(filePath);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}

async function readProcessName(pid: number): Promise<string | undefined> {
  try {
    return trimLine(await readFile(path.join("/proc", String(pid), "comm"), "utf8"));
  } catch {
    return undefined;
  }
}

async function runDesktopCommand(
  command: string,
  args: string[],
  context: LinuxDesktopContext = {}
): Promise<Awaited<ReturnType<typeof runSafeLinuxCommand>>> {
  const input: {
    command: string;
    args: string[];
    timeoutMs: number;
    maxOutputBytes: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {
    command,
    args,
    timeoutMs: 5_000,
    maxOutputBytes: 128 * 1024
  };

  if (context.osseoDir !== undefined) {
    input.cwd = context.osseoDir;
  }

  // Without this a nested display would silently act on the person's real
  // screen. Only the display target changes: context.env.PATH is for locating
  // tools, and the tools themselves keep the normal environment.
  if (context.env?.DISPLAY !== undefined) {
    const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: context.env.DISPLAY };
    if (context.env.XAUTHORITY === undefined) delete env.XAUTHORITY;
    else env.XAUTHORITY = context.env.XAUTHORITY;
    input.env = env;
  }

  return runSafeLinuxCommand(input);
}

function redactTitle(title: string | undefined): string | undefined {
  if (title === undefined) {
    return undefined;
  }

  return trimLine(redactSensitiveText(title));
}

function summarizeWindow(raw: RawWindowSummary, includeTitles: boolean): DesktopWindowSummary {
  const summary: DesktopWindowSummary = {
    windowId: raw.windowId
  };

  if (raw.appName !== undefined) {
    summary.appName = raw.appName;
    summary.appSensitivity = raw.appSensitivity ?? classifyAppSensitivity({ appName: raw.appName });
  }

  if (includeTitles) {
    const title = redactTitle(raw.title);

    if (title !== undefined) {
      summary.title = title;
    }
  }

  if (raw.pid !== undefined) {
    summary.pid = raw.pid;
  }

  if (raw.bounds !== undefined) {
    summary.bounds = raw.bounds;
  }

  return summary;
}

function contextMatches(current: DesktopWindowContext | undefined, expected: DesktopWindowContext): boolean {
  if (current === undefined) {
    return false;
  }

  const currentId = normalizeWindowId(current.windowId);
  const expectedId = normalizeWindowId(expected.windowId);
  if (expectedId !== undefined && currentId !== expectedId) {
    return false;
  }

  if (expected.pid !== undefined && current.pid !== expected.pid) {
    return false;
  }

  if (expected.appName !== undefined && current.appName !== expected.appName) {
    return false;
  }

  if (expected.title !== undefined && current.title !== expected.title) {
    return false;
  }

  return true;
}

async function detectActiveWindowSupport(context: LinuxDesktopContext = {}): Promise<DesktopCapabilitySupport> {
  const session = sessionInfo(context);

  if (!session.displayAvailable) {
    return unsupported("unavailable", "No Linux desktop display session is available.");
  }

  if (session.sessionType === "wayland" && session.backend !== "xwayland") {
    return unsupported("wayland", "Wayland active-window inspection is unavailable with the current safe backends.");
  }

  const xdotoolPath = await findCommandPath("xdotool", context);

  if (xdotoolPath === undefined) {
    return unsupported("unavailable", "Active-window inspection requires xdotool on X11.");
  }

  return support("xdotool", session.backend === "xwayland" ? "Active-window inspection is available through xdotool for XWayland (X11) windows only; native Wayland windows are not visible." : "Active-window inspection is available through xdotool.");
}

async function detectScreenshotSupport(context: LinuxDesktopContext = {}): Promise<DesktopCapabilitySupport> {
  const session = sessionInfo(context);

  if (!session.displayAvailable) {
    return unsupported("unavailable", "No Linux desktop display session is available.");
  }

  const gnomeScreenshotPath = await findCommandPath("gnome-screenshot", context);

  if (gnomeScreenshotPath !== undefined) {
    return support("gnome-screenshot", "Screenshot capture is available through gnome-screenshot.");
  }

  if (session.sessionType === "x11" || session.backend === "xwayland") {
    const scrotPath = await findCommandPath("scrot", context);

    if (scrotPath !== undefined) {
      return support("scrot", session.backend === "xwayland" ? "Screenshot capture is available through scrot, which sees XWayland (X11) windows only; native Wayland windows appear blank." : "Screenshot capture is available through scrot.");
    }

    const importPath = await findCommandPath("import", context);

    if (importPath !== undefined) {
      return support("imagemagick-import", "Screenshot capture is available through ImageMagick import.");
    }
  }

  return unsupported(session.sessionType === "wayland" ? "wayland" : "unavailable", "No safe screenshot backend is available in this session.");
}

async function detectWindowListSupport(context: LinuxDesktopContext = {}): Promise<DesktopCapabilitySupport> {
  const session = sessionInfo(context);

  if (!session.displayAvailable) {
    return unsupported("unavailable", "No Linux desktop display session is available.");
  }

  if (session.sessionType === "wayland" && session.backend !== "xwayland") {
    return unsupported("wayland", "Wayland window listing is unavailable with the current safe backends.");
  }

  const wmctrlPath = await findCommandPath("wmctrl", context);

  if (wmctrlPath === undefined) {
    return unsupported("unavailable", "Window listing requires wmctrl on X11.");
  }

  return support("wmctrl", session.backend === "xwayland" ? "Window listing is available through wmctrl for XWayland (X11) windows only." : "Window listing is available through wmctrl.");
}

async function detectWindowFocusSupport(context: LinuxDesktopContext = {}): Promise<DesktopCapabilitySupport> {
  const supportStatus = await detectWindowListSupport(context);

  if (!supportStatus.supported) {
    return supportStatus;
  }

  return support("wmctrl", "Window focus is available through wmctrl.");
}

async function detectGuiInputSupport(context: LinuxDesktopContext = {}): Promise<DesktopCapabilitySupport> {
  const session = sessionInfo(context);

  if (!session.displayAvailable) {
    return unsupported("unavailable", "No Linux desktop display session is available.");
  }

  if (session.sessionType !== "x11" && session.backend !== "xwayland") {
    return unsupported(session.backend, "Direct GUI input needs X11 or XWayland. On native Wayland, set execution.placement to background to work on a nested X display.");
  }

  const xdotoolPath = await findCommandPath("xdotool", context);

  if (xdotoolPath === undefined) {
    return unsupported("unavailable", "Generic GUI input requires xdotool on X11.");
  }

  return support("xdotool", session.backend === "xwayland" ? "GUI input is available through xdotool for XWayland (X11) windows only; it cannot reach native Wayland windows." : "Generic GUI input is available through xdotool.");
}

const capabilitiesCacheTtlMs = 30_000;
const capabilitiesCache = new Map<string, { at: number; result: DesktopCapabilitiesResult }>();
const screenshotHashes = new Map<string, string>();

async function markScreenshotUnchanged(result: DesktopScreenshotResult, outputPath: string, key: string): Promise<DesktopScreenshotResult> {
  if (result.supported !== true || result.bytesWritten === undefined || result.bytesWritten <= 0) return result;
  try {
    const digest = createHash("sha256").update(await readFile(outputPath)).digest("hex");
    const unchanged = screenshotHashes.get(key) === digest;
    screenshotHashes.delete(key);
    screenshotHashes.set(key, digest);
    while (screenshotHashes.size > 32) screenshotHashes.delete(screenshotHashes.keys().next().value!);
    return { ...result, unchanged };
  } catch {
    return result;
  }
}

export function clearDesktopCapabilitiesCache(): void {
  capabilitiesCache.clear();
}

function capabilitiesCacheKey(context: LinuxDesktopContext): string {
  const env = context.env ?? process.env;
  return [
    env.XDG_SESSION_TYPE ?? "",
    env.DISPLAY ?? "",
    env.WAYLAND_DISPLAY ?? "",
    env.PATH ?? "",
    context.homeDir ?? "",
    context.osseoDir ?? ""
  ].join("\0");
}

export async function getLinuxDesktopCapabilities(
  context: LinuxAccessibilityContext = {}
): Promise<DesktopCapabilitiesResult> {
  const cacheable = context.runAccessibilityQuery === undefined;
  const cacheKey = capabilitiesCacheKey(context);
  const cached = cacheable ? capabilitiesCache.get(cacheKey) : undefined;

  if (cached !== undefined && Date.now() - cached.at < capabilitiesCacheTtlMs) {
    return cached.result;
  }

  const session = sessionInfo(context);
  const [activeWindow, screenshot, windowList, windowFocus, accessibility, guiInput] = await Promise.all([
    detectActiveWindowSupport(context),
    detectScreenshotSupport(context),
    detectWindowListSupport(context),
    detectWindowFocusSupport(context),
    detectLinuxAccessibilitySupport(context),
    detectGuiInputSupport(context)
  ]);

  const result: DesktopCapabilitiesResult = {
    platform: "linux",
    sessionType: session.sessionType,
    displayAvailable: session.displayAvailable,
    backend: session.backend,
    activeWindow,
    screenshot,
    windowList,
    windowFocus,
    accessibility,
    guiInput
  };
  if (cacheable) {
    capabilitiesCache.set(cacheKey, { at: Date.now(), result });
  }
  return result;
}

/** The window holding X input focus, for displays without an EWMH window manager. */
async function focusedWindowId(xdotoolPath: string, context: LinuxDesktopContext): Promise<string | undefined> {
  const focus = await runDesktopCommand(xdotoolPath, ["getwindowfocus"], context).catch(() => undefined);
  const id = focus === undefined || focus.exitCode !== 0 ? undefined : normalizeWindowId(focus.stdout.split(/\r?\n/)[0] ?? "");
  return id !== undefined && /^[0-9]+$/.test(id) && id !== "0" ? id : undefined;
}

async function activeWindowViaXdotool(
  xdotoolPath: string,
  context: LinuxDesktopContext = {}
): Promise<DesktopGetActiveWindowResult> {
  // getactivewindow only seeds the window stack when chained and prints
  // nothing, so the wid needs its own spawn: a chained
  // `getactivewindow getwindowpid getwindowname` yields `pid/title` and the
  // pid is then misread as the window id. pid+title share a second spawn
  // with an explicit wid (both print reliably with explicit args).
  const widResult = await runDesktopCommand(xdotoolPath, ["getactivewindow"], context);
  let windowId = normalizeWindowId(widResult.stdout.split(/\r?\n/)[0] ?? "");

  if (widResult.exitCode !== 0 || windowId === undefined) {
    // No EWMH window manager (for example a nested background display): the X
    // input focus is the only notion of an active window.
    windowId = await focusedWindowId(xdotoolPath, context);
  }

  if (windowId === undefined) {
    return unsupportedResult("xdotool", "Unable to determine the active window on X11.", {});
  }

  const rest = await runDesktopCommand(xdotoolPath, ["getwindowpid", windowId, "getwindowname", windowId], context);
  const lines = rest.stdout.split(/\r?\n/);
  const pidValue = (lines[0] ?? "").trim();
  const pid = /^\d+$/.test(pidValue) ? Number(pidValue) : undefined;
  const appName = pid !== undefined ? await readProcessName(pid) : undefined;
  const title = redactTitle(lines.slice(1).join("\n").trim() || undefined);
  const activeWindow: DesktopWindowContext = {
    windowId
  };

  if (title !== undefined) {
    activeWindow.title = title;
  }

  if (pid !== undefined) {
    activeWindow.pid = pid;
  }

  if (appName !== undefined) {
    activeWindow.appName = appName;
    activeWindow.appSensitivity = classifyAppSensitivity({ appName });
  }

  return {
    supported: true,
    backend: "xdotool",
    activeWindow,
    reason: "Read the active X11 window through xdotool."
  };
}

export async function getLinuxActiveWindow(
  context: LinuxDesktopContext = {}
): Promise<DesktopGetActiveWindowResult> {
  const supportStatus = await detectActiveWindowSupport(context);

  if (!supportStatus.supported) {
    return unsupportedResult(supportStatus.backend, supportStatus.reason, {});
  }

  const xdotoolPath = await findCommandPath("xdotool", context);

  if (xdotoolPath === undefined) {
    return unsupportedResult("unavailable", "Active-window inspection requires xdotool on X11.", {});
  }

  return activeWindowViaXdotool(xdotoolPath, context);
}

export async function getLinuxScreenGeometry(context: LinuxDesktopContext = {}): Promise<{ supported: boolean; bounds?: DesktopWindowBounds; reason: string }> { const xdotool = await findCommandPath("xdotool", context); if (xdotool === undefined) return { supported: false, reason: "Screen geometry requires xdotool on X11." }; const values = resultValues((await runDesktopCommand(xdotool, ["getdisplaygeometry"], context)).stdout); const width = values[0], height = values[1]; if (width === undefined || height === undefined || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return { supported: false, reason: "Unable to read X11 display geometry." }; return { supported: true, bounds: { x: 0, y: 0, width, height }, reason: "Read X11 display geometry." }; }
function resultValues(value: string): number[] { return value.trim().split(/\s+/).map(Number); }
export async function getLinuxActiveWindowBounds(context: LinuxDesktopContext = {}): Promise<{ supported: boolean; bounds?: DesktopWindowBounds; reason: string }> {
  const xdotool = await findCommandPath("xdotool", context);
  if (xdotool === undefined) return { supported: false, reason: "Window geometry requires xdotool on X11." };
  const id = (await runDesktopCommand(xdotool, ["getactivewindow"], context)).stdout.trim() || (await focusedWindowId(xdotool, context)) || "";
  if (!id) return { supported: false, reason: "No active window." };
  // xdotool adds a server-side title bar to the window's position (Blender sat 37 px lower than it is); xwininfo has the real one.
  const real = await trueWindowRect(id, context);
  if (real !== undefined) return { supported: true, bounds: real, reason: "Read active X11 window geometry." };
  const result = await runDesktopCommand(xdotool, ["getwindowgeometry", "--shell", id], context);
  const values = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map((line) => line.split("=", 2)).filter(([key, value]) => key !== undefined && value !== undefined));
  const x = Number(values.X), y = Number(values.Y), width = Number(values.WIDTH), height = Number(values.HEIGHT);
  return [x, y, width, height].every(Number.isInteger) && width > 0 && height > 0 ? { supported: true, bounds: { x, y, width, height }, reason: "Read active X11 window geometry." } : { supported: false, reason: "Unable to read active window geometry." };
}

/** Parses `xwininfo -id` output into the window's absolute client rectangle; exported for tests. */
export function parseXwininfoRect(stdout: string): DesktopWindowBounds | undefined {
  const num = (label: string): number | undefined => { const hit = new RegExp(`^\\s*${label}:\\s*(-?\\d+)`, "m").exec(stdout); return hit === null ? undefined : Number(hit[1]); };
  const x = num("Absolute upper-left X"), y = num("Absolute upper-left Y"), width = num("Width"), height = num("Height");
  return x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0 ? undefined : { x, y, width, height };
}

/** The window's true screen rectangle from xwininfo, or undefined when xwininfo is missing or fails. */
async function trueWindowRect(windowId: string, context: LinuxDesktopContext = {}): Promise<DesktopWindowBounds | undefined> {
  const xwininfo = await findCommandPath("xwininfo", context);
  if (xwininfo === undefined) return undefined;
  const result = await runDesktopCommand(xwininfo, ["-id", windowId], context).catch(() => undefined);
  return result === undefined || result.exitCode !== 0 ? undefined : parseXwininfoRect(result.stdout);
}

/**
 * A cheap picture of the active window for effect checks (did the screen change?), not for showing to anyone.
 * One chained xdotool call reads the window rectangle, and one scrot call grabs that rectangle: about 45 ms,
 * against about 200 ms for the full active-window screenshot (scrot -u plus validation). Returns false when it
 * cannot (no scrot, no active window, rectangle off screen) so the caller falls back to the full screenshot.
 */
export async function captureLinuxWindowFast(input: { path: string }, context: LinuxDesktopContext = {}): Promise<boolean> {
  if (process.env.OSSEO_NO_FAST_CAPTURE === "1") return false;
  const [xdotool, scrot] = await Promise.all([findCommandPath("xdotool", context), findCommandPath("scrot", context)]);
  if (xdotool === undefined || scrot === undefined) return false;
  let rect = await runDesktopCommand(xdotool, ["getactivewindow", "getwindowgeometry", "--shell"], context);
  // No window manager (a bare nested display) has no active window; the focused one stands in, as everywhere else.
  if (rect.exitCode !== 0) rect = await runDesktopCommand(xdotool, ["getwindowfocus", "getwindowgeometry", "--shell"], context);
  if (rect.exitCode !== 0) return false;
  const values = Object.fromEntries(rect.stdout.trim().split(/\r?\n/).map((line) => line.split("=", 2)).filter(([key, value]) => key !== undefined && value !== undefined));
  let x = Number(values.X), y = Number(values.Y), width = Number(values.WIDTH), height = Number(values.HEIGHT);
  // Same correction as getLinuxActiveWindowBounds: a window with a server-side title bar is reported too low by xdotool.
  const real = values.WINDOW === undefined ? undefined : await trueWindowRect(values.WINDOW, context);
  if (real !== undefined) ({ x, y, width, height } = real);
  if (![x, y, width, height].every(Number.isInteger) || width <= 0 || height <= 0 || x < 0 || y < 0) return false;
  try { await rm(input.path, { force: true }); } catch { return false; }
  const shot = await runDesktopCommand(scrot, ["-o", "-a", `${x},${y},${width},${height}`, input.path], context);
  return shot.exitCode === 0 && (await statBytes(input.path)) !== undefined;
}

async function runAndValidateScreenshot(
  backend: string,
  command: string,
  args: string[],
  outputPath: string,
  activeWindow: DesktopWindowContext | undefined,
  context: LinuxDesktopContext = {}
): Promise<DesktopScreenshotResult> {
  try {
    await rm(outputPath, { force: true });
  } catch {
    return {
      supported: false,
      backend,
      ...(activeWindow === undefined ? {} : { activeWindow }),
      reason: "Unable to replace the existing screenshot output file."
    };
  }

  const result = await runDesktopCommand(command, args, context);
  const bytesWritten = await statBytes(outputPath);

  if (result.exitCode !== 0 || bytesWritten === undefined || bytesWritten === 0) {
    return {
      supported: false,
      backend,
      ...(activeWindow === undefined ? {} : { activeWindow }),
      reason: "The screenshot backend did not produce a non-empty image file."
    };
  }

  return {
    supported: true,
    backend,
    path: outputPath,
    bytesWritten,
    ...(activeWindow === undefined ? {} : { activeWindow }),
    reason: "Captured a desktop screenshot locally."
  };
}

function validateScreenshotOptions(input: LinuxDesktopScreenshotInput, format: "png" | "jpeg"): string | undefined {
  if (input.region !== undefined && input.includeActiveWindowOnly === true) {
    return "Region capture cannot be combined with active-window capture.";
  }
  if (input.region !== undefined && (![input.region.x, input.region.y, input.region.width, input.region.height].every(Number.isInteger) || input.region.width <= 0 || input.region.height <= 0)) {
    return "Region capture requires positive integer coordinates and dimensions.";
  }
  if (input.trim !== undefined && !Object.values(input.trim).every((value) => Number.isInteger(value) && value >= 0)) {
    return "Screenshot trim requires non-negative integers.";
  }
  if (input.scale !== undefined && (!Number.isFinite(input.scale) || input.scale < 0.1 || input.scale > 1)) {
    return "Screenshot scale must be between 0.1 and 1.";
  }
  if (input.quality !== undefined && (format !== "jpeg" || !Number.isInteger(input.quality) || input.quality < 1 || input.quality > 100)) {
    return "Screenshot quality requires JPEG format and an integer between 1 and 100.";
  }
  return undefined;
}

/** Writes a JPEG no wider than maxWidth. False when ffmpeg is missing or fails, so the inline picture is simply skipped. */
export async function downscaleToJpeg(inputPath: string, outputPath: string, maxWidth: number, context: LinuxDesktopContext = {}): Promise<boolean> {
  const ffmpeg = await findCommandPath("ffmpeg", context);
  if (ffmpeg === undefined) return false;
  const result = await runDesktopCommand(ffmpeg, ["-y", "-loglevel", "error", "-i", inputPath, "-vf", `scale='min(${Math.max(64, Math.floor(maxWidth))},iw)':-2`, "-frames:v", "1", "-q:v", "6", outputPath], context);
  return result.exitCode === 0 && (await statBytes(outputPath)) !== undefined;
}

export async function captureLinuxScreenshot(
  input: LinuxDesktopScreenshotInput,
  context: LinuxDesktopContext = {}
): Promise<DesktopScreenshotResult> {
  const outputPath = normalizePathForPolicy(
    input.path,
    context.osseoDir === undefined ? {} : { osseoDir: context.osseoDir }
  );
  const format = input.format ?? (/\.jpe?g$/i.test(outputPath) ? "jpeg" : "png");
  const invalid = validateScreenshotOptions(input, format);
  if (invalid !== undefined) {
    return unsupportedResult("unavailable", invalid, {});
  }
  const supportStatus = await detectScreenshotSupport(context);

  if (!supportStatus.supported) {
    return unsupportedResult(supportStatus.backend, supportStatus.reason, {});
  }

  try {
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  } catch {
    return unsupportedResult(supportStatus.backend, "Unable to create the screenshot output directory.", {});
  }

  const backend = supportStatus.backend;
  const nativeRegion = backend === "scrot" && input.region !== undefined;
  const trimNeeded = input.trim !== undefined && input.trim.left + input.trim.top + input.trim.right + input.trim.bottom > 0;
  const transformNeeded = format === "jpeg" || input.scale !== undefined || trimNeeded || (input.region !== undefined && !nativeRegion);
  const tempPath = transformNeeded
    ? path.join(path.dirname(outputPath), `.osseo-capture-${randomUUID()}.png`)
    : outputPath;
  const capturePath = transformNeeded ? tempPath : outputPath;
  const ffmpeg = transformNeeded ? await findCommandPath("ffmpeg", context) : undefined;
  if (transformNeeded && ffmpeg === undefined) {
    return unsupportedResult(backend, "Screenshot format, scale, and region post-processing requires ffmpeg on PATH.", {});
  }

  let captured: DesktopScreenshotResult;
  if (backend === "gnome-screenshot") {
    const command = await findCommandPath("gnome-screenshot", context);

    if (command === undefined) {
      return unsupportedResult("unavailable", "gnome-screenshot is no longer available on PATH.", {});
    }

    const args = input.includeActiveWindowOnly ? ["-w", "-f", capturePath] : ["-f", capturePath];
    captured = await runAndValidateScreenshot("gnome-screenshot", command, args, capturePath, undefined, context);
  } else if (backend === "scrot") {
    const scrotPath = await findCommandPath("scrot", context);

    if (scrotPath === undefined) {
      return unsupportedResult("unavailable", "scrot is no longer available on PATH.", {});
    }

    const activeWindow = input.includeActiveWindowOnly ? await getLinuxActiveWindow(context) : undefined;

    if (input.includeActiveWindowOnly && (activeWindow?.supported !== true || activeWindow.activeWindow === undefined)) {
      return unsupportedResult("scrot", "Active-window screenshots require active-window inspection support.", {});
    }

    const args = input.includeActiveWindowOnly
      ? ["-u", capturePath]
      : input.region === undefined
        ? [capturePath]
        : ["-a", `${input.region.x},${input.region.y},${input.region.width},${input.region.height}`, capturePath];
    captured = await runAndValidateScreenshot(
      "scrot",
      scrotPath,
      args,
      capturePath,
      activeWindow?.supported ? activeWindow.activeWindow : undefined,
      context
    );
  } else {
    const importPath = await findCommandPath("import", context);

    if (importPath === undefined) {
      return unsupportedResult("unavailable", "ImageMagick import is no longer available on PATH.", {});
    }

    let activeWindow: DesktopWindowContext | undefined;
    let args = ["-window", "root", capturePath];

    if (input.includeActiveWindowOnly) {
      const activeWindowResult = await getLinuxActiveWindow(context);

      if (!activeWindowResult.supported || activeWindowResult.activeWindow?.windowId === undefined) {
        return unsupportedResult(
          "imagemagick-import",
          "Active-window screenshots require active-window inspection support.",
          {}
        );
      }

      activeWindow = activeWindowResult.activeWindow;
      args = ["-window", activeWindowResult.activeWindow.windowId, capturePath];
    }

    captured = await runAndValidateScreenshot("imagemagick-import", importPath, args, capturePath, activeWindow, context);
  }

  if (captured.supported !== true) {
    if (transformNeeded) await rm(tempPath, { force: true }).catch(() => undefined);
    return captured;
  }

  if (!transformNeeded) {
    return markScreenshotUnchanged(captured, outputPath, `${outputPath}:${format}:${input.includeActiveWindowOnly === true ? "window" : "screen"}:${JSON.stringify(input.region ?? null)}:${input.scale ?? 1}`);
  }

  const filters: string[] = [];
  if (trimNeeded && input.trim !== undefined) {
    filters.push(`crop=iw-${input.trim.left + input.trim.right}:ih-${input.trim.top + input.trim.bottom}:${input.trim.left}:${input.trim.top}`);
  }
  if (input.region !== undefined && !nativeRegion) {
    filters.push(`crop=${input.region.width}:${input.region.height}:${input.region.x}:${input.region.y}`);
  }
  if (input.scale !== undefined && input.scale !== 1) {
    filters.push(`scale=trunc(iw*${input.scale}/2)*2:trunc(ih*${input.scale}/2)*2`);
  }
  const ffmpegArgs = ["-y", "-loglevel", "error", "-i", tempPath];
  if (filters.length > 0) ffmpegArgs.push("-vf", filters.join(","));
  ffmpegArgs.push("-frames:v", "1");
  if (format === "jpeg") {
    ffmpegArgs.push("-q:v", String(Math.max(2, Math.min(31, Math.round(31 - (input.quality ?? 85) * 0.29)))));
  }
  ffmpegArgs.push(outputPath);

  const transform = await runDesktopCommand(ffmpeg!, ffmpegArgs, context);
  const bytesWritten = transform.exitCode === 0 ? await statBytes(outputPath) : undefined;
  await rm(tempPath, { force: true }).catch(() => undefined);
  if (transform.exitCode !== 0 || bytesWritten === undefined || bytesWritten === 0) {
    return unsupportedResult(`${backend}+ffmpeg`, "Screenshot post-processing failed.", {});
  }
  return markScreenshotUnchanged({
    ...captured,
    backend: `${backend}+ffmpeg`,
    path: outputPath,
    bytesWritten,
    reason: "Captured and post-processed a desktop screenshot locally."
  }, outputPath, `${outputPath}:${format}:${input.includeActiveWindowOnly === true ? "window" : "screen"}:${JSON.stringify(input.region ?? null)}:${input.scale ?? 1}`);
}

function xdotoolButton(button: DesktopMouseButton): string {
  switch (button) {
    case "left":
      return "1";
    case "middle":
      return "2";
    case "right":
      return "3";
  }
}

async function verifyX11ActionContext(
  expected: DesktopWindowContext,
  context: LinuxDesktopContext = {}
): Promise<
  | { ok: false; backend: string; reason: string }
  | { ok: true; backend: string; xdotoolPath: string; activeWindow: DesktopWindowContext }
> {
  const supportStatus = await detectGuiInputSupport(context);

  if (!supportStatus.supported) {
    return { ok: false, backend: supportStatus.backend, reason: supportStatus.reason };
  }

  const xdotoolPath = await findCommandPath("xdotool", context);

  if (xdotoolPath === undefined) {
    return { ok: false, backend: "unavailable", reason: "Generic GUI input requires xdotool on X11." };
  }

  const current = await activeWindowViaXdotool(xdotoolPath, context);

  if (!current.supported || current.activeWindow === undefined) {
    return { ok: false, backend: "xdotool", reason: "Unable to verify the current active window." };
  }

  if (!contextMatches(current.activeWindow, expected)) {
    // Focus often drifts back to the agent's terminal between calls. When the
    // caller pinned an exact window, bring that window back once and re-verify
    // instead of failing; input still only ever goes to the requested window.
    const refocused = await refocusExpectedWindow(expected, xdotoolPath, context);
    if (refocused === undefined) {
      return { ok: false, backend: "xdotool", reason: "The active window no longer matches the required context." };
    }
    return { ok: true, backend: "xdotool", xdotoolPath, activeWindow: refocused };
  }

  return {
    ok: true,
    backend: "xdotool",
    xdotoolPath,
    activeWindow: current.activeWindow
  };
}

async function refocusExpectedWindow(
  expected: DesktopWindowContext,
  xdotoolPath: string,
  context: LinuxDesktopContext
): Promise<DesktopWindowContext | undefined> {
  const windowId = normalizeWindowId(expected.windowId);
  if (windowId === undefined) return undefined;
  const wmctrlPath = await findCommandPath("wmctrl", context);
  if (wmctrlPath === undefined) return undefined;
  const activation = await activateWindowById(windowId, wmctrlPath, xdotoolPath, context);
  if (!activation.focused) return undefined;
  const after = await activeWindowViaXdotool(xdotoolPath, context);
  return after.activeWindow !== undefined && contextMatches(after.activeWindow, expected) ? after.activeWindow : undefined;
}

/**
 * xdotool expects a hotkey chord as one key-sequence argument, for example
 * `ctrl+l`. Passing the keys as separate arguments (`CTRL`, `L`) releases the
 * modifier before sending the letter, which turns Ctrl+L into a literal L.
 */
export function xdotoolHotkeyArguments(keys: string[], repeat = 1): string[] {
  if (repeat > 1) return ["key", "--repeat", String(repeat), "--repeat-delay", "20", keys.join("+")];
  return ["key", keys.join("+")];
}

export type TypingMethod = "direct" | "clipboard";

/**
 * Clipboard paste is the default for all text. Direct `xdotool type` maps each
 * character through the active keyboard layout, and on AZERTY it silently swapped
 * W and Z, so direct typing must be an explicit choice, never the default.
 */
export function describeTypingStrategy(text: string): TypingMethod {
  return text.length === 0 ? "direct" : "clipboard";
}

async function feedClipboard(command: string, args: string[], text: string, context: LinuxDesktopContext): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // xclip and xsel fork a background owner that keeps serving the selection.
      // If it inherited piped stdout/stderr, "close" would never fire until the
      // owner exits, so every paste would time out. Ignore their output instead.
      child = spawn(command, args, { env: context.env ?? process.env, stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      resolve(false);
    }, 5_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
    try {
      if (child.stdin === null) {
        clearTimeout(timer);
        resolve(false);
        return;
      }
      child.stdin.on("error", () => { clearTimeout(timer); resolve(false); });
      child.stdin.write(text);
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function readClipboard(command: string, args: string[], context: LinuxDesktopContext): Promise<string | undefined> {
  const result = await runDesktopCommand(command, args, context);
  return result.exitCode === 0 ? result.stdout : undefined;
}

/**
 * The paste key for the focused app. Terminals never paste on plain Ctrl+V: they
 * receive a literal control character. GNOME Terminal and VTE apps paste on
 * Ctrl+Shift+V, and xterm pastes on Shift+Insert.
 */
const TERMINAL_APPS = new Set(["gnome-terminal-", "gnome-terminal", "mate-terminal", "xfce4-terminal", "konsole", "tilix", "terminator", "alacritty", "kitty", "wezterm-gui", "foot", "ptyxis", "lxterminal", "qterminal", "guake", "tilda", "sakura", "urxvt", "st"]);
export function pasteKeyFor(appName: string | undefined): string {
  const name = appName?.toLowerCase();
  if (name === undefined) return "ctrl+v";
  if (TERMINAL_APPS.has(name)) return "ctrl+shift+v";
  if (name === "xterm") return "shift+Insert";
  return "ctrl+v";
}

/** Time the target gets to read the clipboard before the old contents are restored. */
const PASTE_SETTLE_MS = 350;

/**
 * The minimum wait comes first: a target can take a moment before it reads the clipboard, and a
 * settle check alone could pass during that pause. Then the caller's settle check (when given)
 * waits until the window stops changing.
 */
async function waitForPasteToLand(settle?: () => Promise<unknown>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_MS));
  if (settle !== undefined) await settle().catch(() => undefined);
}

async function pasteViaClipboard(
  xdotoolPath: string,
  text: string,
  context: LinuxDesktopContext, pasteKey = "ctrl+v", settle?: () => Promise<unknown>): Promise<{ ok: boolean; reason: string }> {
  const xclip = await findCommandPath("xclip", context);
  const xsel = xclip === undefined ? await findCommandPath("xsel", context) : undefined;
  if (xclip === undefined && xsel === undefined) return await pasteViaGtkClipboard(xdotoolPath, text, context, pasteKey, settle);
  const clipboardCommand = xclip ?? xsel!;
  const readArgs = xclip !== undefined ? ["-selection", "clipboard", "-o"] : ["--clipboard", "--output"];
  const writeArgs = xclip !== undefined ? ["-selection", "clipboard", "-i"] : ["--clipboard", "--input"];
  const previousClipboard = await readClipboard(clipboardCommand, readArgs, context);
  const fed = xclip !== undefined
    ? await feedClipboard(xclip, ["-selection", "clipboard", "-i"], text, context)
    : await feedClipboard(xsel!, ["--clipboard", "--input"], text, context);
  if (!fed) return { ok: false, reason: "The clipboard backend did not accept the text." };
  const paste = await runDesktopCommand(xdotoolPath, ["key", pasteKey], context);
  await waitForPasteToLand(settle);
  if (paste.exitCode !== 0) return { ok: false, reason: "The clipboard paste hotkey did not complete successfully." };
  const restored = previousClipboard === undefined
    ? false
    : await feedClipboard(clipboardCommand, writeArgs, previousClipboard, context);
  return restored
    ? { ok: true, reason: "Pasted text via the clipboard (layout-independent) and restored the prior clipboard contents." }
    : { ok: true, reason: "Pasted text via the clipboard (layout-independent); prior clipboard contents could not be restored." };
}

export interface LinuxClipboardResult {
  supported: boolean;
  backend: "xclip" | "xsel" | "gtk" | "windows" | "unavailable";
  text?: string;
  reason: string;
}

/** Puts text on the CLIPBOARD so the user or agent can paste it anywhere. */
export async function setLinuxClipboard(text: string, context: LinuxDesktopContext = {}): Promise<LinuxClipboardResult> {
  const xclip = await findCommandPath("xclip", context);
  const xsel = xclip === undefined ? await findCommandPath("xsel", context) : undefined;
  if (xclip !== undefined || xsel !== undefined) {
    // xclip/xsel fork a background owner that keeps serving the selection.
    const fed = xclip !== undefined
      ? await feedClipboard(xclip, ["-selection", "clipboard", "-i"], text, context)
      : await feedClipboard(xsel!, ["--clipboard", "--input"], text, context);
    return { supported: fed, backend: xclip !== undefined ? "xclip" : "xsel", reason: fed ? "Set the clipboard." : "The clipboard backend did not accept the text." };
  }
  const held = await restoreGtkClipboard(text, context);
  return held
    ? { supported: true, backend: "gtk", reason: "Set the clipboard through the built-in GTK helper." }
    : { supported: false, backend: "unavailable", reason: "No clipboard backend: install xclip or python3-gi." };
}

export async function getLinuxClipboard(context: LinuxDesktopContext = {}): Promise<LinuxClipboardResult> {
  const xclip = await findCommandPath("xclip", context);
  const xsel = xclip === undefined ? await findCommandPath("xsel", context) : undefined;
  const text = xclip !== undefined
    ? await readClipboard(xclip, ["-selection", "clipboard", "-o"], context)
    : xsel !== undefined
      ? await readClipboard(xsel, ["--clipboard", "--output"], context)
      : await readGtkClipboard(context);
  const backend = xclip !== undefined ? "xclip" : xsel !== undefined ? "xsel" : "gtk";
  return text === undefined
    ? { supported: false, backend, reason: "The clipboard is empty or holds no text." }
    : { supported: true, backend, text, reason: "Read the clipboard text." };
}

async function pasteViaGtkClipboard(
  xdotoolPath: string,
  text: string,
  context: LinuxDesktopContext, pasteKey = "ctrl+v", settle?: () => Promise<unknown>): Promise<{ ok: boolean; reason: string }> {
  const previousClipboard = await readGtkClipboard(context);
  const lease = await leaseGtkClipboard(text, context);
  if (lease === undefined) {
    return { ok: false, reason: "Layout-unsafe characters require a clipboard backend; install xclip (sudo apt install xclip) or python3-gi for non-ASCII typing." };
  }
  const paste = await runDesktopCommand(xdotoolPath, ["key", pasteKey], context);
  await waitForPasteToLand(settle);
  // The target app requests the selection asynchronously after Ctrl+V; keep
  // ownership long enough for that round-trip before releasing it.
  await new Promise((resolve) => setTimeout(resolve, 250));
  lease.release();
  if (paste.exitCode !== 0) return { ok: false, reason: "The clipboard paste hotkey did not complete successfully." };
  const restored = previousClipboard !== undefined && await restoreGtkClipboard(previousClipboard, context);
  return {
    ok: true,
    reason: restored
      ? "Pasted text via the built-in GTK clipboard helper (layout-independent; xclip not installed) and restored the prior clipboard contents."
      : "Pasted text via the built-in GTK clipboard helper (layout-independent; xclip not installed)."
  };
}

/** Best-effort read of the currently active window id for verification and focus restoration. */
async function readActiveWindowId(
  xdotoolPath: string | undefined,
  context: LinuxDesktopContext
): Promise<string | undefined> {
  if (xdotoolPath === undefined) return undefined;
  try {
    const id = normalizeWindowId((await runDesktopCommand(xdotoolPath, ["getactivewindow"], context)).stdout.trim());
    return id !== undefined && /^[0-9]+$/.test(id) ? id : await focusedWindowId(xdotoolPath, context);
  } catch {
    return undefined;
  }
}

async function activateWindowById(
  windowId: string,
  wmctrlPath: string,
  xdotoolPath: string | undefined,
  context: LinuxDesktopContext
): Promise<{ focused: boolean; backend: string; reason: string }> {
  const targetId = normalizeWindowId(windowId) ?? windowId;
  const wmctrl = await runDesktopCommand(wmctrlPath, ["-i", "-a", targetId], context);

  if (xdotoolPath === undefined) {
    return wmctrl.exitCode === 0
      ? {
          focused: true,
          backend: "wmctrl",
          reason: "Focused the requested X11 window through wmctrl; focus could not be independently verified."
        }
      : {
          focused: false,
          backend: "wmctrl",
          reason: "wmctrl could not focus the requested window."
        };
  }

  if ((await readActiveWindowId(xdotoolPath, context)) === targetId) {
    return {
      focused: true,
      backend: "wmctrl",
      reason: "Focused the requested X11 window through wmctrl."
    };
  }

  const fallback = await runDesktopCommand(xdotoolPath, ["windowactivate", "--sync", targetId], context);

  if (fallback.exitCode === 0 && (await readActiveWindowId(xdotoolPath, context)) === targetId) {
    return {
      focused: true,
      backend: "xdotool",
      reason: "Focused the requested X11 window through xdotool after wmctrl did not change the active window."
    };
  }

  // Without a window manager there is nothing to activate through; give the window X input focus directly.
  await runDesktopCommand(xdotoolPath, ["windowfocus", targetId], context).catch(() => undefined);
  await runDesktopCommand(xdotoolPath, ["windowraise", targetId], context).catch(() => undefined);
  if ((await readActiveWindowId(xdotoolPath, context)) === targetId) {
    return {
      focused: true,
      backend: "xdotool",
      reason: "Focused the requested X11 window by X input focus (no EWMH window manager)."
    };
  }

  return {
    focused: false,
    backend: "xdotool",
    reason: wmctrl.exitCode === 0
      ? "The window manager reported success, but the requested window did not become active."
      : "Neither wmctrl nor xdotool could focus the requested window."
  };
}

export async function sendLinuxHotkey(
  input: LinuxDesktopHotkeyInput,
  context: LinuxDesktopContext = {}
): Promise<DesktopHotkeyResult> {
  const verification = await verifyX11ActionContext(input.activeWindow, context);

  if (!verification.ok) {
    return {
      supported: false,
      backend: verification.backend,
      sent: false,
      keys: input.keys,
      activeWindow: input.activeWindow,
      reason: verification.reason
    };
  }

  const result = await runDesktopCommand(verification.xdotoolPath, xdotoolHotkeyArguments(input.keys, input.repeat), context);

  return {
    supported: result.exitCode === 0,
    backend: verification.backend,
    sent: result.exitCode === 0,
    keys: input.keys,
    activeWindow: verification.activeWindow,
    reason: result.exitCode === 0 ? "Sent a hotkey to the active X11 window." : "The hotkey backend did not complete successfully."
  };
}

export interface TypeLinuxTextOptions {
  /** Called after a clipboard paste, before the old clipboard is restored: lets the caller wait until the target has read the paste. */
  settle?: () => Promise<unknown>;
}

export async function typeLinuxText(
  input: LinuxDesktopTypeTextInput,
  context: LinuxDesktopContext = {},
  options: TypeLinuxTextOptions = {}
): Promise<DesktopTypeTextResult> {
  const method = describeTypingStrategy(input.text);
  const verification = await verifyX11ActionContext(input.activeWindow, context);

  if (!verification.ok) {
    return {
      supported: false,
      backend: verification.backend,
      typed: false,
      characterCount: input.text.length,
      activeWindow: input.activeWindow,
      method,
      reason: verification.reason
    };
  }

  if (method === "clipboard") {
    const paste = await pasteViaClipboard(verification.xdotoolPath, input.text, context, pasteKeyFor(verification.activeWindow?.appName), options.settle);
    return {
      supported: paste.ok,
      backend: verification.backend,
      typed: paste.ok,
      characterCount: input.text.length,
      activeWindow: verification.activeWindow,
      method,
      reason: paste.reason
    };
  }

  const result = await runDesktopCommand(verification.xdotoolPath, ["type", "--delay", "0", "--", input.text], context);

  return {
    supported: result.exitCode === 0,
    backend: verification.backend,
    typed: result.exitCode === 0,
    characterCount: input.text.length,
    activeWindow: verification.activeWindow,
    method,
    reason: result.exitCode === 0 ? "Typed text into the active X11 window." : "The type-text backend did not complete successfully."
  };
}

export async function clickLinuxDesktop(
  input: LinuxDesktopClickInput,
  context: LinuxDesktopContext = {}
): Promise<DesktopClickResult> {
  const verification = await verifyX11ActionContext(input.activeWindow, context);
  const button = input.button ?? "left";

  if (!verification.ok) {
    return {
      supported: false,
      backend: verification.backend,
      clicked: false,
      x: input.x,
      y: input.y,
      button,
      activeWindow: input.activeWindow,
      reason: verification.reason
    };
  }

  const result = await runDesktopCommand(
    verification.xdotoolPath,
    ["mousemove", String(input.x), String(input.y), "click", xdotoolButton(button)],
    context
  );

  return {
    supported: result.exitCode === 0,
    backend: verification.backend,
    clicked: result.exitCode === 0,
    x: input.x,
    y: input.y,
    button,
    activeWindow: verification.activeWindow,
    reason: result.exitCode === 0 ? "Clicked the active X11 window at the requested coordinates." : "The click backend did not complete successfully."
  };
}

async function x11Geometry(xdotoolPath: string, context: LinuxDesktopContext): Promise<{ width: number; height: number } | undefined> {
  const result = await runDesktopCommand(xdotoolPath, ["getdisplaygeometry"], context);
  const [width, height] = result.stdout.trim().split(/\s+/).map(Number);
  return width !== undefined && height !== undefined && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : undefined;
}

function inside(x: number, y: number, geometry: { width: number; height: number }): boolean { return x >= 0 && y >= 0 && x < geometry.width && y < geometry.height; }

export async function performLinuxPointerAction(input: LinuxDesktopPointerInput, context: LinuxDesktopContext = {}): Promise<DesktopPointerResult> {
  const verification = await verifyX11ActionContext(input.activeWindow, context);
  if (!verification.ok) return { supported: false, backend: verification.backend, performed: false, action: input.action, activeWindow: input.activeWindow, reason: verification.reason };
  const geometry = await x11Geometry(verification.xdotoolPath, context);
  if (geometry === undefined) return { supported: false, backend: verification.backend, performed: false, action: input.action, activeWindow: verification.activeWindow, reason: "Unable to determine safe X11 screen bounds." };
  const points = input.action === "drag" ? [[input.startX, input.startY], [input.endX, input.endY]] : input.x === undefined ? [] : [[input.x, input.y]];
  if (points.some(([x, y]) => x === undefined || y === undefined || !inside(x, y, geometry))) return { supported: false, backend: verification.backend, performed: false, action: input.action, activeWindow: verification.activeWindow, reason: "Pointer coordinates are outside safe X11 screen bounds." };
  let args: string[];
  if (input.action === "move_mouse") args = ["mousemove", String(input.x), String(input.y)];
  else if (input.action === "scroll") { const button = input.direction === "up" ? "4" : input.direction === "down" ? "5" : input.direction === "left" ? "6" : "7"; const wheel = ["click", "--repeat", String(input.amount ?? 3), button]; args = input.x === undefined ? wheel : ["mousemove", String(input.x), String(input.y), ...wheel]; }
  else if (input.action === "double_click") args = input.x === undefined ? ["click", "--repeat", "2", "--delay", "100", "1"] : ["mousemove", String(input.x), String(input.y), "click", "--repeat", "2", "--delay", "100", "1"];
  else if (input.action === "right_click") args = input.x === undefined ? ["click", "3"] : ["mousemove", String(input.x), String(input.y), "click", "3"];
  else args = ["mousemove", String(input.startX), String(input.startY), "mousedown", "1", "mousemove", String(input.endX), String(input.endY), "mouseup", "1"];
  const result = await runDesktopCommand(verification.xdotoolPath, args, context);
  return { supported: result.exitCode === 0, backend: verification.backend, performed: result.exitCode === 0, action: input.action, activeWindow: verification.activeWindow, reason: result.exitCode === 0 ? "Performed bounded X11 pointer action." : pointerFailureReason(result) };
}

function pointerFailureReason(result: { stderr: string; timedOut: boolean }): string {
  if (result.timedOut) return "Pointer backend timed out.";
  const detail = trimLine(redactSensitiveText(result.stderr))?.slice(0, 200);
  return detail === undefined ? "Pointer backend did not complete successfully." : `Pointer backend did not complete successfully: ${detail}`;
}

function parseWmctrlLine(line: string): RawWindowSummary | undefined {
  const match = line.match(/^(\S+)\s+\S+\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s*(.*)$/);

  if (match === null) {
    return undefined;
  }

  const windowId = normalizeWindowId(match[1] ?? "");
  const pidRaw = match[2];
  const xRaw = match[3];
  const yRaw = match[4];
  const widthRaw = match[5];
  const heightRaw = match[6];
  const titleRaw = match[7] ?? "";
  const pid = Number(pidRaw);
  const x = Number(xRaw);
  const y = Number(yRaw);
  const width = Number(widthRaw);
  const height = Number(heightRaw);
  const title = trimLine(titleRaw);

  if (windowId === undefined) {
    return undefined;
  }

  return {
    windowId,
    ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
    ...(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(width) && Number.isFinite(height)
      ? {
          bounds: {
            x,
            y,
            width,
            height
          }
        }
      : {}),
    ...(title === undefined ? {} : { title })
  };
}

const WINDOW_LIST_CACHE_TTL_MS = 2_000;
const windowListCache = new Map<string, { at: number; windows: RawWindowSummary[] }>();

export function clearWindowListCache(): void {
  windowListCache.clear();
}

async function listRawWindows(context: LinuxDesktopContext = {}): Promise<  | { supported: false; backend: string; reason: string }
  | { supported: true; backend: string; windows: RawWindowSummary[]; reason: string }
> {
  const supportStatus = await detectWindowListSupport(context);

  if (!supportStatus.supported) {
    return {
      supported: false,
      backend: supportStatus.backend,
      reason: supportStatus.reason
    };
  }

  // Window enumeration spawns wmctrl plus one /proc read per window. Cache the
  // raw listing briefly: focus-by-name and observe flows poll it in bursts,
  // and a 2s window keeps app switching snappy without going stale.
  const cacheKey = (context.env?.DISPLAY ?? process.env.DISPLAY ?? "") + "\0" + (context.env?.XAUTHORITY ?? process.env.XAUTHORITY ?? "");
  const cached = windowListCache.get(cacheKey);

  if (cached !== undefined && Date.now() - cached.at < WINDOW_LIST_CACHE_TTL_MS) {
    return {
      supported: true,
      backend: "wmctrl",
      windows: cached.windows,
      reason: "Listed visible X11 windows through wmctrl."
    };
  }

  const wmctrlPath = await findCommandPath("wmctrl", context);

  if (wmctrlPath === undefined) {
    return {
      supported: false,
      backend: "unavailable",
      reason: "Window listing requires wmctrl on X11."
    };
  }

  const result = await runDesktopCommand(wmctrlPath, ["-lpG"], context);

  if (result.exitCode !== 0) {
    // No EWMH window manager: list the root's top-level children instead.
    const fallback = await listToplevelWindowsWithoutWm(context);
    if (fallback !== undefined) {
      windowListCache.set(cacheKey, { at: Date.now(), windows: fallback });
      return { supported: true, backend: "xwininfo", windows: fallback, reason: "Listed top-level X11 windows through xwininfo (no EWMH window manager)." };
    }
    return {
      supported: false,
      backend: "wmctrl",
      reason: "wmctrl did not return a window list."
    };
  }

  const windows: RawWindowSummary[] = [];
  const absolute = await absoluteWindowGeometry(context);

  for (const line of result.stdout.split(/\r?\n/)) {
    const parsed = parseWmctrlLine(line);

    if (parsed === undefined) {
      continue;
    }

    const corrected = absolute.get(parsed.windowId);
    if (corrected !== undefined) parsed.bounds = corrected;

    if (parsed.pid !== undefined) {
      const appName = await readProcessName(parsed.pid);

      if (appName !== undefined) {
        parsed.appName = appName;
        parsed.appSensitivity = classifyAppSensitivity({ appName });
      }
    }

    windows.push(parsed);
  }

  windowListCache.set(cacheKey, { at: Date.now(), windows });

  return {
    supported: true,
    backend: "wmctrl",
    windows,
    reason: "Listed visible X11 windows through wmctrl."
  };
}

const XWININFO_CHILD = /^\s*(0x[0-9a-f]+)\s+(?:"([^"]*)"|\(has no name\)):?\s*(?:\("([^"]*)"\s+"([^"]*)"\)|\(\))?\s*(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+?(-?\d+)\+?(-?\d+)\s*$/i;

/** Parses `xwininfo -root -children` into top-level windows; exported for tests. */
export function parseXwininfoChildren(output: string): Array<{ windowId: string; title?: string; appClass?: string; bounds: DesktopWindowBounds }> {
  const windows: Array<{ windowId: string; title?: string; appClass?: string; bounds: DesktopWindowBounds }> = [];
  for (const line of output.split(/\r?\n/)) {
    const match = XWININFO_CHILD.exec(line);
    if (match === null) continue;
    const width = Number(match[5]), height = Number(match[6]);
    if (width <= 1 || height <= 1) continue;
    windows.push({
      windowId: String(Number.parseInt(match[1]!, 16)),
      ...(match[2] === undefined || match[2] === "" ? {} : { title: match[2] }),
      ...(match[4] === undefined ? {} : { appClass: match[4] }),
      bounds: { x: Number(match[7]), y: Number(match[8]), width, height }
    });
  }
  return windows;
}

async function listToplevelWindowsWithoutWm(context: LinuxDesktopContext): Promise<RawWindowSummary[] | undefined> {
  const xwininfo = await findCommandPath("xwininfo", context);
  if (xwininfo === undefined) return undefined;
  const result = await runDesktopCommand(xwininfo, ["-root", "-children"], context).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return undefined;
  const xdotool = await findCommandPath("xdotool", context);
  const windows: RawWindowSummary[] = [];
  for (const entry of parseXwininfoChildren(result.stdout)) {
    const raw: RawWindowSummary = { windowId: entry.windowId, bounds: entry.bounds, ...(entry.title === undefined ? {} : { title: entry.title }) };
    const pidResult = xdotool === undefined ? undefined : await runDesktopCommand(xdotool, ["getwindowpid", entry.windowId], context).catch(() => undefined);
    const pid = pidResult?.exitCode === 0 ? Number(pidResult.stdout.trim()) : NaN;
    if (Number.isInteger(pid) && pid > 0) {
      raw.pid = pid;
      const appName = await readProcessName(pid);
      if (appName !== undefined) { raw.appName = appName; raw.appSensitivity = classifyAppSensitivity({ appName }); }
    } else if (entry.appClass !== undefined) {
      raw.appName = entry.appClass.toLowerCase();
      raw.appSensitivity = classifyAppSensitivity({ appName: raw.appName });
    }
    windows.push(raw);
  }
  return windows;
}

const XWININFO_LINE = /^\s*(0x[0-9a-f]+)\s.*?\s(\d+)x(\d+)[+-]-?\d+[+-]-?\d+\s+\+?(-?\d+)\+?(-?\d+)\s*$/i;

export function parseXwininfoTree(output: string): Map<string, DesktopWindowBounds> {
  const geometry = new Map<string, DesktopWindowBounds>();
  for (const line of output.split(/\r?\n/)) {
    const match = XWININFO_LINE.exec(line);
    if (match === null) continue;
    const width = Number(match[2]), height = Number(match[3]), x = Number(match[4]), y = Number(match[5]);
    if (width <= 1 || height <= 1) continue;
    geometry.set(String(Number.parseInt(match[1]!, 16)), { x, y, width, height });
  }
  return geometry;
}

/**
 * wmctrl -G double-counts the client offset for windows whose parent is the
 * root (client-side decorations under mutter report 132,64 for a window at
 * 66,32), which makes screenshot-derived clicks land in the wrong place.
 * One `xwininfo -root -tree` call yields true absolute geometry for every
 * window; when it is unavailable the wmctrl values are kept as-is.
 */
async function absoluteWindowGeometry(context: LinuxDesktopContext): Promise<Map<string, DesktopWindowBounds>> {
  const xwininfo = await findCommandPath("xwininfo", context);
  if (xwininfo === undefined) return new Map();
  const result = await runDesktopCommand(xwininfo, ["-root", "-tree"], context).catch(() => undefined);
  return result?.exitCode === 0 ? parseXwininfoTree(result.stdout) : new Map();
}

export async function listLinuxWindows(
  input: LinuxWindowListInput = {},
  context: LinuxDesktopContext = {}
): Promise<WindowListResult> {
  const rawResult = await listRawWindows(context);

  if (!rawResult.supported) {
    return {
      supported: false,
      backend: rawResult.backend,
      windows: [],
      truncated: false,
      reason: rawResult.reason
    };
  }

  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const includeTitles = input.includeTitles ?? false;
  const windows = rawResult.windows.slice(0, limit).map((window) => summarizeWindow(window, includeTitles));

  return {
    supported: true,
    backend: rawResult.backend,
    windows,
    truncated: rawResult.windows.length > limit,
    reason: rawResult.reason
  };
}

function matchesWindowIdentity(window: RawWindowSummary, input: LinuxWindowFocusInput): boolean {
  const wantedId = normalizeWindowId(input.windowId);
  if (wantedId !== undefined && normalizeWindowId(window.windowId) !== wantedId) {
    return false;
  }

  if (input.pid !== undefined && window.pid !== input.pid) {
    return false;
  }

  if (input.appName !== undefined && window.appName?.toLowerCase() !== input.appName.toLowerCase()) {
    return false;
  }

  if (input.title !== undefined && window.title?.toLowerCase() !== input.title.toLowerCase()) {
    return false;
  }

  return true;
}

export async function focusLinuxWindow(
  input: LinuxWindowFocusInput,
  context: LinuxDesktopContext = {}
): Promise<WindowFocusResult> {
  const normalizedWindowId = normalizeWindowId(input.windowId);
  const requestedWindow: DesktopWindowContext = {};

  if (normalizedWindowId !== undefined) {
    requestedWindow.windowId = normalizedWindowId;
  }

  if (input.appName !== undefined) {
    requestedWindow.appName = input.appName;
  }

  if (input.title !== undefined) {
    requestedWindow.title = redactTitle(input.title) ?? input.title;
  }

  if (input.pid !== undefined) {
    requestedWindow.pid = input.pid;
  }

  // Fast path: a windowId is already unique. Activating it directly skips the
  // full wmctrl listing plus one /proc read per window, which is the
  // dominant cost of app switching. wmctrl itself fails on unknown ids.
  // Ids are canonical decimal strings; wmctrl -i accepts decimal ids.
  if (normalizedWindowId !== undefined && input.appName === undefined && input.title === undefined && input.pid === undefined) {
    const focusSupport = await detectWindowFocusSupport(context);
    if (!focusSupport.supported) {
      return { supported: false, backend: focusSupport.backend, focused: false, window: requestedWindow, reason: focusSupport.reason };
    }
    const directPath = await findCommandPath("wmctrl", context);
    if (directPath === undefined) {
      return { supported: false, backend: "unavailable", focused: false, window: requestedWindow, reason: "Window focus requires wmctrl on X11." };
    }
    const xdotoolPath = await findCommandPath("xdotool", context);
    const previousId = await readActiveWindowId(xdotoolPath, context);
    const activation = await activateWindowById(normalizedWindowId, directPath, xdotoolPath, context);
    return {
      supported: true,
      backend: activation.backend,
      focused: activation.focused,
      window: summarizeWindow({ windowId: normalizedWindowId }, true),
      ...(previousId === undefined ? {} : { previousWindow: { windowId: previousId } }),
      reason: activation.reason
    };
  }

  const rawResult = await listRawWindows(context);

  if (!rawResult.supported) {
    return {
      supported: false,
      backend: rawResult.backend,
      focused: false,
      window: requestedWindow,
      reason: rawResult.reason
    };
  }

  const matches = rawResult.windows.filter((window) => matchesWindowIdentity(window, input));

  if (matches.length === 0) {
    return {
      supported: true,
      backend: rawResult.backend,
      focused: false,
      window: requestedWindow,
      reason: "No visible window matched the requested identity."
    };
  }

  if (matches.length > 1) {
    return {
      supported: true,
      backend: rawResult.backend,
      focused: false,
      window: requestedWindow,
      reason: "The requested window identity matched multiple visible windows."
    };
  }

  const wmctrlPath = await findCommandPath("wmctrl", context);

  if (wmctrlPath === undefined) {
    return {
      supported: false,
      backend: "unavailable",
      focused: false,
      window: requestedWindow,
      reason: "Window focus requires wmctrl on X11."
    };
  }

  const target = matches[0];

  if (target === undefined) {
    return {
      supported: true,
      backend: rawResult.backend,
      focused: false,
      window: requestedWindow,
      reason: "No visible window matched the requested identity."
    };
  }

  const xdotoolPath = await findCommandPath("xdotool", context);
  const previousId = await readActiveWindowId(xdotoolPath, context);
  const activation = await activateWindowById(target.windowId, wmctrlPath, xdotoolPath, context);
  const summarized = summarizeWindow(target, true);

  return {
    supported: true,
    backend: activation.backend,
    focused: activation.focused,
    window: summarized,
    ...(previousId === undefined ? {} : { previousWindow: { windowId: previousId } }),
    reason: activation.reason
  };
}
