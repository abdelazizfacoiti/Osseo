import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { getDefaultPolicy, invalidatePolicyCache, prepareConfirmation, readConfirmation, toolSuccess, type AuditLogEntry, type RiskLevel, type ToolExecutionMetadata } from "@agenthost/core";
import type { AgentHostMcpContext } from "../context.js";
import { askInChat, askInChatDetailed, type ElicitFn } from "../chat-approval.js";
import { runTool, type AgentHostToolDefinition, type ToolPreviewEffect } from "../tool-runner.js";

const SESSION = "always-allow-test";
const dirs: string[] = [];
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-always-"));
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

function makeContext(home: string, logs: AuditLogEntry[]): AgentHostMcpContext {
  return {
    sessionId: SESSION,
    config: { agentHostDir: home, configPath: path.join(home, "config.json"), logFile: path.join(home, "logs", "audit.jsonl") },
    policy: getDefaultPolicy(),
    grants: { listActiveGrants: () => [] },
    logger: { log: async (entry: AuditLogEntry) => { logs.push(entry); } },
    linux: {}
  } as unknown as AgentHostMcpContext;
}

function fake(name: string, actionType: string, effect: ToolPreviewEffect) {
  const ran = { count: 0 };
  const tool = {
    name,
    description: "fake",
    riskLevel: "medium" as RiskLevel,
    inputSchema: z.object({ dryRun: z.boolean().optional(), confirmationToken: z.string().optional() }).strict(),
    mcpInputSchema: {},
    inputSummary: "fake",
    safety: { actionType },
    preview: { isDryRun: (i: { dryRun?: boolean }) => i.dryRun === true, resolveEffect: () => effect },
    execution: stateChanging,
    handler: async () => { ran.count += 1; return toolSuccess({ tool: name, riskLevel: "medium", data: {} }); }
  } as unknown as AgentHostMcpLike;
  return { tool, ran };
}
type AgentHostMcpLike = AgentHostToolDefinition<{ confirmationToken?: string; dryRun?: boolean }, unknown>;

const slackSend = (app: string | undefined): ToolPreviewEffect => ({
  summary: "Send a message",
  riskLevel: "high",
  requiresConfirmation: true,
  ...(app === undefined ? {} : { data: { activeWindow: { appName: app } } })
});
const accept = (alwaysAllow?: boolean): ElicitFn => async () => ({ action: "accept", content: { approve: true, ...(alwaysAllow === undefined ? {} : { alwaysAllow }) } });
const policyFile = (home: string) => path.join(home, "policy.toml");
const exists = async (file: string) => stat(file).then(() => true, () => false);
const countRules = (text: string) => text.split("\n").filter((line) => line.trim() === "[[rule]]").length;
const allowRules = (text: string) => text.split("\n").filter((line) => line.startsWith("note = \"added from an approval prompt\"")).length;

async function pendingSend(home: string, app: string | undefined = "Slack") {
  const logs: AuditLogEntry[] = [];
  const asked = fake("test.send", "communication_send", slackSend(app));
  const result = await runTool(asked.tool, {}, makeContext(home, logs));
  expect(result.error?.code).toBe("confirmation_required");
  const tokenId = result.confirmation!.tokenId!;
  return { tokenId, logs };
}

describe("Always allow here in chat", () => {
  it("stores the app and category on the confirmation", async () => {
    const home = await tempHome();
    const { tokenId } = await pendingSend(home);
    expect((await readConfirmation(home, tokenId))?.policyTarget).toEqual({ app: "Slack", category: "send" });
  });

  it("alwaysAllow writes exactly one rule and the next identical action needs no approval", async () => {
    const home = await tempHome();
    const { tokenId, logs } = await pendingSend(home);
    const outcome = await askInChatDetailed({ agentHostDir: home, sessionId: SESSION, tokenId, elicit: accept(true) });
    expect(outcome.outcome).toBe("approved");
    expect(outcome.policy?.written).toBe(true);
    expect((await readConfirmation(home, tokenId))?.status).toBe("accepted");

    const text = await readFile(policyFile(home), "utf8");
    expect(allowRules(text)).toBe(1);
    expect(text).toContain("app = \"Slack\"\naction = \"send\"\ndecision = \"allow\"\nnote = \"added from an approval prompt\"");
    expect(text.startsWith("# AgentHost policy.")).toBe(true); // comments of the default file kept

    const again = fake("test.send", "communication_send", slackSend("Slack"));
    const result = await runTool(again.tool, {}, makeContext(home, logs));
    expect(result.ok).toBe(true);
    expect(again.ran.count).toBe(1);
    expect(logs.at(-1)?.policySource).toMatch(/^policy_rule:/);

    // A different app still asks.
    const other = fake("test.send", "communication_send", slackSend("Thunderbird"));
    expect((await runTool(other.tool, {}, makeContext(home, logs))).error?.code).toBe("confirmation_required");
  });

  it("approves once and writes nothing when alwaysAllow is false or absent", async () => {
    for (const choice of [false, undefined]) {
      const home = await tempHome();
      const { tokenId } = await pendingSend(home);
      const outcome = await askInChatDetailed({ agentHostDir: home, sessionId: SESSION, tokenId, elicit: accept(choice) });
      expect(outcome).toEqual({ outcome: "approved" });
      expect((await readConfirmation(home, tokenId))?.status).toBe("accepted");
      expect(await exists(policyFile(home))).toBe(false);
    }
  });

  it("offers the choice in the form", async () => {
    const home = await tempHome();
    const { tokenId } = await pendingSend(home);
    let schema: { properties: Record<string, { title: string; description: string }>; required?: string[] } | undefined;
    await askInChat({ agentHostDir: home, sessionId: SESSION, tokenId, elicit: async (params) => { schema = params.requestedSchema as never; return { action: "cancel" }; } });
    expect(schema?.properties.alwaysAllow?.title).toBe("Always allow this kind of action in this app");
    expect(schema?.properties.alwaysAllow?.description).toContain("agenthost policy remove");
    expect(schema?.required).toEqual(["approve"]);
  });

  it("decline and cancel never write a rule", async () => {
    const home = await tempHome();
    const { tokenId } = await pendingSend(home);
    expect((await askInChatDetailed({ agentHostDir: home, sessionId: SESSION, tokenId, elicit: async () => ({ action: "decline", content: { alwaysAllow: true } }) })).outcome).toBe("denied");
    expect(await exists(policyFile(home))).toBe(false);
    const second = await pendingSend(home);
    expect((await askInChatDetailed({ agentHostDir: home, sessionId: SESSION, tokenId: second.tokenId, elicit: async () => ({ action: "accept", content: { approve: false, alwaysAllow: true } }) })).outcome).toBe("denied");
    expect(await exists(policyFile(home))).toBe(false);
  });

  const refused: Array<[string, { app?: string; site?: string; category: never } | undefined, RiskLevel]> = [
    ["category any", { app: "Slack", category: "any" as never }, "high"],
    ["category navigate", { app: "Slack", category: "navigate" as never }, "high"],
    ["category type", { app: "Slack", category: "type" as never }, "high"],
    ["category click", { app: "Slack", category: "click" as never }, "high"],
    ["unknown app and no site", { category: "send" as never }, "high"],
    ["a blocked record", { app: "Slack", category: "send" as never }, "blocked"],
    ["an old record without policyTarget", undefined, "high"]
  ];
  it.each(refused)("%s approves once and writes nothing", async (_name, policyTarget, riskLevel) => {
    const home = await tempHome();
    const record = await prepareConfirmation({ agentHostDir: home, tool: "test.send", riskLevel, args: {}, summary: "Send", sessionId: SESSION, ...(policyTarget === undefined ? {} : { policyTarget }) });
    const outcome = await askInChatDetailed({ agentHostDir: home, sessionId: SESSION, tokenId: record.tokenId, elicit: accept(true) });
    expect(outcome.outcome).toBe("approved");
    expect(outcome.policy?.written).toBe(false);
    expect(outcome.policy !== undefined && !outcome.policy.written && outcome.policy.message.length).toBeGreaterThan(10);
    expect((await readConfirmation(home, record.tokenId))?.status).toBe("accepted");
    expect(await exists(policyFile(home))).toBe(false);
  });

  it("a site is enough when the app is unknown (browser tools)", async () => {
    const home = await tempHome();
    const record = await prepareConfirmation({ agentHostDir: home, tool: "browser.click", riskLevel: "high", args: {}, summary: "Place order", sessionId: SESSION, policyTarget: { site: "shop.example.com", category: "pay" } });
    const outcome = await askInChatDetailed({ agentHostDir: home, sessionId: SESSION, tokenId: record.tokenId, elicit: accept(true) });
    expect(outcome.policy?.written).toBe(true);
    expect(await readFile(policyFile(home), "utf8")).toContain("site = \"shop.example.com\"\naction = \"pay\"\ndecision = \"allow\"");
  });

  it("a duplicate writes nothing and says so", async () => {
    const home = await tempHome();
    const first = await pendingSend(home);
    await askInChat({ agentHostDir: home, sessionId: SESSION, tokenId: first.tokenId, elicit: accept(true) });
    const before = await readFile(policyFile(home), "utf8");
    const rules = countRules(before);
    // The same approval again, as if a second prompt was shown before the rule existed.
    const record = await prepareConfirmation({ agentHostDir: home, tool: "test.send", riskLevel: "high", args: { n: 2 }, summary: "Send", sessionId: SESSION, policyTarget: { app: "Slack", category: "send" } });
    const outcome = await askInChatDetailed({ agentHostDir: home, sessionId: SESSION, tokenId: record.tokenId, elicit: accept(true) });
    expect(outcome.policy).toMatchObject({ written: false, reason: "already_allowed" });
    const after = await readFile(policyFile(home), "utf8");
    expect(after).toBe(before);
    expect(countRules(after)).toBe(rules);
    expect((await readdir(home)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
