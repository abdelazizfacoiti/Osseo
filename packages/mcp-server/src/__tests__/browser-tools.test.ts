import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptConfirmation, getDefaultPolicy, type AuditLogEntry } from "@agenthost/core";
import { BrowserSession, findChromeExecutable, type BrowserAutomation, type BrowserElementInfo } from "@agenthost/os-linux";
import type { AgentHostMcpContext } from "../context.js";
import { applyProductionExecutionMetadata } from "../tool-metadata.js";
import { runTool } from "../tool-runner.js";
import { createBrowserTools } from "../tools/browser.js";

const directories: string[] = [];
async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenthost-browser-tools-"));
  directories.push(directory);
  return directory;
}
// Chrome helper processes can flush the profile briefly after the browser exits.
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }))); });

const tools = new Map(applyProductionExecutionMetadata(createBrowserTools() as never).map((tool) => [tool.name, tool]));
const tool = (name: string) => tools.get(name)!;

interface Fake { browser: BrowserAutomation; calls: string[] }
function fakeBrowser(options: { url?: string; elements?: Record<string, BrowserElementInfo> } = {}): Fake {
  const calls: string[] = [];
  const url = options.url ?? "https://shop.example.com/cart?token=secret";
  const browser: BrowserAutomation = {
    open: async (input) => { calls.push(`open:${input.url ?? ""}`); return { opened: true, url: input.url ?? "about:blank", title: "t", headless: false }; },
    state: async () => ({ url, title: "t" }),
    snapshot: async () => ({ url, title: "t", elements: [{ ref: "s1-e0", role: "button", name: "Add", tag: "button" }], text: "Cart", truncated: false }),
    describe: async ({ ref }) => options.elements?.[ref],
    click: async ({ ref }) => { calls.push(`click:${ref}`); return { ok: true, url, title: "t" }; },
    type: async ({ ref, text }) => { calls.push(`type:${ref}:${text.length}`); return { ok: true, url, title: "t" }; },
    navigate: async (input) => { calls.push(`navigate:${input.action}`); return { ok: true, url: input.url ?? url, title: "t" }; },
    close: async () => { calls.push("close"); },
    upload: async (input) => { calls.push(`upload:${input.ref}:${input.files.length}`); return { ok: true, url, title: "t" }; },
    select: async (input) => { calls.push(`select:${input.ref}`); return { ok: true, selected: input.label ?? input.value ?? "", url, title: "t" }; },
    waitFor: async () => ({ matched: true, elapsedMs: 1, url, title: "t" }),
    readValue: async () => "Ada",
    screenshot: async () => ({ ok: true, image: { data: "AAAA", mimeType: "image/jpeg" } })
  };
  return { browser, calls };
}

function context(home: string, browser: BrowserAutomation | undefined): AgentHostMcpContext {
  return {
    sessionId: "browser-test",
    config: { agentHostDir: home, configPath: path.join(home, "config.json"), logFile: path.join(home, "logs", "audit.jsonl") },
    policy: getDefaultPolicy(),
    logger: { log: async (_entry: AuditLogEntry) => undefined },
    linux: browser === undefined ? {} : { browser }
  } as unknown as AgentHostMcpContext;
}

const element = (overrides: Partial<BrowserElementInfo>): BrowserElementInfo => ({ name: "Add one", role: "button", tag: "button", isSubmit: false, formHasPassword: false, formHasPayment: false, sensitiveField: false, ...overrides });

describe("browser tools", () => {
  it("reports unavailable without a browser, and not-open before open", async () => {
    const home = await tempHome();
    expect((await runTool(tool("browser.snapshot"), {}, context(home, undefined))).error?.code).toBe("unsupported");
    const closed = fakeBrowser();
    closed.browser.state = async () => undefined;
    expect((await runTool(tool("browser.click"), { ref: "s1-e0" }, context(home, closed.browser))).error?.code).toBe("browser_not_open");
  });

  it("clicks ordinary controls directly and marks page text as untrusted", async () => {
    const home = await tempHome();
    const fake = fakeBrowser({ elements: { "s1-e0": element({}) } });
    const click = await runTool(tool("browser.click"), { ref: "s1-e0" }, context(home, fake.browser));
    expect(click.ok).toBe(true);
    expect(fake.calls).toEqual(["click:s1-e0"]);
    expect(JSON.stringify(click.data)).not.toContain("token=secret");
    const snap = await runTool(tool("browser.snapshot"), {}, context(home, fake.browser));
    expect(snap.ok).toBe(true);
    expect(snap.untrustedContent).toBe(true);
  });

  it("requires an exact confirmation for consequential clicks and runs them once", async () => {
    const home = await tempHome();
    const fake = fakeBrowser({ elements: { "s1-e1": element({ name: "Place order" }) } });
    const ctx = context(home, fake.browser);
    const refused = await runTool(tool("browser.click"), { ref: "s1-e1" }, ctx);
    expect(refused.ok).toBe(false);
    expect(fake.calls).toEqual([]);
    const preview = await runTool(tool("browser.click"), { ref: "s1-e1", dryRun: true }, ctx);
    expect(preview.ok).toBe(true);
    expect(JSON.stringify(preview)).toContain("Place order");
    const tokenId = preview.confirmation?.tokenId;
    expect(tokenId).toMatch(/^conf_/);
    await acceptConfirmation(home, tokenId!);
    expect((await runTool(tool("browser.click"), { ref: "s1-e1", confirmationToken: tokenId }, ctx)).ok).toBe(true);
    expect(fake.calls).toEqual(["click:s1-e1"]);
    // The token binds to that element: a different one cannot reuse it.
    expect((await runTool(tool("browser.click"), { ref: "s1-e2", confirmationToken: tokenId }, ctx)).ok).toBe(false);
  });

  it("treats a submit button in a password or payment form as consequential", async () => {
    const home = await tempHome();
    const fake = fakeBrowser({ elements: { "s1-e3": element({ name: "Continue", isSubmit: true, formHasPassword: true }) } });
    const result = await runTool(tool("browser.click"), { ref: "s1-e3" }, context(home, fake.browser));
    expect(result.ok).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("never types into password, one-time-code, or card fields", async () => {
    const home = await tempHome();
    const fake = fakeBrowser({ elements: { "s1-e4": element({ name: "Password", role: "textbox", tag: "input", type: "password", sensitiveField: true }) } });
    const result = await runTool(tool("browser.type"), { ref: "s1-e4", text: "hunter2" }, context(home, fake.browser));
    expect(result.ok).toBe(false);
    expect(fake.calls).toEqual([]);
    const preview = await runTool(tool("browser.type"), { ref: "s1-e4", text: "hunter2", dryRun: true }, context(home, fake.browser));
    expect(preview.ok).toBe(false);
  });

  it("refuses security pages and points at the handoff", async () => {
    const home = await tempHome();
    const fake = fakeBrowser({ url: "https://accounts.example.com/login?next=/", elements: { "s1-e0": element({}) } });
    const snap = await runTool(tool("browser.snapshot"), {}, context(home, fake.browser));
    expect(snap.ok).toBe(false);
    expect(snap.observations.join(" ")).toContain("agent.request_handoff");
    const click = await runTool(tool("browser.click"), { ref: "s1-e0" }, context(home, fake.browser));
    expect(click.ok).toBe(false);
    expect(fake.calls).toEqual([]);
  });

  it("flags a landing login page after navigation", async () => {
    const home = await tempHome();
    const fake = fakeBrowser();
    const navigate = vi.fn(fake.browser.navigate);
    fake.browser.navigate = async (input) => { const result = await navigate(input); return { ...result, url: "https://accounts.example.com/signin" }; };
    const result = await runTool(tool("browser.navigate"), { action: "goto", url: "https://example.com/start" }, context(home, fake.browser));
    expect(result.ok).toBe(true);
    expect(result.observations.join(" ")).toContain("agent.request_handoff");
  });
});

describe.skipIf(findChromeExecutable() === undefined)("browser tools end to end (real headless Chrome)", () => {
  it("drives a real page through the governed runner, confirming only the consequential click", async () => {
    const home = await tempHome();
    const page = path.join(home, "shop.html");
    await writeFile(page, `<!doctype html><title>Shop</title>
      <input placeholder="Search"><button onclick="document.title='added'">Add to list</button>
      <button onclick="document.title='ordered'">Place order</button>`);
    const session = new BrowserSession({ agentHostDir: home });
    const ctx = context(home, session);
    try {
      const opened = await runTool(tool("browser.open"), { url: pathToFileURL(page).toString(), headless: true }, ctx);
      expect(opened.ok).toBe(true);
      const snap = await runTool(tool("browser.snapshot"), {}, ctx);
      const elements = (snap.data as { elements: Array<{ ref: string; name: string }> }).elements;
      const ref = (name: string) => elements.find((element) => element.name === name)!.ref;
      expect((await runTool(tool("browser.type"), { ref: ref("Search"), text: "shoes" }, ctx)).ok).toBe(true);
      const added = await runTool(tool("browser.click"), { ref: ref("Add to list") }, ctx);
      expect(added.ok).toBe(true);
      expect((added.data as { title: string }).title).toBe("added");

      const fresh = await runTool(tool("browser.snapshot"), {}, ctx);
      const orderRef = (fresh.data as { elements: Array<{ ref: string; name: string }> }).elements.find((element) => element.name === "Place order")!.ref;
      const refused = await runTool(tool("browser.click"), { ref: orderRef }, ctx);
      expect(refused.ok).toBe(false);
      const preview = await runTool(tool("browser.click"), { ref: orderRef, dryRun: true }, ctx);
      await acceptConfirmation(home, preview.confirmation!.tokenId!);
      const ordered = await runTool(tool("browser.click"), { ref: orderRef, confirmationToken: preview.confirmation!.tokenId }, ctx);
      expect(ordered.ok).toBe(true);
      expect((ordered.data as { title: string }).title).toBe("ordered");
    } finally {
      await session.close();
    }
  }, 90_000);

  it("uploads only after an exact confirmation, and only regular files", async () => {
    const home = await tempHome();
    const file = path.join(home, "cv.pdf");
    await writeFile(file, "pdf");
    const fake = fakeBrowser({ elements: { "s1-e5": element({ name: "Attach CV", role: "button", tag: "input", type: "file" }) } });
    const ctx = context(home, fake.browser);
    const refused = await runTool(tool("browser.upload"), { ref: "s1-e5", files: [file] }, ctx);
    expect(refused.ok).toBe(false);
    expect(fake.calls).toEqual([]);
    const preview = await runTool(tool("browser.upload"), { ref: "s1-e5", files: [file], dryRun: true }, ctx);
    expect(preview.ok).toBe(true);
    const tokenId = preview.confirmation?.tokenId;
    expect(tokenId).toMatch(/^conf_/);
    await acceptConfirmation(home, tokenId!);
    expect((await runTool(tool("browser.upload"), { ref: "s1-e5", files: [file], confirmationToken: tokenId }, ctx)).ok).toBe(true);
    expect(fake.calls).toEqual(["upload:s1-e5:1"]);
    const directory = await runTool(tool("browser.upload"), { ref: "s1-e5", files: [home], dryRun: true }, ctx);
    expect(directory.ok).toBe(false);
    expect(JSON.stringify(directory)).toContain("upload_not_a_file");
  });

  it("fill refuses sensitive fields before typing anything, then confirms what it typed", async () => {
    const home = await tempHome();
    const fake = fakeBrowser({ elements: {
      "s1-e1": element({ name: "Name", role: "textbox", tag: "input", type: "text" }),
      "s1-e2": element({ name: "Password", role: "textbox", tag: "input", type: "password", sensitiveField: true })
    } });
    const ctx = context(home, fake.browser);
    const refused = await runTool(tool("browser.fill"), { fields: [{ ref: "s1-e1", text: "Ada" }, { ref: "s1-e2", text: "hunter2" }] }, ctx);
    expect(refused.error?.code).toBe("sensitive_field");
    expect(fake.calls).toEqual([]);
    const ok = await runTool(tool("browser.fill"), { fields: [{ ref: "s1-e1", text: "Ada" }] }, ctx);
    expect(ok.ok).toBe(true);
    expect(fake.calls).toEqual(["type:s1-e1:3"]);
    expect((ok.data as { fields: Array<{ confirmed: boolean }> }).fields[0]?.confirmed).toBe(true);
  });

  it("reports a wait that never matches, selects options, and returns page images inline", async () => {
    const home = await tempHome();
    const fake = fakeBrowser({ elements: { "s1-e9": element({ name: "Country", role: "combobox", tag: "select" }) } });
    const ctx = context(home, fake.browser);
    fake.browser.waitFor = async () => ({ matched: false, elapsedMs: 300, url: "https://shop.example.com/", title: "t" });
    expect((await runTool(tool("browser.wait_for"), { text: "Order placed", timeoutMs: 300 }, ctx)).error?.code).toBe("wait_timeout");
    expect((await runTool(tool("browser.select"), { ref: "s1-e9", label: "Morocco" }, ctx)).ok).toBe(true);
    expect(fake.calls).toContain("select:s1-e9");
    const shot = await runTool(tool("browser.screenshot"), {}, ctx);
    expect(shot.ok).toBe(true);
    expect((shot.data as { inlineImage: { mimeType: string } }).inlineImage.mimeType).toBe("image/jpeg");
  });
});
