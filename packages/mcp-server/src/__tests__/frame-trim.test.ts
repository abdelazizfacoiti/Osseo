import { describe, expect, it } from "vitest";
import { frameTrim, OVERLAY_FRAME_THICKNESS } from "../frame-trim.js";

const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe("frameTrim", () => {
  it("is 6 pixels, the thickness the renderer draws", () => {
    expect(OVERLAY_FRAME_THICKNESS).toBe(6);
  });

  it("is nothing for a window clear of the screen edges", () => {
    expect(frameTrim({ x: 200, y: 100, width: 800, height: 600 }, screen)).toBeUndefined();
  });

  it("cuts only the sides that touch an edge", () => {
    // The terminal in the first real run: touches the bottom edge only.
    expect(frameTrim({ x: 66, y: 32, width: 1509, height: 1048 }, screen)).toEqual({ left: 0, top: 0, right: 0, bottom: 6 });
    expect(frameTrim({ x: 0, y: 400, width: 400, height: 300 }, screen)).toEqual({ left: 6, top: 0, right: 0, bottom: 0 });
  });

  it("cuts all four sides of a maximized window", () => {
    expect(frameTrim({ x: 0, y: 0, width: 1920, height: 1080 }, screen)).toEqual({ left: 6, top: 6, right: 6, bottom: 6 });
  });

  it("cuts only the part of the window that is under the strip when it is partly off the edge", () => {
    expect(frameTrim({ x: 4, y: 100, width: 300, height: 300 }, screen)).toEqual({ left: 2, top: 0, right: 0, bottom: 0 });
    expect(frameTrim({ x: -10, y: 100, width: 300, height: 300 }, screen)).toEqual({ left: 16, top: 0, right: 0, bottom: 0 });
  });

  it("honours a screen that does not start at the origin", () => {
    expect(frameTrim({ x: 1920, y: 0, width: 800, height: 600 }, { x: 1920, y: 0, width: 2560, height: 1440 })).toEqual({ left: 6, top: 6, right: 0, bottom: 0 });
  });

  it("keeps the capture whole rather than empty when the window is almost all strip, and ignores a zero thickness", () => {
    expect(frameTrim({ x: 0, y: 0, width: 6, height: 400 }, screen, 6)).toBeUndefined();
    expect(frameTrim({ x: 0, y: 0, width: 1920, height: 1080 }, screen, 0)).toBeUndefined();
  });
});
