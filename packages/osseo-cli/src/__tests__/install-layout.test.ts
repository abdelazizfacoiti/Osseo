import path from "node:path";
import { describe, expect, it } from "vitest";
import { installLayout, windowsCmdLauncher, windowsShellLauncher } from "../install-layout.js";
import { defaultPublicConfigPath } from "@osseo/core";

describe("install layout", () => {
  it("keeps the Linux locations", () => {
    const layout = installLayout({ platform: "linux", home: "/home/u", env: {} });
    expect(layout.root).toBe(path.join("/home/u", ".local", "share", "osseo"));
    expect(layout.current).toBe(path.join("/home/u", ".local", "share", "osseo", "current"));
    expect(layout.launchers).toEqual([path.join("/home/u", ".local", "bin", "osseo")]);
  });

  it("uses LOCALAPPDATA on Windows, and the profile folder when it is missing", () => {
    const layout = installLayout({ platform: "win32", home: "C:\\Users\\u", env: { LOCALAPPDATA: "D:\\Local" } });
    expect(layout.root).toBe("D:\\Local\\Osseo");
    expect(layout.current).toBe("D:\\Local\\Osseo\\current");
    expect(layout.previous).toBe("D:\\Local\\Osseo\\current.previous");
    expect(layout.releases).toBe("D:\\Local\\Osseo\\releases");
    expect(layout.launchers).toEqual(["D:\\Local\\Osseo\\bin\\osseo.cmd", "D:\\Local\\Osseo\\bin\\osseo"]);
    expect(installLayout({ platform: "win32", home: "C:\\Users\\u", env: {} }).root).toBe("C:\\Users\\u\\AppData\\Local\\Osseo");
  });

  it("puts the Windows config under APPDATA and leaves Linux alone", () => {
    expect(defaultPublicConfigPath("C:\\Users\\u", { platform: "win32", env: { APPDATA: "D:\\Roaming" } })).toBe("D:\\Roaming\\osseo\\config.json");
    expect(defaultPublicConfigPath("C:\\Users\\u", { platform: "win32", env: {} })).toBe("C:\\Users\\u\\AppData\\Roaming\\osseo\\config.json");
    expect(defaultPublicConfigPath("/home/u", { platform: "linux" })).toBe(path.join("/home/u", ".config", "osseo", "config.json"));
  });

  it("writes launchers that call the current release", () => {
    expect(windowsCmdLauncher()).toContain("node \"%LOCALAPPDATA%\\Osseo\\current\\bin\\osseo.mjs\" %*");
    expect(windowsCmdLauncher()).toMatch(/\r\n/);
    expect(windowsShellLauncher("C:\\Users\\u\\AppData\\Local")).toContain("exec node \"C:/Users/u/AppData/Local/Osseo/current/bin/osseo.mjs\" \"$@\"");
    expect(() => windowsShellLauncher("C:\\a\"b")).toThrow("launcher_path_unsafe");
  });
});
