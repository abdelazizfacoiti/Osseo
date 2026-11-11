import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  classifyAppSensitivity,
  redactSensitiveText,
  type AccessibilityElementCandidate,
  type AccessibilityElementTarget,
  type AccessibilityElementDetails,
  type AccessibilityTreeNode,
  type AccessibilityFieldAtPointResult,
  type AccessibilityFindElementResult,
  type AccessibilityFocusElementResult,
  type AccessibilityInspectElementResult,
  type AccessibilityInvokeActionResult,
  type AccessibilitySetValueResult,
  type AccessibilityTreeResult,
  type DesktopCapabilitiesResult,
  type DesktopCapabilitySupport,
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
const UIA_BACKEND = "windows-uia";
/** How long the helper may spend on one UI Automation request; the transport waits a little longer. */
const UIA_TIMEOUT_MS = 8_000;
const UIA_REQUEST_MS = UIA_TIMEOUT_MS + 6_000;
/** Web pages sit deep below the browser chrome; the helper allows 14 levels. */
const UIA_MAX_DEPTH = 14;
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

/** One element as the helper sends it (tree node or find candidate). */
interface UiaNode {
  id: string;
  role?: string;
  name?: string;
  text?: string;
  description?: string;
  bounds?: DesktopWindowBounds | null;
  enabled?: boolean;
  sensitive?: boolean;
  hidden?: boolean;
  confidence?: number;
  reason?: string;
  children?: UiaNode[];
}

interface UiaTreeReply {
  root?: UiaNode | null;
  nodeCount?: number;
  truncated?: boolean;
  redacted?: boolean;
  timedOut?: boolean;
  found?: boolean;
}

interface UiaFieldReply {
  found?: boolean;
  role?: string;
  focused?: boolean;
  sensitive?: boolean;
  text?: string;
  length?: number;
  reason?: string;
}

interface UiaDetails {
  id: string;
  role?: string;
  name?: string;
  description?: string;
  states?: string[];
  availableActions?: string[];
  bounds?: DesktopWindowBounds | null;
  valueMetadata?: { supportsText?: boolean; supportsValue?: boolean; editable?: boolean; readOnly?: boolean; textLength?: number };
  appName?: string;
  windowId?: string;
  windowTitle?: string;
  pid?: number;
  sensitive?: boolean;
  hidden?: boolean;
}

interface UiaElementReply {
  matched?: boolean;
  ambiguous?: boolean;
  performed?: boolean;
  changed?: boolean;
  focused?: boolean;
  action?: string;
  reason?: string;
  element?: UiaDetails;
}

function clipText(value: string | undefined, limit: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const redacted = redactSensitiveText(String(value)).trim();
  if (redacted.length === 0) return undefined;
  return redacted.length > limit ? `${redacted.slice(0, limit)}...` : redacted;
}

function boundsOrUndefined(bounds: DesktopWindowBounds | null | undefined): DesktopWindowBounds | undefined {
  return bounds === null || bounds === undefined ? undefined : bounds;
}

/** The same shape and redaction rules as the Linux tree: sensitive and hidden nodes carry no text. */
function treeNode(node: UiaNode): AccessibilityTreeNode {
  const result: AccessibilityTreeNode = { id: node.id, role: node.role ?? "unknown" };
  const name = clipText(node.name, 300);
  const description = clipText(node.description, 300);
  const text = node.sensitive === true || node.hidden === true ? undefined : clipText(node.text, 200);
  const bounds = boundsOrUndefined(node.bounds);
  if (name !== undefined) result.name = name;
  if (description !== undefined) result.description = description;
  if (text !== undefined) result.text = text;
  if (bounds !== undefined) result.bounds = bounds;
  if (typeof node.enabled === "boolean") result.enabled = node.enabled;
  if (node.sensitive === true) result.sensitive = true;
  if (node.hidden === true) result.hidden = true;
  if (node.children !== undefined && node.children.length > 0) result.children = node.children.map(treeNode);
  return result;
}

function candidateOf(node: UiaNode): AccessibilityElementCandidate {
  const result: AccessibilityElementCandidate = {
    id: node.id,
    role: clipText(node.role, 100) ?? "unknown",
    confidence: typeof node.confidence === "number" ? node.confidence : 0.5,
    reason: clipText(node.reason, 200) ?? "Matched accessibility query."
  };
  const name = clipText(node.name, 300);
  const text = node.sensitive === true || node.hidden === true ? undefined : clipText(node.text, 200);
  const bounds = boundsOrUndefined(node.bounds);
  if (name !== undefined) result.name = name;
  if (text !== undefined) result.text = text;
  if (bounds !== undefined) result.bounds = bounds;
  if (typeof node.enabled === "boolean") result.enabled = node.enabled;
  return result;
}

function detailsOf(element: UiaDetails): AccessibilityElementDetails {
  const secret = element.sensitive === true || element.hidden === true;
  const result: AccessibilityElementDetails = {
    elementId: element.id,
    role: clipText(element.role, 100) ?? "unknown",
    states: (element.states ?? []).map((state) => state.slice(0, 100)).slice(0, 20),
    availableActions: (element.availableActions ?? []).map((action) => action.slice(0, 100)).slice(0, 20),
    dataSensitivity: secret ? "secret" : element.valueMetadata === undefined ? "none" : "low"
  };
  const name = clipText(element.name, 300);
  const description = secret ? undefined : clipText(element.description, 300);
  const appName = clipText(element.appName, 120);
  const bounds = boundsOrUndefined(element.bounds);
  if (name !== undefined) result.name = name;
  if (description !== undefined) result.description = description;
  if (bounds !== undefined) result.bounds = bounds;
  if (element.valueMetadata !== undefined) {
    result.valueMetadata = {
      supportsText: element.valueMetadata.supportsText === true,
      supportsValue: element.valueMetadata.supportsValue === true,
      editable: element.valueMetadata.editable === true,
      readOnly: element.valueMetadata.readOnly === true,
      ...(secret || typeof element.valueMetadata.textLength !== "number" ? {} : { textLength: element.valueMetadata.textLength })
    };
  }
  if (appName !== undefined) {
    result.appName = appName;
    result.appSensitivity = classifyAppSensitivity({ appName });
  }
  const windowId = clipText(element.windowId, 120);
  const windowTitle = clipText(element.windowTitle, 160);
  if (windowId !== undefined) result.windowId = windowId;
  if (windowTitle !== undefined) result.windowTitle = windowTitle;
  if (typeof element.pid === "number") result.pid = element.pid;
  if (element.hidden === true) result.hidden = true;
  return result;
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
 * Accessibility goes through the helper's uia.* methods (Windows UI Automation) with the same result
 * shapes as the Linux AT-SPI layer, so the ui.* tools, screen.read, label clicks and set_field need no changes.
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

  /** A process name from the agent ("notepad", "Notepad.exe") to the pid of one of its windows. */
  async function pidOfApp(appName: string): Promise<number | undefined> {
    const wanted = appName.toLowerCase().replace(/\.exe$/, "");
    const listed = await helper.request<{ windows: HelperWindow[] }>("windows.list", { limit: 200 });
    return listed.windows.find((window) => window.process.toLowerCase() === wanted)?.pid;
  }

  /** The helper finds a window by handle or by pid; an app name becomes a pid first. */
  async function uiaScope(input: { appName?: string; windowId?: string; pid?: number }): Promise<{ ok: true; params: { hwnd?: string; pid?: number } } | { ok: false; reason: string }> {
    const hwnd = normalizeHwnd(input.windowId);
    if (hwnd !== undefined) return { ok: true, params: { hwnd } };
    if (input.pid !== undefined) return { ok: true, params: { pid: input.pid } };
    if (input.appName !== undefined) {
      const pid = await pidOfApp(input.appName);
      if (pid === undefined) return { ok: false, reason: `No open window belongs to ${input.appName}.` };
      return { ok: true, params: { pid } };
    }
    return { ok: false, reason: "A window id, a pid or an app name is needed to find the element." };
  }

  /** One element action: scope (not needed with an element id, which carries its window), name and role, plus the method's own fields. */
  async function elementRequest<T>(method: string, input: AccessibilityElementTarget, extra: Record<string, unknown>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
    let params: Record<string, unknown>;
    if (input.elementId !== undefined) {
      params = { elementId: input.elementId };
    } else {
      const scope = await uiaScope(input);
      if (!scope.ok) return { ok: false, reason: scope.reason };
      params = { ...scope.params, ...(input.query === undefined ? {} : { query: input.query }), ...(input.role === undefined ? {} : { role: input.role }) };
    }
    const value = await helper.request<T>(method, { ...params, ...extra, timeoutMs: UIA_TIMEOUT_MS }, UIA_REQUEST_MS);
    return { ok: true, value };
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
      const uiaCapability = async (down: string | undefined): Promise<DesktopCapabilitySupport> => {
        if (down !== undefined) return { supported: false, backend: UIA_BACKEND, reason: down };
        return helper.request("uia.ping").then(
          (): DesktopCapabilitySupport => ({ supported: true, backend: UIA_BACKEND, reason: "Reads and operates controls through Windows UI Automation. Windows running as administrator are refused." }),
          (error: unknown): DesktopCapabilitySupport => ({ supported: false, backend: UIA_BACKEND, reason: failure(error) })
        );
      };
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
        accessibility: await uiaCapability(reachable),
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

    // ---- Accessibility: Windows UI Automation through the helper's uia.* methods. ----

    async getAccessibilityTree(input: { appName?: string; windowId?: string; pid?: number; maxDepth?: number; maxNodes?: number; includeText?: boolean }): Promise<AccessibilityTreeResult> {
      const none = (reason: string): AccessibilityTreeResult => ({ supported: false, backend: UIA_BACKEND, nodeCount: 0, truncated: false, redacted: false, reason });
      return guarded<AccessibilityTreeResult>(async () => {
        const scope = await uiaScope(input);
        if (!scope.ok) return none(scope.reason);
        const reply = await helper.request<UiaTreeReply>("uia.tree", {
          ...scope.params,
          maxDepth: Math.min(Math.max(input.maxDepth ?? 3, 1), UIA_MAX_DEPTH),
          maxNodes: Math.min(Math.max(input.maxNodes ?? 200, 1), 1000),
          includeText: input.includeText ?? false,
          timeoutMs: UIA_TIMEOUT_MS
        }, UIA_REQUEST_MS);
        const root = reply.root === null || reply.root === undefined ? undefined : treeNode(reply.root);
        const base = { supported: true, backend: UIA_BACKEND, nodeCount: reply.nodeCount ?? 0, truncated: reply.truncated === true, redacted: reply.redacted === true };
        if (root === undefined) return { ...base, reason: reply.found === false ? "No window of that app is open." : "UI Automation returned no elements for that window." };
        return { ...base, root, reason: reply.timedOut === true ? "The app answered too slowly, so the tree is partial." : reply.truncated === true ? "Read part of the UI Automation tree." : "Read the UI Automation tree." };
      }, none);
    },

    async findAccessibilityElement(input: { appName?: string; windowId?: string; pid?: number; query: string; role?: string; limit?: number }): Promise<AccessibilityFindElementResult> {
      const none = (reason: string): AccessibilityFindElementResult => ({ supported: false, backend: UIA_BACKEND, candidates: [], reason });
      return guarded<AccessibilityFindElementResult>(async () => {
        const scope = await uiaScope(input);
        if (!scope.ok) return none(scope.reason);
        const reply = await helper.request<{ candidates?: UiaNode[]; truncated?: boolean; timedOut?: boolean }>("uia.find", {
          ...scope.params,
          query: input.query,
          ...(input.role === undefined ? {} : { role: input.role }),
          limit: Math.min(Math.max(input.limit ?? 10, 1), 50),
          timeoutMs: UIA_TIMEOUT_MS
        }, UIA_REQUEST_MS);
        const candidates = (reply.candidates ?? []).map(candidateOf);
        const partial = reply.timedOut === true ? " The app answered too slowly, so the search is partial." : reply.truncated === true ? " The search stopped at its limit." : "";
        return { supported: true, backend: UIA_BACKEND, candidates, reason: `Found ${candidates.length} UI Automation match(es).${partial}` };
      }, none);
    },

    async readTextAtPoint(input: { appName?: string; pid?: number; x: number; y: number }): Promise<AccessibilityFieldAtPointResult> {
      const none = (reason: string): AccessibilityFieldAtPointResult => ({ supported: false, backend: UIA_BACKEND, found: false, reason });
      return guarded<AccessibilityFieldAtPointResult>(async () => {
        const pid = input.pid ?? (input.appName === undefined ? undefined : await pidOfApp(input.appName));
        const reply = await helper.request<UiaFieldReply>("uia.textAtPoint", {
          x: Math.round(input.x),
          y: Math.round(input.y),
          ...(pid === undefined ? {} : { pid }),
          timeoutMs: UIA_TIMEOUT_MS
        }, UIA_REQUEST_MS);
        if (reply.found !== true) return { supported: true, backend: UIA_BACKEND, found: false, reason: reply.reason ?? "No editable text field at that point." };
        const sensitive = reply.sensitive === true || reply.role === "password text";
        return {
          supported: true,
          backend: UIA_BACKEND,
          found: true,
          reason: reply.reason ?? "Read the editable text field at that point.",
          ...(typeof reply.role === "string" ? { role: reply.role } : {}),
          focused: reply.focused === true,
          sensitive,
          // Read-back only. A sensitive field never carries its text, whatever the helper sent.
          ...(sensitive || typeof reply.text !== "string" ? {} : { text: reply.text }),
          ...(sensitive || typeof reply.length !== "number" ? {} : { length: reply.length })
        };
      }, none);
    },

    async inspectAccessibilityElement(input: AccessibilityElementTarget): Promise<AccessibilityInspectElementResult> {
      const none = (reason: string): AccessibilityInspectElementResult => ({ supported: false, backend: UIA_BACKEND, matched: false, ambiguous: false, redacted: false, reason });
      return guarded<AccessibilityInspectElementResult>(async () => {
        const reply = await elementRequest<UiaElementReply>("uia.inspect", input, {});
        if (!reply.ok) return none(reply.reason);
        const element = reply.value.element === undefined ? undefined : detailsOf(reply.value.element);
        return {
          supported: true,
          backend: UIA_BACKEND,
          matched: reply.value.matched === true,
          ambiguous: reply.value.ambiguous === true,
          redacted: element?.dataSensitivity === "secret",
          reason: reply.value.reason || (reply.value.matched === true ? "Read the element." : "No matching element was found."),
          ...(element === undefined ? {} : { element })
        };
      }, none);
    },

    async invokeAccessibilityAction(input: AccessibilityElementTarget & { actionName: string; requireExactMatch?: boolean }): Promise<AccessibilityInvokeActionResult> {
      const none = (reason: string): AccessibilityInvokeActionResult => ({ supported: false, backend: UIA_BACKEND, matched: false, ambiguous: false, performed: false, redacted: false, actionName: input.actionName, reason });
      return guarded<AccessibilityInvokeActionResult>(async () => {
        const reply = await elementRequest<UiaElementReply>("uia.activate", input, { action: input.actionName, requireExactMatch: input.requireExactMatch ?? false });
        if (!reply.ok) return none(reply.reason);
        const target = reply.value.element === undefined ? undefined : detailsOf(reply.value.element);
        return {
          supported: true,
          backend: UIA_BACKEND,
          matched: reply.value.matched === true,
          ambiguous: reply.value.ambiguous === true,
          performed: reply.value.performed === true,
          redacted: target?.dataSensitivity === "secret",
          actionName: reply.value.action ?? input.actionName,
          reason: reply.value.reason || (reply.value.performed === true ? "Performed the action." : "Nothing was done."),
          ...(target === undefined ? {} : { target })
        };
      }, none);
    },

    async setAccessibilityValue(input: AccessibilityElementTarget & { value: string; dataSensitivity?: "none" | "low" | "sensitive" | "secret" }): Promise<AccessibilitySetValueResult> {
      const none = (reason: string): AccessibilitySetValueResult => ({ supported: false, backend: UIA_BACKEND, matched: false, ambiguous: false, changed: false, redacted: true, redactedValue: true, reason });
      return guarded<AccessibilitySetValueResult>(async () => {
        const reply = await elementRequest<UiaElementReply>("uia.setText", input, { value: input.value });
        if (!reply.ok) return none(reply.reason);
        const target = reply.value.element === undefined ? undefined : detailsOf(reply.value.element);
        return {
          supported: true,
          backend: UIA_BACKEND,
          matched: reply.value.matched === true,
          ambiguous: reply.value.ambiguous === true,
          changed: reply.value.changed === true,
          redacted: true,
          redactedValue: true,
          reason: reply.value.reason || (reply.value.changed === true ? "Set the field value." : "The value was not set."),
          ...(target === undefined ? {} : { target })
        };
      }, none);
    },

    async focusAccessibilityElement(input: AccessibilityElementTarget): Promise<AccessibilityFocusElementResult> {
      const none = (reason: string): AccessibilityFocusElementResult => ({ supported: false, backend: UIA_BACKEND, matched: false, ambiguous: false, focused: false, redacted: false, reason });
      return guarded<AccessibilityFocusElementResult>(async () => {
        const reply = await elementRequest<UiaElementReply>("uia.focus", input, {});
        if (!reply.ok) return none(reply.reason);
        const target = reply.value.element === undefined ? undefined : detailsOf(reply.value.element);
        return {
          supported: true,
          backend: UIA_BACKEND,
          matched: reply.value.matched === true,
          ambiguous: reply.value.ambiguous === true,
          focused: reply.value.focused === true,
          redacted: target?.dataSensitivity === "secret",
          reason: reply.value.reason || (reply.value.focused === true ? "Moved focus to the element." : "Focus did not move."),
          ...(target === undefined ? {} : { target })
        };
      }, none);
    },

    /**
     * The text of one element, for read-back after ui.set_text. Not part of the Linux interface: it is
     * used by the Windows check script. Password, credential-looking and hidden elements never return text.
     */
    async readAccessibilityText(input: AccessibilityElementTarget): Promise<{ supported: boolean; backend: string; matched: boolean; readable: boolean; sensitive: boolean; text?: string; length?: number; reason: string }> {
      const none = (reason: string) => ({ supported: false, backend: UIA_BACKEND, matched: false, readable: false, sensitive: false, reason });
      return guarded(async () => {
        const reply = await elementRequest<{ matched?: boolean; readable?: boolean; sensitive?: boolean; text?: string; length?: number; reason?: string }>("uia.getText", input, {});
        if (!reply.ok) return none(reply.reason);
        const sensitive = reply.value.sensitive === true;
        const readable = reply.value.readable === true && !sensitive && typeof reply.value.text === "string";
        return {
          supported: true,
          backend: UIA_BACKEND,
          matched: reply.value.matched === true,
          readable,
          sensitive,
          ...(readable ? { text: reply.value.text!, length: reply.value.text!.length } : {}),
          reason: reply.value.reason ?? ""
        };
      }, none);
    }
  };
}

export type WindowsDesktop = ReturnType<typeof createWindowsDesktop>;
