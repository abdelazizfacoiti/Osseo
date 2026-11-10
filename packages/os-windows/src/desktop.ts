import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  classifyAppSensitivity,
  type AccessibilityFieldAtPointResult,
  type AccessibilityFindElementResult,
  type AccessibilityFocusElementResult,
  type AccessibilityInspectElementResult,
  type AccessibilityInvokeActionResult,
  type AccessibilitySetValueResult,
  type AccessibilityTreeResult,
  type DesktopCapabilitiesResult,
  type DesktopClickResult,
  type DesktopGetActiveWindowResult,
  type DesktopHotkeyResult,
  type DesktopMouseButton,
  type DesktopPointerAction,
  type DesktopPointerResult,
  type DesktopScreenshotResult,
  type DesktopTypeTextResult,
  type DesktopWindowBounds,
  type DesktopWindowContext,
  type DesktopWindowSummary,
  type WindowFocusResult,
  type WindowListResult
} from "@agenthost/core";
import { HelperError, type HelperTransport } from "./helper.js";
import { parseHotkey } from "./keys.js";

const BACKEND = "windows-helper";
const UIA_PENDING = "Windows UI Automation is not implemented yet, so accessibility tools are unavailable here. Use screenshots with desktop.click, or browser.* for web pages.";
/** The minimum wait before the old clipboard returns after a paste (same rule as the Linux adapter). */
export const PASTE_SETTLE_MS = 350;

interface HelperWindow {
  hwnd: string;
  title: string;
  pid: number;
  process: string;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
}

export interface WindowsDesktopOptions {
  sleep?: (ms: number) => Promise<void>;
}

export interface WindowsClipboardResult {
  supported: boolean;
  backend: "windows" | "unavailable";
  text?: string;
  reason: string;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A handle from the agent may be decimal or 0x-hex; the helper wants decimal. */
export function normalizeHwnd(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (/^0x[0-9a-f]+$/i.test(text)) return String(BigInt(text));
  return /^[0-9]+$/.test(text) ? text : undefined;
}

function contextOf(window: HelperWindow | null | undefined): DesktopWindowContext | undefined {
  if (window === null || window === undefined) return undefined;
  return {
    windowId: window.hwnd,
    ...(window.process === "" ? {} : { appName: window.process }),
    title: window.title,
    pid: window.pid,
    appSensitivity: classifyAppSensitivity(window.process === "" ? {} : { appName: window.process })
  };
}

function boundsOf(window: HelperWindow): DesktopWindowBounds {
  return { x: window.x, y: window.y, width: window.width, height: window.height };
}

function failure(error: unknown): string {
  if (error instanceof HelperError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Windows desktop adapter: the same contract as the Linux one, backed by the PowerShell helper.
 * Windows UI Automation is a later step: the accessibility methods say so instead of guessing.
 */
export function createWindowsDesktop(helper: HelperTransport, options: WindowsDesktopOptions = {}) {
  const sleep = options.sleep ?? sleepFor;

  async function activeWindow(): Promise<HelperWindow | null> {
    return helper.request<HelperWindow | null>("window.active");
  }

  /** Makes sure the window the agent named is in front, re-activating it once if focus drifted. */
  async function ensureActive(expected: DesktopWindowContext): Promise<{ ok: true; active: DesktopWindowContext } | { ok: false; reason: string; active?: DesktopWindowContext }> {
    let current = await activeWindow();
    const wanted = normalizeHwnd(expected.windowId);
    if (wanted !== undefined && current?.hwnd !== wanted) {
      await helper.request("window.focus", { hwnd: wanted });
      current = await activeWindow();
      if (current?.hwnd !== wanted) {
        return { ok: false, reason: `active_window_mismatch: window ${expected.windowId} is not in front.`, ...(contextOf(current) === undefined ? {} : { active: contextOf(current)! }) };
      }
    }
    const active = contextOf(current);
    if (active === undefined) return { ok: false, reason: "No window is in front." };
    return { ok: true, active };
  }

  async function guarded<T>(run: () => Promise<T>, fallback: (reason: string) => T): Promise<T> {
    try {
      return await run();
    } catch (error) {
      return fallback(failure(error));
    }
  }

  return {
    async getDesktopCapabilities(): Promise<DesktopCapabilitiesResult> {
      const reachable = await helper.request("ping").then(() => undefined, (error: unknown) => failure(error));
      const yes = (reason: string) => ({ supported: reachable === undefined, backend: BACKEND, reason: reachable ?? reason });
      return {
        platform: "win32",
        sessionType: "unknown",
        displayAvailable: reachable === undefined,
        backend: BACKEND,
        activeWindow: yes("Reads the foreground window."),
        screenshot: yes("Copies the screen with GDI."),
        windowList: yes("Lists visible top-level windows."),
        windowFocus: yes("Brings a window to the front."),
        accessibility: { supported: false, backend: "windows-uia", reason: UIA_PENDING },
        guiInput: yes("Sends mouse and keyboard input with SendInput. Windows running as administrator are refused.")
      };
    },

    async getActiveWindow(): Promise<DesktopGetActiveWindowResult> {
      return guarded<DesktopGetActiveWindowResult>(async () => {
        const active = contextOf(await activeWindow());
        return active === undefined
          ? { supported: true, backend: BACKEND, reason: "No window is in front." }
          : { supported: true, backend: BACKEND, activeWindow: active, reason: "Read the foreground window." };
      }, (reason) => ({ supported: false, backend: BACKEND, reason }));
    },

    async listWindows(input: { limit?: number; includeTitles?: boolean }): Promise<WindowListResult> {
      return guarded<WindowListResult>(async () => {
        const limit = input.limit ?? 50;
        const listed = await helper.request<{ windows: HelperWindow[]; truncated: boolean }>("windows.list", { limit });
        const windows: DesktopWindowSummary[] = listed.windows.map((window) => {
          const context = contextOf(window)!;
          return {
            windowId: window.hwnd,
            ...(context.appName === undefined ? {} : { appName: context.appName }),
            ...(input.includeTitles === true ? { title: window.title } : {}),
            pid: window.pid,
            ...(context.appSensitivity === undefined ? {} : { appSensitivity: context.appSensitivity }),
            bounds: boundsOf(window)
          };
        });
        return { supported: true, backend: BACKEND, windows, truncated: listed.truncated, reason: `Listed ${windows.length} windows.` };
      }, (reason) => ({ supported: false, backend: BACKEND, windows: [], truncated: false, reason }));
    },

    async focusWindow(input: { windowId?: string; appName?: string; title?: string; pid?: number }): Promise<WindowFocusResult> {
      return guarded<WindowFocusResult>(async () => {
        let hwnd = normalizeHwnd(input.windowId);
        if (hwnd === undefined) {
          const listed = await helper.request<{ windows: HelperWindow[] }>("windows.list", { limit: 200 });
          const match = listed.windows.find((window) =>
            (input.pid === undefined || window.pid === input.pid)
            && (input.appName === undefined || window.process.toLowerCase() === input.appName.toLowerCase())
            && (input.title === undefined || window.title.toLowerCase().includes(input.title.toLowerCase())));
          hwnd = match?.hwnd;
        }
        if (hwnd === undefined) return { supported: true, backend: BACKEND, focused: false, window: input, reason: "No window matched." };
        const result = await helper.request<{ focused: boolean; previous: HelperWindow | null; window: HelperWindow | null }>("window.focus", { hwnd });
        const window = contextOf(result.window) ?? input;
        const previous = contextOf(result.previous);
        return {
          supported: true,
          backend: BACKEND,
          focused: result.focused,
          window,
          ...(previous === undefined ? {} : { previousWindow: previous }),
          reason: result.focused ? "Brought the window to the front." : "Windows did not allow the window to take focus."
        };
      }, (reason) => ({ supported: false, backend: BACKEND, focused: false, window: input, reason }));
    },

    async screenshot(input: {
      path: string;
      includeActiveWindowOnly?: boolean;
      format?: "png" | "jpeg";
      quality?: number;
      scale?: number;
      region?: { x: number; y: number; width: number; height: number };
    }): Promise<DesktopScreenshotResult> {
      return guarded<DesktopScreenshotResult>(async () => {
        const active = input.includeActiveWindowOnly === true ? await activeWindow() : null;
        const format = input.format ?? "png";
        const shot = await helper.request<{ data: string; width: number; height: number; originX: number; originY: number }>("screenshot", {
          ...(active === null ? {} : { hwnd: active.hwnd }),
          ...(input.region === undefined ? {} : { region: input.region }),
          scale: input.scale ?? 1,
          format,
          ...(input.quality === undefined ? {} : { quality: input.quality })
        }, 30_000);
        const bytes = Buffer.from(shot.data, "base64");
        await mkdir(path.dirname(input.path), { recursive: true });
        await writeFile(input.path, bytes, { mode: 0o600 });
        const activeContext = contextOf(active);
        return {
          supported: true,
          backend: BACKEND,
          path: input.path,
          bytesWritten: bytes.length,
          ...(activeContext === undefined ? {} : { activeWindow: activeContext }),
          screenshotMetadata: {
            screenshotId: randomUUID(),
            capturedAt: new Date().toISOString(),
            captureKind: active === null ? "full_screen" : "active_window",
            imageWidth: shot.width,
            imageHeight: shot.height,
            geometryAvailable: true,
            format,
            ...(input.scale === undefined ? {} : { scale: input.scale }),
            ...(input.region === undefined ? {} : { region: input.region }),
            screenOrigin: { x: shot.originX, y: shot.originY }
          },
          reason: "Captured the screen."
        };
      }, (reason) => ({ supported: false, backend: BACKEND, reason }));
    },

    async getScreenGeometry(): Promise<{ supported: boolean; bounds?: DesktopWindowBounds; reason: string }> {
      return guarded<{ supported: boolean; bounds?: DesktopWindowBounds; reason: string }>(async () => {
        const bounds = await helper.request<DesktopWindowBounds>("screen.geometry");
        return { supported: true, bounds, reason: "Read the virtual screen." };
      }, (reason) => ({ supported: false, reason }));
    },

    async getActiveWindowBounds(): Promise<{ supported: boolean; bounds?: DesktopWindowBounds; reason: string }> {
      return guarded<{ supported: boolean; bounds?: DesktopWindowBounds; reason: string }>(async () => {
        const active = await activeWindow();
        return active === null
          ? { supported: false, reason: "No window is in front." }
          : { supported: true, bounds: boundsOf(active), reason: "Read the foreground window bounds." };
      }, (reason) => ({ supported: false, reason }));
    },

    async hotkey(input: { keys: string[]; repeat?: number; activeWindow: DesktopWindowContext }): Promise<DesktopHotkeyResult> {
      const parsed = parseHotkey(input.keys);
      if (!parsed.ok) return { supported: true, backend: BACKEND, sent: false, keys: input.keys, activeWindow: input.activeWindow, reason: parsed.reason };
      return guarded<DesktopHotkeyResult>(async () => {
        const target = await ensureActive(input.activeWindow);
        if (!target.ok) return { supported: true, backend: BACKEND, sent: false, keys: input.keys, activeWindow: target.active ?? input.activeWindow, reason: target.reason };
        await helper.request("input.keys", { vks: parsed.vks, repeat: input.repeat ?? 1, delayMs: 20 });
        return { supported: true, backend: BACKEND, sent: true, keys: input.keys, activeWindow: target.active, reason: "Sent the hotkey." };
      }, (reason) => ({ supported: true, backend: BACKEND, sent: false, keys: input.keys, activeWindow: input.activeWindow, reason }));
    },

    async typeText(input: { text: string; activeWindow: DesktopWindowContext }, typeOptions?: { settle?: () => Promise<unknown> }): Promise<DesktopTypeTextResult> {
      const base = { backend: BACKEND, characterCount: input.text.length, method: "clipboard" as const };
      return guarded<DesktopTypeTextResult>(async () => {
        const target = await ensureActive(input.activeWindow);
        if (!target.ok) return { ...base, supported: true, typed: false, activeWindow: target.active ?? input.activeWindow, reason: target.reason };
        if (input.text.length === 0) return { ...base, supported: true, typed: true, activeWindow: target.active, reason: "Nothing to type." };
        // Paste, not key-by-key typing: layout-independent, and the same behavior as the Linux adapter.
        const previous = (await helper.request<{ text: string | null }>("clipboard.get")).text;
        await helper.request("clipboard.set", { text: input.text });
        await helper.request("input.keys", { vks: [0x11, 0x56], repeat: 1, delayMs: 20 });
        // The target reads the clipboard after the keystroke: wait, then until the window settles.
        await sleep(PASTE_SETTLE_MS);
        if (typeOptions?.settle !== undefined) await typeOptions.settle().catch(() => undefined);
        // Text is restored; anything else that was on the clipboard (an image) cannot be, and the pasted text must not stay there.
        await helper.request("clipboard.set", { text: previous ?? "" }).catch(() => undefined);
        return { ...base, supported: true, typed: true, activeWindow: target.active, reason: previous === null ? "Pasted text via the clipboard and cleared it afterwards (it held no text to restore)." : "Pasted text via the clipboard and restored the prior clipboard text." };
      }, (reason) => ({ ...base, supported: true, typed: false, activeWindow: input.activeWindow, reason }));
    },

    async click(input: { x: number; y: number; button?: DesktopMouseButton; activeWindow: DesktopWindowContext }): Promise<DesktopClickResult> {
      const button = input.button ?? "left";
      return guarded<DesktopClickResult>(async () => {
        const target = await ensureActive(input.activeWindow);
        if (!target.ok) return { supported: true, backend: BACKEND, clicked: false, x: input.x, y: input.y, button, activeWindow: target.active ?? input.activeWindow, reason: target.reason };
        await helper.request("input.click", { x: Math.round(input.x), y: Math.round(input.y), button });
        return { supported: true, backend: BACKEND, clicked: true, x: input.x, y: input.y, button, activeWindow: target.active, reason: "Sent the click." };
      }, (reason) => ({ supported: true, backend: BACKEND, clicked: false, x: input.x, y: input.y, button, activeWindow: input.activeWindow, reason }));
    },

    async pointer(input: {
      action: DesktopPointerAction;
      activeWindow: DesktopWindowContext;
      x?: number; y?: number;
      direction?: "up" | "down" | "left" | "right"; amount?: number;
      startX?: number; startY?: number; endX?: number; endY?: number; durationMs?: number;
    }): Promise<DesktopPointerResult> {
      const done = (performed: boolean, activeWindow: DesktopWindowContext, reason: string): DesktopPointerResult => ({ supported: true, backend: BACKEND, performed, action: input.action, activeWindow, reason });
      return guarded<DesktopPointerResult>(async () => {
        const target = await ensureActive(input.activeWindow);
        if (!target.ok) return done(false, target.active ?? input.activeWindow, target.reason);
        const at = input.x !== undefined && input.y !== undefined ? { x: Math.round(input.x), y: Math.round(input.y) } : undefined;
        switch (input.action) {
          case "move_mouse":
            if (at === undefined) return done(false, target.active, "move_mouse needs x and y.");
            await helper.request("input.move", at);
            return done(true, target.active, "Moved the pointer.");
          case "double_click":
            if (at === undefined) return done(false, target.active, "double_click needs x and y.");
            await helper.request("input.click", { ...at, count: 2 });
            return done(true, target.active, "Double-clicked.");
          case "right_click":
            if (at === undefined) return done(false, target.active, "right_click needs x and y.");
            await helper.request("input.click", { ...at, button: "right" });
            return done(true, target.active, "Right-clicked.");
          case "scroll": {
            const amount = Math.max(1, Math.round(input.amount ?? 3));
            const direction = input.direction ?? "down";
            await helper.request("input.scroll", {
              ...(at ?? {}),
              vertical: direction === "up" ? amount : direction === "down" ? -amount : 0,
              horizontal: direction === "right" ? amount : direction === "left" ? -amount : 0
            });
            return done(true, target.active, `Scrolled ${direction}.`);
          }
          case "drag":
            if (input.startX === undefined || input.startY === undefined || input.endX === undefined || input.endY === undefined) return done(false, target.active, "drag needs startX, startY, endX and endY.");
            await helper.request("input.drag", { x1: Math.round(input.startX), y1: Math.round(input.startY), x2: Math.round(input.endX), y2: Math.round(input.endY), durationMs: input.durationMs ?? 300 }, 30_000);
            return done(true, target.active, "Dragged.");
        }
      }, (reason) => done(false, input.activeWindow, reason));
    },

    async setClipboard(input: { text: string }): Promise<WindowsClipboardResult> {
      return guarded<WindowsClipboardResult>(async () => {
        await helper.request("clipboard.set", { text: input.text });
        return { supported: true, backend: "windows" as const, reason: "Set the clipboard." };
      }, (reason) => ({ supported: false, backend: "unavailable" as const, reason }));
    },

    async getClipboard(): Promise<WindowsClipboardResult> {
      return guarded<WindowsClipboardResult>(async () => {
        const result = await helper.request<{ text: string | null }>("clipboard.get");
        return result.text === null
          ? { supported: false, backend: "windows" as const, reason: "The clipboard is empty or holds no text." }
          : { supported: true, backend: "windows" as const, text: result.text, reason: "Read the clipboard text." };
      }, (reason) => ({ supported: false, backend: "unavailable" as const, reason }));
    },

    async userIdleMs(): Promise<number | undefined> {
      return helper.request<{ idleMs: number }>("idle").then((result) => result.idleMs, () => undefined);
    },

    // ---- Accessibility: Windows UI Automation comes next. Say so instead of guessing. ----

    async getAccessibilityTree(): Promise<AccessibilityTreeResult> {
      return { supported: false, backend: "windows-uia", nodeCount: 0, truncated: false, redacted: false, reason: UIA_PENDING };
    },
    async findAccessibilityElement(): Promise<AccessibilityFindElementResult> {
      return { supported: false, backend: "windows-uia", candidates: [], reason: UIA_PENDING };
    },
    async readTextAtPoint(): Promise<AccessibilityFieldAtPointResult> {
      return { supported: false, backend: "windows-uia", found: false, reason: UIA_PENDING };
    },
    async inspectAccessibilityElement(): Promise<AccessibilityInspectElementResult> {
      return { supported: false, backend: "windows-uia", matched: false, ambiguous: false, redacted: false, reason: UIA_PENDING };
    },
    async invokeAccessibilityAction(): Promise<AccessibilityInvokeActionResult> {
      return { supported: false, backend: "windows-uia", matched: false, ambiguous: false, performed: false, redacted: false, reason: UIA_PENDING };
    },
    async setAccessibilityValue(): Promise<AccessibilitySetValueResult> {
      return { supported: false, backend: "windows-uia", matched: false, ambiguous: false, changed: false, redacted: false, redactedValue: false, reason: UIA_PENDING };
    },
    async focusAccessibilityElement(): Promise<AccessibilityFocusElementResult> {
      return { supported: false, backend: "windows-uia", matched: false, ambiguous: false, focused: false, redacted: false, reason: UIA_PENDING };
    }
  };
}

export type WindowsDesktop = ReturnType<typeof createWindowsDesktop>;
