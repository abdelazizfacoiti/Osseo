import path from "node:path";
import { describe, expect, it } from "vitest";
import { installLayout, windowsCmdLauncher, windowsShellLauncher } from "../install-layout.js";
import { defaultPublicConfigPath } from "@agenthost/core";

describe("install layout", () => {
  it("keeps the Linux locations", () => {
    const layout = installLayout({ platform: "linux", home: "/home/u", env: {} });
    expect(layout.root).toBe(path.join("/home/u", ".local", "share", "agenthost"));
    expect(layout.current).toBe(path.join("/home/u", ".local", "share", "agenthost", "current"));
    expect(layout.launchers).toEqual([path.join("/home/u", ".local", "bin", "agenthost")]);
  });

  it("uses LOCALAPPDATA on Windows, and the profile folder when it is missing", () => {
    const layout = installLayout({ platform: "win32", home: "C:\\Users\\u", env: { LOCALAPPDATA: "D:\\Local" } });
    expect(layout.root).toBe("D:\\Local\\AgentHost");
    expect(layout.current).toBe("D:\\Local\\AgentHost\\current");
    expect(layout.previous).toBe("D:\\Local\\AgentHost\\current.previous");
    expect(layout.releases).toBe("D:\\Local\\AgentHost\\releases");
    expect(layout.launchers).toEqual(["D:\\Local\\AgentHost\\bin\\agenthost.cmd", "D:\\Local\\AgentHost\\bin\\agenthost"]);
    expect(installLayout({ platform: "win32", home: "C:\\Users\\u", env: {} }).root).toBe("C:\\Users\\u\\AppData\\Local\\AgentHost");
  });

  it("puts the Windows config under APPDATA and leaves Linux alone", () => {
    expect(defaultPublicConfigPath("C:\\Users\\u", { platform: "win32", env: { APPDATA: "D:\\Roaming" } })).toBe("D:\\Roaming\\agenthost\\config.json");
    expect(defaultPublicConfigPath("C:\\Users\\u", { platform: "win32", env: {} })).toBe("C:\\Users\\u\\AppData\\Roaming\\agenthost\\config.json");
    expect(defaultPublicConfigPath("/home/u", { platform: "linux" })).toBe(path.join("/home/u", ".config", "agenthost", "config.json"));
  });

  it("writes launchers that call the current release", () => {
    expect(windowsCmdLauncher()).toContain("node \"%LOCALAPPDATA%\\AgentHost\\current\\bin\\agenthost.mjs\" %*");
    expect(windowsCmdLauncher()).toMatch(/\r\n/);
    expect(windowsShellLauncher("C:\\Users\\u\\AppData\\Local")).toContain("exec node \"C:/Users/u/AppData/Local/AgentHost/current/bin/agenthost.mjs\" \"$@\"");
    expect(() => windowsShellLauncher("C:\\a\"b")).toThrow("launcher_path_unsafe");
  });
});
