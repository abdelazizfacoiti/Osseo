import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { findChromeExecutable } from "../browser-session.js";
import { killProcessTree } from "../process-tree.js";
import { windowsCommandNames } from "../dependencies.js";

const env = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
  Path: "C:\\Tools;C:\\Apps"
};

function existing(...paths: string[]): (candidate: string) => boolean {
  const set = new Set(paths.map((item) => path.win32.normalize(item).toLowerCase()));
  return (candidate: string) => set.has(path.win32.normalize(candidate).toLowerCase());
}

describe("findChromeExecutable on Windows", () => {
  it("prefers Chrome in Program Files, then Chrome per user, then Edge", () => {
    const perUser = "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
    const system = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(findChromeExecutable(env, { platform: "win32", exists: existing(system, perUser, edge) })).toBe(system);
    expect(findChromeExecutable(env, { platform: "win32", exists: existing(perUser, edge) })).toBe(perUser);
    expect(findChromeExecutable(env, { platform: "win32", exists: existing(edge) })).toBe(edge);
  });

  it("checks PATH for chrome.exe and msedge.exe when no install folder matches", () => {
    const onPath = path.win32.join("C:\\Apps", "msedge.exe");
    expect(findChromeExecutable(env, { platform: "win32", exists: existing(onPath) })).toBe(onPath);
  });

  it("returns undefined when no browser is present", () => {
    expect(findChromeExecutable(env, { platform: "win32", exists: existing() })).toBeUndefined();
  });

  it("finds the install folders from a case-varied environment", () => {
    const lower = { programfiles: "D:\\Programs" };
    const found = path.win32.join("D:\\Programs", "Google", "Chrome", "Application", "chrome.exe");
    expect(findChromeExecutable(lower, { platform: "win32", exists: existing(found) })).toBe(found);
  });
});

describe("killProcessTree", () => {
  it("walks the tree with taskkill on Windows, and forces with /F only for SIGKILL", () => {
    const calls: string[][] = [];
    const child = { pid: 4242, kill: vi.fn() };
    const run = (args: string[]) => { calls.push(args); };
    killProcessTree(child, "SIGTERM", { platform: "win32", runTaskkill: run });
    killProcessTree(child, "SIGKILL", { platform: "win32", runTaskkill: run });
    expect(calls).toEqual([["/pid", "4242", "/T"], ["/pid", "4242", "/T", "/F"]]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("signals the process itself on POSIX systems", () => {
    const child = { pid: 4242, kill: vi.fn() };
    killProcessTree(child, "SIGTERM", { platform: "linux" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back to a plain kill when taskkill cannot be started", () => {
    const child = { pid: 4242, kill: vi.fn() };
    killProcessTree(child, "SIGKILL", { platform: "win32", runTaskkill: (_args, fallback) => fallback() });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

describe("windowsCommandNames", () => {
  it("adds the PATHEXT extensions to a bare program name", () => {
    expect(windowsCommandNames("node", { PATHEXT: ".COM;.EXE;.CMD" })).toEqual(["node", "node.com", "node.exe", "node.cmd"]);
  });

  it("keeps a name that already has an extension", () => {
    expect(windowsCommandNames("powershell.exe", { PATHEXT: ".COM;.EXE" })).toEqual(["powershell.exe"]);
  });
});
