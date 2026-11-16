import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { browserCandidates, openWindowsUrl } from "../open-url.js";

function fakeChild(fail?: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { pid: 4242, unref: () => undefined });
  queueMicrotask(() => (fail === undefined ? child.emit("spawn") : child.emit("error", new Error(fail))));
  return child;
}
const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" };

describe("openWindowsUrl", () => {
  it("opens the default browser through rundll32 with the URL as one argument, never xdg-open", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await openWindowsUrl({ url: "https://www.avito.ma/fr/maroc/voitures?price=10000-12000&fuel=1" }, { env, spawn: (command, args) => { calls.push({ command, args }); return fakeChild(); } });
    expect(result).toMatchObject({ opened: true, launcher: "default browser", pid: 4242 });
    expect(calls).toEqual([{ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://www.avito.ma/fr/maroc/voitures?price=10000-12000&fuel=1"] }]);
  });

  it("opens a named browser in a new tab from its install folder", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const result = await openWindowsUrl({ url: "https://example.com", browser: "google-chrome" }, { env, exists: (file) => file === chrome, spawn: (command, args) => { calls.push({ command, args }); return fakeChild(); } });
    expect(result.opened).toBe(true);
    expect(calls).toEqual([{ command: chrome, args: ["--new-tab", "https://example.com/"] }]);
    const firefox = await openWindowsUrl({ url: "https://example.com", browser: "firefox" }, { env, exists: (file) => file.endsWith("firefox.exe"), spawn: (command, args) => { calls.push({ command, args }); return fakeChild(); } });
    expect(firefox.opened).toBe(true);
    expect(calls[1]?.args[0]).toBe("-new-tab");
  });

  it("says which browser is missing and how to carry on, without starting anything", async () => {
    let started = false;
    const result = await openWindowsUrl({ url: "https://example.com", browser: "firefox" }, { env, exists: () => false, spawn: () => { started = true; return fakeChild(); } });
    expect(result.opened).toBe(false);
    expect(result.reason).toContain("firefox was not found");
    expect(result.reason).toContain("default one");
    expect(started).toBe(false);
  });

  it("refuses other schemes and invalid URLs", async () => {
    expect((await openWindowsUrl({ url: "javascript:alert(1)" }, { env })).opened).toBe(false);
    expect((await openWindowsUrl({ url: "ms-settings:privacy" }, { env })).reason).toContain("Only http");
    expect((await openWindowsUrl({ url: "not a url" }, { env })).reason).toContain("not valid");
  });

  it("reports a launch error", async () => {
    const result = await openWindowsUrl({ url: "https://example.com" }, { env, spawn: () => fakeChild("spawn rundll32.exe ENOENT") });
    expect(result).toMatchObject({ opened: false, reason: "spawn rundll32.exe ENOENT" });
  });

  it("looks for Chrome, Edge, Firefox and Brave in Program Files and the user folder", () => {
    expect(browserCandidates("google-chrome", env)).toContain("C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
    expect(browserCandidates("microsoft-edge", env)[0]).toBe("C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe");
    expect(browserCandidates("firefox", env)[0]).toBe("C:\\Program Files\\Mozilla Firefox\\firefox.exe");
    expect(browserCandidates("brave-browser", env)[0]).toContain("brave.exe");
    expect(browserCandidates("unknown", env)).toEqual([]);
  });
});
