import { describe, expect, it } from "vitest";
import { PORTAL_SCREEN_WINDOW, createPortalDesktop } from "../portal/portal-desktop.js";
import { PortalError, type PortalSession, type PortalStream } from "../portal/portal-session.js";

type Call = { kind: "open" | "motion" | "button" | "keysym" | "shot"; args: unknown[] };

const DEFAULT_STREAMS: PortalStream[] = [{ node: 42, x: 100, y: 0, width: 1280, height: 800 }];

/** A stand-in for PortalSession that records every call. `deny` refuses consent; `failInput` breaks input. */
function fakeSession(options: { deny?: boolean; failInput?: boolean; streams?: PortalStream[] } = {}) {
  const calls: Call[] = [];
  const streams = options.streams ?? DEFAULT_STREAMS;
  let opened = false;
  let declined = false;
  const failure = (): never => {
    throw new PortalError("helper_exited", "The portal helper exited (3).");
  };
  const session = {
    calls,
    get isOpen(): boolean {
      return opened;
    },
    get declined(): boolean {
      return declined;
    },
    get streams(): PortalStream[] {
      return opened ? streams : [];
    },
    async open(input: unknown) {
      calls.push({ kind: "open", args: [input] });
      if (options.deny === true) {
        declined = true;
        throw new PortalError("consent_denied", "The person did not allow remote control.");
      }
      opened = true;
      return { devices: 3, streams };
    },
    async pointerMotion(node: number, x: number, y: number) {
      calls.push({ kind: "motion", args: [node, x, y] });
    },
    async pointerButton(button: number, pressed: boolean) {
      if (options.failInput === true) failure();
      calls.push({ kind: "button", args: [button, pressed] });
    },
    async keysym(keysym: number, pressed: boolean) {
      calls.push({ kind: "keysym", args: [keysym, pressed] });
    },
    async screenshot(input: { path: string; format: "png" | "jpeg"; quality?: number }) {
      calls.push({ kind: "shot", args: [input] });
      return { path: input.path, bytesWritten: 99, format: input.format };
    }
  };
  return session;
}

type FakeSession = ReturnType<typeof fakeSession>;
const desktopFor = (session: FakeSession) =>
  createPortalDesktop(session as unknown as PortalSession, { settleMs: 0, sleep: async () => undefined });
/** The input calls only: the open that asks the person is not an input. */
const inputs = (session: FakeSession) => session.calls.filter((call) => call.kind !== "open").map((call) => [call.kind, ...call.args]);
const screen = { windowId: "portal-screen" };

describe("portal desktop: pointer", () => {
  it("maps a global point onto the shared monitor and sends motion, then press and release", async () => {
    const session = fakeSession();
    const result = await desktopFor(session).click({ x: 150, y: 40, activeWindow: screen });
    expect(result).toMatchObject({ supported: true, clicked: true, backend: "wayland-portal", x: 150, y: 40, button: "left" });
    expect(inputs(session)).toEqual([
      ["motion", 42, 50, 40],
      ["button", 272, true],
      ["button", 272, false]
    ]);
  });

  it("uses the right button code for a right click", async () => {
    const session = fakeSession();
    await desktopFor(session).click({ x: 101, y: 1, button: "right", activeWindow: screen });
    expect(inputs(session).filter((call) => call[0] === "button")).toEqual([["button", 273, true], ["button", 273, false]]);
  });

  it("refuses a point outside the shared monitor and sends nothing", async () => {
    const session = fakeSession();
    const result = await desktopFor(session).click({ x: 10, y: 10, activeWindow: screen });
    expect(result).toMatchObject({ supported: true, clicked: false, reason: "The point is outside the shared screen." });
    expect(inputs(session)).toEqual([]);
  });

  it("reports a refused consent as a failed click, with nothing sent", async () => {
    const session = fakeSession({ deny: true });
    const result = await desktopFor(session).click({ x: 150, y: 40, activeWindow: screen });
    expect(result).toMatchObject({ supported: false, clicked: false });
    expect(result.reason).toContain("consent_denied");
    expect(inputs(session)).toEqual([]);
  });

  it("reports an input failure as text, not as a thrown error", async () => {
    const session = fakeSession({ failInput: true });
    const result = await desktopFor(session).click({ x: 150, y: 40, activeWindow: screen });
    expect(result).toMatchObject({ supported: true, clicked: false });
    expect(result.reason).toContain("helper_exited");
  });

  it("refuses the pointer actions other than click, and pointer presses are unavailable", async () => {
    const desktop = desktopFor(fakeSession());
    const drag = await desktop.pointer({ action: "drag", activeWindow: screen });
    expect(drag).toMatchObject({ supported: false, performed: false, action: "drag" });
    expect(await desktop.waitForPointerPress({})).toMatchObject({ pressed: false, reason: "unavailable" });
  });
});

describe("portal desktop: keyboard", () => {
  it("types each character as a press and release, Unicode included", async () => {
    const session = fakeSession();
    const result = await desktopFor(session).typeText({ text: "Hé!", activeWindow: screen });
    expect(result).toMatchObject({ supported: true, typed: true, characterCount: 3, method: "direct" });
    expect(inputs(session)).toEqual([
      ["keysym", 0x48, true],
      ["keysym", 0x48, false],
      ["keysym", 0xe9, true],
      ["keysym", 0xe9, false],
      ["keysym", 0x21, true],
      ["keysym", 0x21, false]
    ]);
  });

  it("refuses a control character before sending any key", async () => {
    const session = fakeSession();
    const result = await desktopFor(session).typeText({ text: "a\u0001b", activeWindow: screen });
    expect(result).toMatchObject({ supported: true, typed: false });
    expect(result.reason).toBe("unsupported_character: U+0001");
    expect(inputs(session)).toEqual([]);
  });

  it("presses hotkey keys in order and releases them in reverse", async () => {
    const session = fakeSession();
    const result = await desktopFor(session).hotkey({ keys: ["ctrl", "shift", "t"], activeWindow: screen });
    expect(result).toMatchObject({ supported: true, sent: true, keys: ["ctrl", "shift", "t"] });
    expect(inputs(session)).toEqual([
      ["keysym", 0xffe3, true],
      ["keysym", 0xffe1, true],
      ["keysym", 0x74, true],
      ["keysym", 0x74, false],
      ["keysym", 0xffe1, false],
      ["keysym", 0xffe3, false]
    ]);
  });

  it("repeats a hotkey and refuses an unknown key before sending anything", async () => {
    const session = fakeSession();
    const desktop = desktopFor(session);
    await desktop.hotkey({ keys: ["enter"], repeat: 2, activeWindow: screen });
    expect(inputs(session)).toEqual([
      ["keysym", 0xff0d, true],
      ["keysym", 0xff0d, false],
      ["keysym", 0xff0d, true],
      ["keysym", 0xff0d, false]
    ]);
    const before = inputs(session).length;
    const unknown = await desktop.hotkey({ keys: ["ctrl", "nope?"], activeWindow: screen });
    expect(unknown).toMatchObject({ supported: true, sent: false, reason: "unknown_key: nope?" });
    expect(inputs(session).length).toBe(before);
  });
});

describe("portal desktop: screen and windows", () => {
  it("captures the shared screen as PNG, or JPEG by extension, and says so", async () => {
    const session = fakeSession();
    const desktop = desktopFor(session);
    const png = await desktop.screenshot({ path: "/tmp/shot.png" });
    expect(png).toMatchObject({ supported: true, backend: "wayland-portal", path: "/tmp/shot.png", bytesWritten: 99 });
    const jpeg = await desktop.screenshot({ path: "/tmp/shot.JPG" });
    expect(jpeg).toMatchObject({ supported: true });
    const shots = session.calls.filter((call) => call.kind === "shot").map((call) => call.args[0]);
    expect(shots).toEqual([
      { path: "/tmp/shot.png", format: "png", quality: 85 },
      { path: "/tmp/shot.JPG", format: "jpeg", quality: 85 }
    ]);
  });

  it("refuses window-only, region and scaled captures instead of falling back to X11", async () => {
    const desktop = desktopFor(fakeSession());
    expect((await desktop.screenshot({ path: "/tmp/a.png", includeActiveWindowOnly: true })).supported).toBe(false);
    expect((await desktop.screenshot({ path: "/tmp/a.png", region: { x: 0, y: 0, width: 10, height: 10 } })).supported).toBe(false);
    expect((await desktop.screenshot({ path: "/tmp/a.png", scale: 0.5 })).supported).toBe(false);
  });

  it("warns when the shared monitor does not start at 0,0, because pixel mapping assumes that", async () => {
    const desktop = desktopFor(fakeSession());
    const result = await desktop.screenshot({ path: "/tmp/a.png" });
    expect(result.reason).toContain("starts at 100,0");
  });

  it("reports the shared screen as the one window, and its bounds once open", async () => {
    const session = fakeSession();
    const desktop = desktopFor(session);
    expect(await desktop.getActiveWindowBounds()).toMatchObject({ supported: false });
    const active = await desktop.getActiveWindow();
    expect(active).toMatchObject({ supported: true, activeWindow: PORTAL_SCREEN_WINDOW });
    // The first capture is what asks the person; after it the bounds are known.
    await desktop.screenshot({ path: "/tmp/open.png" });
    expect(await desktop.getActiveWindowBounds()).toMatchObject({ supported: true, bounds: { x: 100, y: 0, width: 1280, height: 800 } });
    const listed = await desktop.listWindows({});
    expect(listed.windows).toEqual([{ windowId: "portal-screen", title: "Shared screen", bounds: { x: 100, y: 0, width: 1280, height: 800 } }]);
  });

  it("reads never ask the person: window context, window list, bounds and capabilities open nothing", async () => {
    const session = fakeSession();
    const desktop = desktopFor(session);
    await desktop.getActiveWindow();
    await desktop.listWindows({});
    await desktop.getActiveWindowBounds();
    await desktop.getScreenGeometry();
    await desktop.getDesktopCapabilities();
    expect(session.calls).toEqual([]);
  });

  it("after a refusal, the window context and the window list say so instead of pretending", async () => {
    const session = fakeSession({ deny: true });
    const desktop = desktopFor(session);
    await desktop.click({ x: 150, y: 40, activeWindow: screen });
    const active = await desktop.getActiveWindow();
    expect(active).toMatchObject({ supported: false });
    expect(active.reason).toContain("consent_denied");
    expect((await desktop.listWindows({})).supported).toBe(false);
  });

  it("does not focus windows on Wayland and describes its capabilities honestly", async () => {
    const desktop = desktopFor(fakeSession());
    expect(await desktop.focusWindow({ windowId: "12" })).toMatchObject({ supported: false, focused: false });
    const caps = await desktop.getDesktopCapabilities();
    expect(caps).toMatchObject({ sessionType: "wayland", backend: "wayland-portal", windowFocus: { supported: false }, guiInput: { supported: true } });
  });
});
