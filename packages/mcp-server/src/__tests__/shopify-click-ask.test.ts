import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultPolicy, invalidatePolicyCache, type AuditLogEntry } from "@agenthost/core";
import type { BrowserAutomation, BrowserElementInfo } from "@agenthost/os-linux";
import type { AgentHostMcpContext } from "../context.js";
import { applyProductionExecutionMetadata } from "../tool-metadata.js";
import { createBrowserTools } from "../tools/browser.js";
import { createDesktopTools } from "../tools/desktop.js";
import { createNumberedTools } from "../tools/numbered.js";
import { forgetViews, rememberView, type Box, type ViewTarget } from "../view-registry.js";
import { runTool } from "../tool-runner.js";

const SHOPIFY = "https://admin.shopify.com/store/demo/products/1";
const OTHER = "https://example.org/products/1";
const WIN: Box = { x: 100, y: 50, width: 600, height: 400 };

const dirs: string[] = [];
const tools = new Map<string, any>();
for (const tool of applyProductionExecutionMetadata([...createDesktopTools(), ...createBrowserTools(), ...createNumberedTools()] as never) as any[]) tools.set(tool.name, tool);

interface Counts { desktopClicks: number; browserClicks: number }

async function makeContext(url: string, elementName: string): Promise<{ context: AgentHostMcpContext; counts: Counts }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "agenthost-shopify-click-"));
  dirs.push(home);
  const counts: Counts = { desktopClicks: 0, browserClicks: 0 };
  const element: BrowserElementInfo = { name: elementName, role: "button", tag: "button", isSubmit: false, formHasPassword: false, formHasPayment: false, sensitiveField: false };
  const browser = {
    state: async () => ({ url, title: "Products" }),
    describe: async () => element,
    click: async () => { counts.browserClicks += 1; return { ok: true, url, title: "Products" }; }
  } as unknown as BrowserAutomation;
  const window = { windowId: "w1", title: "Products - Chrome", appName: "Chrome", pid: 7 };
  const context = {
    sessionId: "shopify-click",
    config: { agentHostDir: home, configPath: path.join(home, "config.json"), logFile: path.join(home, "logs", "audit.jsonl") },
    policy: getDefaultPolicy(),
    logger: { log: async (_entry: AuditLogEntry) => undefined },
    tools,
    linux: {
      browser,
      getActiveWindow: async () => ({ supported: true, backend: "fake", activeWindow: window }),
      focusWindow: async () => ({ supported: true, focused: true, backend: "fake" }),
      getActiveWindowBounds: async () => ({ supported: true, bounds: WIN, reason: "ok" }),
      listWindows: async () => ({ supported: true, backend: "fake", truncated: false, reason: "ok", windows: [{ windowId: "w1", title: window.title, appName: "Chrome", bounds: WIN }] }),
      click: async () => { counts.desktopClicks += 1; return { supported: true, clicked: true, backend: "fake" }; },
      pointer: async () => ({ supported: true, backend: "fake" })
    }
  } as unknown as AgentHostMcpContext;
  return { context, counts };
}

const screenTarget = (name: string): ViewTarget => ({ kind: "screen", bounds: { x: 120, y: 100, width: 100, height: 20 }, enabled: true, blocked: false, role: "push button", name, windowId: "w1" });
const domTarget = (name: string): ViewTarget => ({ kind: "dom", ref: "s1-e0", role: "button", name, enabled: true, blocked: false });

function viewOf(windowKey: "w1" | "browser", target: ViewTarget) {
  return rememberView({ windowKey, ...(windowKey === "browser" ? {} : { windowBounds: WIN }), source: windowKey === "browser" ? "dom" : "accessibility", targets: new Map([[1, target]]) });
}

async function numberedClick(context: AgentHostMcpContext, view: string): Promise<any> {
  const tool = tools.get("click");
  const parsed = tool.inputSchema.safeParse({ n: 1, view });
  expect(parsed.success).toBe(true);
  return tool.handler(parsed.data, context);
}

const asked = (result: any) => result.error?.code === "confirmation_required";

beforeEach(() => { forgetViews(); });
afterEach(async () => {
  invalidatePolicyCache();
  forgetViews();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("numbered click on a screen target passes the name to the safety decision", () => {
  it("asks before 'Delete product' on a store admin page and does not click", async () => {
    const { context, counts } = await makeContext(SHOPIFY, "x");
    const result = await numberedClick(context, viewOf("w1", screenTarget("Delete product")).id);
    expect(asked(result)).toBe(true);
    expect(counts.desktopClicks).toBe(0);
  });

  it("asks before 'Refund order'", async () => {
    const { context, counts } = await makeContext(SHOPIFY, "x");
    const result = await numberedClick(context, viewOf("w1", screenTarget("Refund order")).id);
    expect(asked(result)).toBe(true);
    expect(counts.desktopClicks).toBe(0);
  });

  it("runs 'Save'", async () => {
    const { context, counts } = await makeContext(SHOPIFY, "x");
    const result = await numberedClick(context, viewOf("w1", screenTarget("Save")).id);
    expect(asked(result)).toBe(false);
    expect(counts.desktopClicks).toBe(1);
  });

  it("runs a control with no name (the rule needs a name)", async () => {
    const { context, counts } = await makeContext(SHOPIFY, "x");
    const result = await numberedClick(context, viewOf("w1", screenTarget("")).id);
    expect(asked(result)).toBe(false);
    expect(counts.desktopClicks).toBe(1);
  });

  it("'Delete' on a page that is not a store admin follows the normal rules (runs)", async () => {
    const { context, counts } = await makeContext(OTHER, "x");
    const result = await numberedClick(context, viewOf("w1", screenTarget("Delete")).id);
    expect(asked(result)).toBe(false);
    expect(counts.desktopClicks).toBe(1);
  });
});

describe("numbered click on a browser element", () => {
  it("asks before 'Upload image' through the classifier, although the element label alone is harmless", async () => {
    // The real element reads "Add" (nothing in CONSEQUENTIAL_LABEL); only the passed name reaches the classifier.
    const { context, counts } = await makeContext(SHOPIFY, "Add");
    const result = await numberedClick(context, viewOf("browser", domTarget("Upload image")).id);
    expect(asked(result)).toBe(true);
    expect(counts.browserClicks).toBe(0);
  });

  it("runs 'Save' on a store admin page", async () => {
    const { context, counts } = await makeContext(SHOPIFY, "Save");
    const result = await numberedClick(context, viewOf("browser", domTarget("Save")).id);
    expect(asked(result)).toBe(false);
    expect(counts.browserClicks).toBe(1);
  });

  it("keeps the existing CONSEQUENTIAL_LABEL ask on any host", async () => {
    const { context, counts } = await makeContext(OTHER, "Delete");
    const result = await numberedClick(context, viewOf("browser", domTarget("Delete")).id);
    expect(asked(result)).toBe(true);
    expect(counts.browserClicks).toBe(0);
  });

  it("a name on a non-store page adds no ask", async () => {
    const { context, counts } = await makeContext(OTHER, "Add");
    const result = await numberedClick(context, viewOf("browser", domTarget("Upload image")).id);
    expect(asked(result)).toBe(false);
    expect(counts.browserClicks).toBe(1);
  });
});

describe("targetName on the click tools", () => {
  it("is accepted by both schemas and by the hand-written input schemas, and is limited to 200 characters", () => {
    for (const name of ["desktop.click", "browser.click"]) {
      const tool = tools.get(name);
      const base = name === "desktop.click" ? { x: 1, y: 2, activeWindow: { windowId: "w1" } } : { ref: "s1-e0" };
      expect(tool.inputSchema.safeParse({ ...base, targetName: "Save" }).success, name).toBe(true);
      expect(tool.inputSchema.safeParse({ ...base, targetName: "" }).success, name).toBe(false);
      expect(tool.inputSchema.safeParse({ ...base, targetName: "x".repeat(201) }).success, name).toBe(false);
      expect(tool.mcpInputSchema.properties.targetName, name).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    }
  });

  it("does not appear in the audit summary", () => {
    const summary = tools.get("desktop.click").auditInputSummary({ x: 1, y: 2, targetName: "Delete product", activeWindow: { appName: "Chrome" } });
    expect(summary).not.toContain("Delete product");
  });
});

describe("a window titled Shopify, with no address from the agent's own browser", () => {
  const SHOPIFY_WINDOW = { windowId: "w1", title: "testdev \u00b7 Home \u00b7 Shopify \u2014 zfc \u2014 Mozilla Firefox", appName: "firefox", pid: 9 };

  async function firefoxContext(): Promise<{ context: AgentHostMcpContext; counts: Counts }> {
    const made = await makeContext(SHOPIFY, "x");
    const linux = made.context.linux as any;
    linux.browser = undefined;
    linux.getActiveWindow = async () => ({ supported: true, backend: "fake", activeWindow: SHOPIFY_WINDOW });
    return made;
  }

  it("asks before 'Delete product' on a screen target, with no page address known", async () => {
    const { context, counts } = await firefoxContext();
    const result = await numberedClick(context, viewOf("w1", screenTarget("Delete product")).id);
    expect(asked(result)).toBe(true);
    expect(counts.desktopClicks).toBe(0);
  });

  it("still runs 'Save' on the same screen target", async () => {
    const { context, counts } = await firefoxContext();
    const result = await numberedClick(context, viewOf("w1", screenTarget("Save")).id);
    expect(asked(result)).toBe(false);
    expect(counts.desktopClicks).toBe(1);
  });
});

describe("a direct browser.click without targetName is checked by the element's own name", () => {
  it("asks before a click on 'Upload image' when the call gives no name", async () => {
    const { context, counts } = await makeContext(SHOPIFY, "Upload image");
    const result = await runTool(tools.get("browser.click") as any, { ref: "s1-e0" } as never, context);
    expect(asked(result)).toBe(true);
    expect(counts.browserClicks).toBe(0);
  });
});
