import { describe, expect, it } from "vitest";
import { describeDesktopPlatform } from "../platform.js";

const linux = (env: Record<string, string>) => describeDesktopPlatform({ platform: "linux", env });

describe("desktop platform report", () => {
  it("reports full control on X11 and limited control on XWayland", () => {
    expect(linux({ XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })).toMatchObject({ session: "x11", control: "full" });
    const xwayland = linux({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" });
    expect(xwayland).toMatchObject({ session: "xwayland", control: "x11-windows-only" });
    expect(xwayland.guidance.join(" ")).toContain("nested X display");
  });

  it("is honest about native Wayland, headless, Windows, and macOS", () => {
    expect(linux({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" })).toMatchObject({ session: "wayland", control: "none" });
    expect(linux({})).toMatchObject({ session: "headless", control: "none" });
    expect(describeDesktopPlatform({ platform: "win32" })).toMatchObject({ os: "windows", control: "none" });
    expect(describeDesktopPlatform({ platform: "darwin" })).toMatchObject({ os: "macos", control: "none" });
    expect(describeDesktopPlatform({ platform: "freebsd" })).toMatchObject({ os: "other", control: "none" });
  });
});
