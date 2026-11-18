import { describe, expect, it } from "vitest";
import { regionFromBounds } from "../tools/vision.js";

describe("regionFromBounds", () => {
  it("passes a window that is fully on screen through as whole pixels", () => {
    expect(regionFromBounds({ x: 66, y: 32, width: 1509, height: 1048 })).toEqual({ x: 66, y: 32, width: 1509, height: 1048 });
    expect(regionFromBounds({ x: 10.4, y: 20.6, width: 300.2, height: 200.7 })).toEqual({ x: 10, y: 21, width: 300, height: 201 });
  });

  it("trims the part of a window that is off the left or top edge", () => {
    expect(regionFromBounds({ x: -20, y: -10, width: 400, height: 300 })).toEqual({ x: 0, y: 0, width: 380, height: 290 });
  });

  it("has no region for nothing, or for a window with almost nothing on screen", () => {
    expect(regionFromBounds(undefined)).toBeUndefined();
    expect(regionFromBounds({ x: -395, y: 0, width: 400, height: 300 })).toBeUndefined();
  });
});
