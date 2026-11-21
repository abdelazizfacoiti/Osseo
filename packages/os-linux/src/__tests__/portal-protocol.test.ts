import { describe, expect, it } from "vitest";
import {
  BUTTON_CODES,
  isWaylandSession,
  keysymForCharacter,
  keysymForKeyName,
  keysymsForText,
  portalRequested,
  shouldUseWaylandPortal
} from "../portal/portal-protocol.js";

describe("portal keysyms", () => {
  it("maps Latin-1 characters to their code points and other characters to the Unicode range", () => {
    expect(keysymForCharacter("a")).toBe(0x61);
    expect(keysymForCharacter("A")).toBe(0x41);
    expect(keysymForCharacter(" ")).toBe(0x20);
    expect(keysymForCharacter("é")).toBe(0xe9);
    expect(keysymForCharacter("€")).toBe(0x01000000 + 0x20ac);
    expect(keysymForCharacter("\n")).toBe(0xff0d);
    expect(keysymForCharacter("\t")).toBe(0xff09);
    expect(keysymForCharacter("\u0007")).toBeUndefined();
    expect(keysymForCharacter("ab")).toBeUndefined();
  });

  it("types a text one key at a time, or names the first character it cannot send", () => {
    expect(keysymsForText("Hi\n")).toEqual({ ok: true, keysyms: [0x48, 0x69, 0xff0d] });
    expect(keysymsForText("a\u0001b")).toEqual({ ok: false, character: "\u0001" });
  });

  it("maps hotkey names, function keys and single characters", () => {
    expect(keysymForKeyName("ctrl")).toBe(0xffe3);
    expect(keysymForKeyName("Ctrl")).toBe(0xffe3);
    expect(keysymForKeyName("Enter")).toBe(0xff0d);
    expect(keysymForKeyName("F5")).toBe(0xffbe + 4);
    expect(keysymForKeyName("f12")).toBe(0xffc9);
    expect(keysymForKeyName("a")).toBe(0x61);
    expect(keysymForKeyName("f13")).toBeUndefined();
    expect(keysymForKeyName("constructor")).toBeUndefined();
    expect(keysymForKeyName("   ")).toBeUndefined();
  });
});

describe("portal flags and buttons", () => {
  it("uses the Linux input event codes for the buttons", () => {
    expect(BUTTON_CODES).toEqual({ left: 272, right: 273, middle: 274 });
  });

  it("detects Wayland from the session type or WAYLAND_DISPLAY, never from an x11 session", () => {
    expect(isWaylandSession({ XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(isWaylandSession({ WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(isWaylandSession({ XDG_SESSION_TYPE: "x11", WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
    expect(isWaylandSession({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toBe(false);
    expect(isWaylandSession({})).toBe(false);
  });

  it("uses the portal only when it was requested on a Wayland session", () => {
    expect(portalRequested({ OSSEO_WAYLAND_PORTAL: "1" })).toBe(true);
    expect(portalRequested({ OSSEO_WAYLAND_PORTAL: "yes" })).toBe(false);
    expect(shouldUseWaylandPortal({ OSSEO_WAYLAND_PORTAL: "1", XDG_SESSION_TYPE: "wayland" })).toBe(true);
    expect(shouldUseWaylandPortal({ OSSEO_WAYLAND_PORTAL: "1", XDG_SESSION_TYPE: "x11" })).toBe(false);
    expect(shouldUseWaylandPortal({ XDG_SESSION_TYPE: "wayland" })).toBe(false);
  });
});
