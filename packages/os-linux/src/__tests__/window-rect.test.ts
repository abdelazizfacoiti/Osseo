import { describe, expect, it } from "vitest";
import { parseXwininfoRect } from "../desktop.js";

// Output of `xwininfo -id` for Blender on GNOME/X11: a server-side title bar of 37 px sits above the client area.
const BLENDER = `
xwininfo: Window id: 0x3400002 "* (Unsaved) — Blender 5.3.0"

  Absolute upper-left X:  66
  Absolute upper-left Y:  69
  Relative upper-left X:  0
  Relative upper-left Y:  37
  Width: 1509
  Height: 1011
  Depth: 24
`;

describe("parseXwininfoRect", () => {
  it("reads the absolute client rectangle, not the frame-relative one", () => {
    expect(parseXwininfoRect(BLENDER)).toEqual({ x: 66, y: 69, width: 1509, height: 1011 });
  });

  it("returns undefined for output it cannot read", () => {
    expect(parseXwininfoRect("")).toBeUndefined();
    expect(parseXwininfoRect("xwininfo: error: No such window")).toBeUndefined();
    expect(parseXwininfoRect(BLENDER.replace("Width: 1509", "Width: 0"))).toBeUndefined();
  });
});
