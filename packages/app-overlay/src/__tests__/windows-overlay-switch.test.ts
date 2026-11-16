import { describe, expect, it } from "vitest";
import { windowsOverlayEnabled } from "../windows-renderer.js";

describe("windowsOverlayEnabled", () => {
  it("is off by default", () => {
    expect(windowsOverlayEnabled({})).toBe(false);
  });

  it("turns on with AGENTHOST_WINDOWS_OVERLAY=1, as before", () => {
    expect(windowsOverlayEnabled({ AGENTHOST_WINDOWS_OVERLAY: "1" })).toBe(true);
  });

  it("turns on with overlay.windows in config.json", () => {
    expect(windowsOverlayEnabled({}, true)).toBe(true);
  });

  it("is not turned on by other values", () => {
    expect(windowsOverlayEnabled({ AGENTHOST_WINDOWS_OVERLAY: "true" })).toBe(false);
    expect(windowsOverlayEnabled({}, false)).toBe(false);
  });
});
