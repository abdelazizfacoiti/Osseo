import type {
  DesktopCapabilitiesResult,
  DesktopClickResult,
  DesktopGetActiveWindowResult,
  DesktopHotkeyResult,
  DesktopMouseButton,
  DesktopPointerResult,
  DesktopScreenshotResult,
  DesktopTypeTextResult,
  DesktopWindowContext,
  WindowFocusResult,
  WindowListResult
} from "@agenthost/core";
import { BUTTON_CODES, PORTAL_SCREEN_WINDOW_ID, keysymForKeyName, keysymsForText } from "./portal-protocol.js";
import { PortalError, type PortalSession, type PortalStream } from "./portal-session.js";

/** The one target on the portal path: the shared screen. The compositor does not report windows. */
export const PORTAL_SCREEN_WINDOW: DesktopWindowContext = { windowId: PORTAL_SCREEN_WINDOW_ID, title: "Shared screen" };

export interface PortalDesktopOptions {
  /** Name shown in results. Default: wayland-portal. */
  backend?: string;
  /** Pause after a pointer move (before the click) and after each key (ms). Tests pass 0. */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SETTLE_MS = 40;
const MAX_REPEAT = 20;
const DECLINED_REASON = "consent_denied: The person declined remote control earlier in this session. Restart AgentHost to ask again.";

type Bounds = { x: number; y: number; width: number; height: number };

function reasonOf(error: unknown): string {
  if (error instanceof PortalError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "portal_error";
}

/** Maps a global point onto one stream, or undefined when the point is not on that stream. */
function pointOnStream(stream: PortalStream | undefined, x: number, y: number): { node: number; x: number; y: number } | undefined {
  if (stream === undefined) return undefined;
  const localX = x - stream.x;
  const localY = y - stream.y;
  if (localX < 0 || localY < 0 || localX >= stream.width || localY >= stream.height) return undefined;
  return { node: stream.node, x: localX, y: localY };
}

function boundsOf(stream: PortalStream | undefined): Bounds | undefined {
  return stream === undefined ? undefined : { x: stream.x, y: stream.y, width: stream.width, height: stream.height };
}

/**
 * The desktop adapter for a Wayland session, built on one PortalSession. Every method that would use X11
 * (xdotool, wmctrl, xwd) is replaced here, so nothing falls through to the X11 path on a Wayland session.
 * Input and capture go through the portal, after one consent. Window listing and focus are refused or
 * reduced to the shared screen.
 */
export function createPortalDesktop(session: PortalSession, options: PortalDesktopOptions = {}) {
  const backend = options.backend ?? "wayland-portal";
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** Opens the portal session if needed. The person is asked at most once per process. */
  async function ready(): Promise<{ ok: true; streams: PortalStream[] } | { ok: false; reason: string }> {
    try {
      const opened = await session.open({ keyboard: true, pointer: true, screen: true });
      return { ok: true, streams: opened.streams };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  /** Runs portal input calls. A failure is returned as text, never thrown into the tool. */
  async function sendInput(run: () => Promise<void>): Promise<string | undefined> {
    try {
      await run();
      return undefined;
    } catch (error) {
      return reasonOf(error);
    }
  }

  return {
    /** Reading the window context never asks the person. The first click, key press or screenshot does. */
    async getActiveWindow(): Promise<DesktopGetActiveWindowResult> {
      if (session.declined) return { supported: false, backend, reason: DECLINED_REASON };
      return {
        supported: true,
        backend,
        activeWindow: { ...PORTAL_SCREEN_WINDOW },
        reason: "The compositor does not report the focused window, so the shared screen is the only target. The person is asked at the first click, key press or screenshot."
      };
    },

    async getActiveWindowBounds(): Promise<{ supported: boolean; bounds?: Bounds; reason: string }> {
      const bounds = boundsOf(session.streams[0]);
      if (bounds === undefined) return { supported: false, reason: "The shared screen is not open yet; the first desktop action asks the person." };
      return { supported: true, bounds, reason: "The shared screen as the portal reports it." };
    },

    async getScreenGeometry(): Promise<{ supported: boolean; bounds?: Bounds; reason: string }> {
      const bounds = boundsOf(session.streams[0]);
      if (bounds === undefined) return { supported: false, reason: "The shared screen is not open yet; the first desktop action asks the person." };
      return { supported: true, bounds, reason: "The shared screen as the portal reports it." };
    },

    async listWindows(_input: { limit?: number; includeTitles?: boolean }): Promise<WindowListResult> {
      if (session.declined) return { supported: false, backend, windows: [], truncated: false, reason: DECLINED_REASON };
      const bounds = boundsOf(session.streams[0]);
      return {
        supported: true,
        backend,
        windows: [{ windowId: PORTAL_SCREEN_WINDOW_ID, title: "Shared screen", ...(bounds === undefined ? {} : { bounds }) }],
        truncated: false,
        reason: "Wayland does not list windows. The shared screen is the only target."
      };
    },

    async focusWindow(_input: { windowId?: string; appName?: string; title?: string; pid?: number }): Promise<WindowFocusResult> {
      return {
        supported: false,
        backend,
        focused: false,
        window: {},
        reason: "Wayland does not let agents focus other windows. Click on the window instead."
      };
    },

    async click(input: { x: number; y: number; button?: DesktopMouseButton; activeWindow: DesktopWindowContext }): Promise<DesktopClickResult> {
      const button: DesktopMouseButton = input.button ?? "left";
      const common = { backend, x: input.x, y: input.y, button, activeWindow: input.activeWindow };
      const opened = await ready();
      if (!opened.ok) return { ...common, supported: false, clicked: false, reason: opened.reason };
      const target = pointOnStream(opened.streams[0], input.x, input.y);
      if (target === undefined) return { ...common, supported: true, clicked: false, reason: "The point is outside the shared screen." };
      const failure = await sendInput(async () => {
        await session.pointerMotion(target.node, target.x, target.y);
        await sleep(settleMs);
        await session.pointerButton(BUTTON_CODES[button], true);
        await session.pointerButton(BUTTON_CODES[button], false);
      });
      if (failure !== undefined) return { ...common, supported: true, clicked: false, reason: failure };
      return {
        ...common,
        supported: true,
        clicked: true,
        reason: "Clicked through the RemoteDesktop portal. The compositor does not report which window received the click."
      };
    },

    async typeText(input: { text: string; activeWindow: DesktopWindowContext }): Promise<DesktopTypeTextResult> {
      const common = { backend, activeWindow: input.activeWindow, method: "direct" as const };
      const keys = keysymsForText(input.text);
      if (!keys.ok) {
        const hex = (keys.character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
        return { ...common, supported: true, typed: false, characterCount: 0, reason: `unsupported_character: U+${hex}` };
      }
      const opened = await ready();
      if (!opened.ok) return { ...common, supported: false, typed: false, characterCount: 0, reason: opened.reason };
      const failure = await sendInput(async () => {
        for (const keysym of keys.keysyms) {
          await session.keysym(keysym, true);
          await session.keysym(keysym, false);
          await sleep(settleMs);
        }
      });
      if (failure !== undefined) return { ...common, supported: true, typed: false, characterCount: 0, reason: failure };
      return {
        ...common,
        supported: true,
        typed: true,
        characterCount: keys.keysyms.length,
        reason: "Typed through the RemoteDesktop portal, one key at a time."
      };
    },

    async hotkey(input: { keys: string[]; repeat?: number; activeWindow: DesktopWindowContext }): Promise<DesktopHotkeyResult> {
      const names = input.keys.map((key) => key.trim()).filter((key) => key.length > 0);
      const common = { backend, keys: names, activeWindow: input.activeWindow };
      if (names.length === 0) return { ...common, supported: true, sent: false, reason: "No key was given." };
      const keysyms: number[] = [];
      for (const name of names) {
        const keysym = keysymForKeyName(name);
        if (keysym === undefined) return { ...common, supported: true, sent: false, reason: `unknown_key: ${name}` };
        keysyms.push(keysym);
      }
      const repeat = Math.min(Math.max(Math.trunc(input.repeat ?? 1), 1), MAX_REPEAT);
      const opened = await ready();
      if (!opened.ok) return { ...common, supported: false, sent: false, reason: opened.reason };
      // Keys go down in the order given (modifiers first) and come up in reverse.
      const failure = await sendInput(async () => {
        for (let round = 0; round < repeat; round += 1) {
          for (const keysym of keysyms) {
            await session.keysym(keysym, true);
            await sleep(settleMs);
          }
          for (const keysym of [...keysyms].reverse()) await session.keysym(keysym, false);
        }
      });
      if (failure !== undefined) return { ...common, supported: true, sent: false, reason: failure };
      return { ...common, supported: true, sent: true, reason: "Sent through the RemoteDesktop portal." };
    },

    async screenshot(input: {
      path: string;
      format?: "png" | "jpeg";
      quality?: number;
      scale?: number;
      region?: Bounds;
      includeActiveWindowOnly?: boolean;
    }): Promise<DesktopScreenshotResult> {
      if (input.includeActiveWindowOnly === true) {
        return { supported: false, backend, reason: "A window-only capture is not available on Wayland. The portal captures the shared screen." };
      }
      if (input.region !== undefined) return { supported: false, backend, reason: "A region capture is not available through the portal yet. Capture the shared screen." };
      if (input.scale !== undefined && input.scale !== 1) return { supported: false, backend, reason: "Scaling is not available through the portal yet." };
      const opened = await ready();
      if (!opened.ok) return { supported: false, backend, reason: opened.reason };
      const format = input.format ?? (/\.jpe?g$/i.test(input.path) ? "jpeg" : "png");
      try {
        const saved = await session.screenshot({ path: input.path, format, quality: input.quality ?? 85 });
        const stream = opened.streams[0];
        // The desktop tools map picture pixels from (0,0). A shared monitor elsewhere breaks that mapping, so say so.
        const offset = stream !== undefined && (stream.x !== 0 || stream.y !== 0);
        return {
          supported: true,
          backend,
          path: saved.path,
          bytesWritten: saved.bytesWritten,
          reason: offset
            ? `Captured the shared screen through the portal (PipeWire). The shared monitor starts at ${stream.x},${stream.y}, not 0,0: clicks by picture pixel are off on this monitor; use numbered actions or screen coordinates.`
            : "Captured the shared screen through the portal (PipeWire)."
        };
      } catch (error) {
        return { supported: true, backend, reason: reasonOf(error) };
      }
    },

    /** Only click is implemented on the portal path. The other pointer actions say so, rather than using X11. */
    async pointer(input: { action: "move_mouse" | "scroll" | "double_click" | "right_click" | "drag"; activeWindow: DesktopWindowContext }): Promise<DesktopPointerResult> {
      return {
        supported: false,
        backend,
        performed: false,
        action: input.action,
        activeWindow: input.activeWindow,
        reason: `The ${input.action} action is not available through the portal yet. Use click.`
      };
    },

    /** AgentHost cannot see pointer presses on Wayland, so Teach-mode waits report unavailable. */
    async waitForPointerPress(_input: unknown): Promise<{ pressed: false; reason: "unavailable"; detail: string }> {
      return { pressed: false, reason: "unavailable", detail: "AgentHost cannot see pointer presses on Wayland yet." };
    },

    async getDesktopCapabilities(): Promise<DesktopCapabilitiesResult> {
      return {
        platform: "linux",
        sessionType: "wayland",
        displayAvailable: true,
        backend,
        activeWindow: { supported: true, backend, reason: "The shared screen is the only target; the focused window is not reported." },
        screenshot: { supported: true, backend, reason: "The shared screen, through the portal after one consent." },
        windowList: { supported: true, backend, reason: "Only the shared screen is listed." },
        windowFocus: { supported: false, backend, reason: "Wayland does not let agents focus windows. Click the window instead." },
        accessibility: { supported: true, backend: "at-spi", reason: "AT-SPI does not depend on the display server." },
        guiInput: { supported: true, backend, reason: "Keyboard and pointer go through the RemoteDesktop portal after one consent." }
      };
    }
  };
}
