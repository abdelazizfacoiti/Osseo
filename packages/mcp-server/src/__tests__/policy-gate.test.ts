import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDefaultPolicy, invalidatePolicyCache, toolSuccess, type AuditLogEntry, type RiskLevel, type ToolExecutionMetadata } from "@agenthost/core";
import type { BrowserAutomation, BrowserElementInfo } from "@agenthost/os-linux";
import type { AgentHostMcpContext } from "../context.js";
import { runTool, type AgentHostToolDefinition, type ToolPreviewEffect } from "../tool-runner.js";
import { applyProductionExecutionMetadata } from "../tool-metadata.js";
import { createBrowserTools } from "../tools/browser.js";
import { createFileTools } from "../tools/file.js";

const dirs: string[] = [];
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-policy-gate-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  invalidatePolicyCache();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const stateChanging: ToolExecutionMetadata = {
  executionClass: "state_changing",
  externalEffect: false,
  requiresDryRun: false,
  requiresConfirmationToken: false,
  requiresExactTarget: false,
  source: "base",
  availability: "available"
};

function makeContext(home: string, logs: AuditLogEntry[], browser?: BrowserAutomation): AgentHostMcpContext {
  return {
    sessionId: "policy-test",
    config: { agentHostDir: home, configPath: path.join(home, "config.json"), logFile: path.join(home, "logs", "audit.jsonl") },
    policy: getDefaultPolicy(),
    grants: { listActiveGrants: () => [] },
    logger: { log: async (entry: AuditLogEntry) => { logs.push(entry); } },
    linux: browser === undefined ? {} : { browser }
  } as unknown as AgentHostMcpContext;
}

async function setPolicy(home: string, text: string): Promise<void> {
  const file = path.join(home, "policy.toml");
  await writeFile(file, text);
  const later = new Date(Date.now() + 1000 * (1 + Math.floor(Math.random() * 1e6)));
  await utimes(file, later, later);
}

interface Fake {
  tool: AgentHostToolDefinition<{ confirmationToken?: string; dryRun?: boolean }, unknown>;
  ran: { count: number; confirmed: boolean[] };
}
function fake(name: string, actionType: string, effect: ToolPreviewEffect, getInput?: () => Record<string, unknown>): Fake {
  const ran = { count: 0, confirmed: [] as boolean[] };
  const tool = {
    name,
    description: "fake",
    riskLevel: "medium" as RiskLevel,
    inputSchema: z.object({ dryRun: z.boolean().optional(), confirmationToken: z.string().optional() }).strict(),
    mcpInputSchema: {},
    inputSummary: "fake",
    safety: { actionType, ...(getInput === undefined ? {} : { getInput }) },
    preview: { isDryRun: (i: { dryRun?: boolean }) => i.dryRun === true, resolveEffect: () => effect },
    execution: stateChanging,
    handler: async (_input: unknown, ctx: AgentHostMcpContext) => {
      ran.count += 1;
      ran.confirmed.push(ctx.confirmationSatisfied === true);
      return toolSuccess({ tool: name, riskLevel: "medium", data: {} });
    }
  } as unknown as Fake["tool"];
  return { tool, ran };
}

const SEND_EFFECT: ToolPreviewEffect = { summary: "Send a message", riskLevel: "high", requiresConfirmation: true };
const rule = (action: string, decision: string, extra = "") => `[[rule]]\n${extra}action = "${action}"\ndecision = "${decision}"\n`;

describe("policy.toml in the tool runner", () => {
  it("uses the classifier alone when there is no policy file", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    const asked = fake("test.send", "communication_send", SEND_EFFECT);
    const result = await runTool(asked.tool, {}, makeContext(home, logs));
    expect(result.error?.code).toBe("confirmation_required");
    expect(asked.ran.count).toBe(0);
    expect(logs.at(-1)?.policySource).toBe("classifier");
    const free = fake("test.free", "communication_send", { summary: "Send", riskLevel: "medium" });
    expect((await runTool(free.tool, {}, makeContext(home, logs))).ok).toBe(true);
    expect(logs.at(-1)?.policySource).toBe("classifier");
  });

  it("ask forces approval for a send the classifier would let through", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, `# c\n\n${rule("send", "ask", 'note = "always check"\n')}`);
    const free = fake("test.free", "communication_send", { summary: "Send", riskLevel: "medium" });
    const result = await runTool(free.tool, {}, makeContext(home, logs));
    expect(result.error?.code).toBe("confirmation_required");
    expect(free.ran.count).toBe(0);
    expect(logs.at(-1)).toMatchObject({ policySource: "policy_rule:3", policyNote: "always check" });
  });

  it("allow removes approval only for the action it names", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, rule("send", "allow"));
    const send = fake("test.send", "communication_send", SEND_EFFECT);
    expect((await runTool(send.tool, {}, makeContext(home, logs))).ok).toBe(true);
    expect(send.ran.confirmed).toEqual([true]);
    expect(logs.at(-1)?.policySource).toBe("policy_rule:1");
    const remove = fake("test.delete", "file_delete", { summary: "Delete", riskLevel: "high", requiresConfirmation: true });
    expect((await runTool(remove.tool, {}, makeContext(home, logs))).error?.code).toBe("confirmation_required");
    await setPolicy(home, rule("any", "allow"));
    const again = fake("test.send", "communication_send", SEND_EFFECT);
    expect((await runTool(again.tool, {}, makeContext(home, logs))).error?.code).toBe("confirmation_required");
    await setPolicy(home, rule("navigate", "allow"));
    const third = fake("test.send", "communication_send", SEND_EFFECT);
    expect((await runTool(third.tool, {}, makeContext(home, logs))).error?.code).toBe("confirmation_required");
  });

  it("never refuses before the handler and records the rule", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, rule("send", "never", 'note = "no mail"\n'));
    const send = fake("test.send", "communication_send", { summary: "Send", riskLevel: "medium" });
    const result = await runTool(send.tool, {}, makeContext(home, logs));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("policy_never");
    expect(send.ran.count).toBe(0);
    expect(logs.at(-1)).toMatchObject({ policySource: "policy_rule:1", policyNote: "no mail" });
  });

  it("a blocked action stays blocked under an allow rule", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, `${rule("any", "allow")}\n${rule("send", "allow")}`);
    const blocked = fake("test.send", "communication_send", { summary: "Send", riskLevel: "blocked", blocked: true, reasons: ["no"] });
    const result = await runTool(blocked.tool, {}, makeContext(home, logs));
    expect(result.error?.code).toBe("safety_blocked");
    expect(blocked.ran.count).toBe(0);
    expect(logs.at(-1)?.policySource).toBe("floor");
  });

  it("password managers are refused whatever the rules say", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, rule("any", "allow", 'app = "*"\n'));
    const click = fake("desktop.click", "gui_click", { summary: "Click", riskLevel: "medium", data: { activeWindow: { appName: "Bitwarden" } } });
    const result = await runTool(click.tool, {}, makeContext(home, logs));
    expect(result.ok).toBe(false);
    expect(click.ran.count).toBe(0);
    expect(logs.at(-1)?.policySource).toBe("floor");
  });

  it("a password field stays refused under an allow rule for type", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, rule("type", "allow", 'site = "shop.example.com"\n'));
    const fakeBrowser = browserWith({ url: "https://shop.example.com/cart", elements: { "s1-e0": element({ sensitiveField: true }) } });
    const type = browserTool("browser.type");
    const result = await runTool(type, { ref: "s1-e0", text: "hunter2" }, makeContext(home, logs, fakeBrowser.browser));
    expect(result.ok).toBe(false);
    expect(fakeBrowser.calls).toEqual([]);
    expect(logs.at(-1)?.policySource).toBe("floor");
  });

  it("a real browser send is covered by an exact allow rule on that site only", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, rule("pay", "allow", 'site = "shop.example.com"\n'));
    const elements = { "s1-e0": element({ name: "Place order" }) };
    const shop = browserWith({ url: "https://shop.example.com/cart", elements });
    expect((await runTool(browserTool("browser.click"), { ref: "s1-e0" }, makeContext(home, logs, shop.browser))).ok).toBe(true);
    expect(shop.calls).toEqual(["click:s1-e0"]);
    expect(logs.at(-1)?.policySource).toBe("policy_rule:1");
    const other = browserWith({ url: "https://other.example.org/cart", elements });
    const result = await runTool(browserTool("browser.click"), { ref: "s1-e0" }, makeContext(home, logs, other.browser));
    expect(result.error?.code).toBe("confirmation_required");
    expect(other.calls).toEqual([]);
  });

  it("re-reads the file when it changes", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    const run = async () => runTool(fake("test.send", "communication_send", SEND_EFFECT).tool, {}, makeContext(home, logs));
    expect((await run()).error?.code).toBe("confirmation_required");
    await setPolicy(home, rule("send", "allow"));
    expect((await run()).ok).toBe(true);
    await setPolicy(home, rule("send", "never"));
    expect((await run()).error?.code).toBe("policy_never");
  });

  it("Shopify: navigation runs, a password field is refused, a send asks", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, `${rule("navigate", "allow", 'site = "admin.shopify.com"\n')}\n${rule("send", "ask")}`);
    const url = () => ({ url: "https://admin.shopify.com/store/demo", appName: "Chrome" });
    const nav = fake("browser.navigate", "browser_action", { summary: "Go", riskLevel: "medium" }, url);
    const secret = fake("browser.type", "browser_action", { summary: "Type into a sensitive field.", riskLevel: "blocked", blocked: true }, url);
    const send = fake("browser.click", "browser_action", { summary: 'Click "Send" (button)', riskLevel: "high", requiresConfirmation: true }, url);
    const context = makeContext(home, logs);
    expect((await runTool(nav.tool, {}, context)).ok).toBe(true);
    expect(logs.at(-1)?.policySource).toBe("policy_rule:1");
    expect((await runTool(secret.tool, {}, context)).ok).toBe(false);
    expect(secret.ran.count).toBe(0);
    expect(logs.at(-1)?.policySource).toBe("floor");
    expect((await runTool(send.tool, {}, context)).error?.code).toBe("confirmation_required");
    expect(send.ran.count).toBe(0);
    expect(logs.at(-1)?.policySource).toBe("policy_rule:6");
  });

  it("the real classifier still blocks admin.shopify.com, and no allow rule changes that", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    await setPolicy(home, rule("navigate", "allow", 'site = "admin.shopify.com"\n'));
    const shop = browserWith({ url: "https://admin.shopify.com/store/demo", elements: {} });
    const result = await runTool(browserTool("browser.navigate"), { action: "goto", url: "https://admin.shopify.com/store/demo" }, makeContext(home, logs, shop.browser));
    expect(result.error?.code).toBe("safety_blocked");
    expect(logs.at(-1)?.policySource).toBe("floor");
  });

  it("the agent cannot write, delete, move or copy policy.toml", async () => {
    const home = await tempHome();
    const logs: AuditLogEntry[] = [];
    const policy = path.join(home, "policy.toml");
    await writeFile(policy, rule("send", "ask"));
    const before = await readFile(policy, "utf8");
    const mtime = (await stat(policy)).mtimeMs;
    const files = new Map(applyProductionExecutionMetadata(createFileTools() as never).map((tool) => [tool.name, tool]));
    const context = makeContext(home, logs);
    const scratch = path.join(home, "scratch.txt");
    await writeFile(scratch, "x");
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["file.write", { path: policy, content: "[[rule]]\naction = \"any\"\ndecision = \"allow\"\n" }],
      ["file.delete", { path: policy }],
      ["file.move", { source: policy, destination: path.join(home, "moved.toml") }],
      ["file.move", { source: scratch, destination: policy }],
      ["file.copy", { source: scratch, destination: policy }]
    ];
    for (const [name, input] of attempts) {
      const result = await runTool(files.get(name)!, input, context);
      expect(result.ok, name).toBe(false);
      expect(result.error?.code, name).toBe("safety_blocked");
      expect(JSON.stringify(result), name).toMatch(/agenthost_control|control/i);
    }
    expect(await readFile(policy, "utf8")).toBe(before);
    expect((await stat(policy)).mtimeMs).toBe(mtime);
  });
});

function element(overrides: Partial<BrowserElementInfo>): BrowserElementInfo {
  return { name: "Add one", role: "button", tag: "button", isSubmit: false, formHasPassword: false, formHasPayment: false, sensitiveField: false, ...overrides };
}

function browserWith(options: { url: string; elements: Record<string, BrowserElementInfo> }): { browser: BrowserAutomation; calls: string[] } {
  const calls: string[] = [];
  const { url } = options;
  const browser = {
    state: async () => ({ url, title: "t" }),
    describe: async ({ ref }: { ref: string }) => options.elements[ref],
    click: async ({ ref }: { ref: string }) => { calls.push(`click:${ref}`); return { ok: true, url, title: "t" }; },
    type: async ({ ref, text }: { ref: string; text: string }) => { calls.push(`type:${ref}:${text.length}`); return { ok: true, url, title: "t" }; },
    navigate: async () => { calls.push("navigate"); return { ok: true, url, title: "t" }; }
  } as unknown as BrowserAutomation;
  return { browser, calls };
}

const browserTools = new Map(applyProductionExecutionMetadata(createBrowserTools() as never).map((tool) => [tool.name, tool]));
function browserTool(name: string) {
  return browserTools.get(name)!;
}
