import { describe, expect, it } from "vitest";
import { isAgentBrowserWindow } from "../agent-window.js";
import type { OsseoMcpContext } from "../context.js";

const page = { title: "Download Windows 11" };
const context = (pid?: number) => ({ linux: { browser: pid === undefined ? {} : { processId: async () => pid } } }) as unknown as OsseoMcpContext;

describe("isAgentBrowserWindow", () => {
  it("accepts the agent browser's own window", async () => {
    expect(await isAgentBrowserWindow(context(500), { title: "Download Windows 11 - Google Chrome", app: "chrome", pid: 500 }, page)).toBe(true);
  });

  it("refuses another browser showing a page with the same title", async () => {
    expect(await isAgentBrowserWindow(context(500), { title: "Download Windows 11 — Mozilla Firefox", app: "firefox", pid: 900 }, page)).toBe(false);
    // The person's own Chrome has the same app name; only the process tells them apart.
    expect(await isAgentBrowserWindow(context(500), { title: "Download Windows 11 - Google Chrome", app: "chrome", pid: 900 }, page)).toBe(false);
  });

  it("needs the page title even for the agent's process", async () => {
    expect(await isAgentBrowserWindow(context(500), { title: "Other - Google Chrome", app: "chrome", pid: 500 }, page)).toBe(false);
    expect(await isAgentBrowserWindow(context(500), { title: "x", app: "chrome", pid: 500 }, { title: " " })).toBe(false);
  });

  it("without both process ids, accepts only a Chromium-family or unnamed window", async () => {
    const title = "Download Windows 11";
    expect(await isAgentBrowserWindow(context(), { title, app: "firefox", pid: 900 }, page)).toBe(false);
    expect(await isAgentBrowserWindow(context(), { title, app: "chromium-browser", pid: 900 }, page)).toBe(true);
    expect(await isAgentBrowserWindow(context(500), { title, app: "msedge" }, page)).toBe(true);
    expect(await isAgentBrowserWindow(context(500), { title }, page)).toBe(true);
  });
});
