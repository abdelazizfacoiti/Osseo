import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetScreens,
  imagePointToScreen,
  recallScreen,
  rememberScreen,
  sameBounds,
  SCREENSHOT_LIMIT,
  SCREENSHOT_TTL_MS
} from "../screenshot-registry.js";

const base = {
  origin: { x: 100, y: 50 },
  pixelsPerPoint: 1,
  imageWidth: 360,
  imageHeight: 240
};

describe("screenshot registry", () => {
  beforeEach(() => forgetScreens());

  it("returns an id that recalls the capture", () => {
    const id = rememberScreen(base, 1_000);
    expect(id).toMatch(/^shot_[0-9a-f]{12}$/);
    expect(recallScreen(id, 1_000)).toMatchObject({ id, origin: { x: 100, y: 50 }, imageWidth: 360 });
  });

  it("forgets a capture after its time to live", () => {
    const id = rememberScreen(base, 1_000);
    expect(recallScreen(id, 1_000 + SCREENSHOT_TTL_MS)).toBeDefined();
    expect(recallScreen(id, 1_000 + SCREENSHOT_TTL_MS + 1)).toBeUndefined();
  });

  it("is bounded: the oldest captures go first", () => {
    const ids: string[] = [];
    for (let index = 0; index < SCREENSHOT_LIMIT + 5; index += 1) ids.push(rememberScreen(base, 1_000 + index));
    expect(recallScreen(ids[0]!, 1_000 + SCREENSHOT_LIMIT + 5)).toBeUndefined();
    expect(recallScreen(ids[ids.length - 1]!, 1_000 + SCREENSHOT_LIMIT + 5)).toBeDefined();
  });

  it("does not recall an unknown id", () => {
    expect(recallScreen("shot_000000000000")).toBeUndefined();
  });
});

describe("imagePointToScreen", () => {
  const screen = { id: "shot_x", createdAt: 0, ...base };

  it("maps a picture point to screen coordinates from the picture origin", () => {
    expect(imagePointToScreen(screen, 285, 60)).toEqual({ x: 385, y: 110 });
  });

  it("divides by the picture-per-point ratio when the picture is scaled", () => {
    const halved = { ...screen, pixelsPerPoint: 0.5 };
    expect(imagePointToScreen(halved, 100, 40)).toEqual({ x: 300, y: 130 });
  });

  it("rounds to whole screen pixels", () => {
    const scaled = { ...screen, pixelsPerPoint: 0.75 };
    expect(imagePointToScreen(scaled, 10, 10)).toEqual({ x: 113, y: 63 });
  });

  it("refuses points outside the picture, and bad numbers", () => {
    expect(imagePointToScreen(screen, 360, 0)).toEqual({ error: "image_point_outside" });
    expect(imagePointToScreen(screen, 0, 240)).toEqual({ error: "image_point_outside" });
    expect(imagePointToScreen(screen, -1, 0)).toEqual({ error: "image_point_outside" });
    expect(imagePointToScreen(screen, Number.NaN, 0)).toEqual({ error: "image_point_outside" });
  });
});

describe("sameBounds", () => {
  const box = { x: 1, y: 2, width: 300, height: 200 };

  it("is true only for identical bounds", () => {
    expect(sameBounds({ ...box }, box)).toBe(true);
    expect(sameBounds({ ...box, x: 2 }, box)).toBe(false);
    expect(sameBounds({ ...box, width: 301 }, box)).toBe(false);
  });

  it("is false when the window is gone", () => {
    expect(sameBounds(undefined, box)).toBe(false);
  });
});
