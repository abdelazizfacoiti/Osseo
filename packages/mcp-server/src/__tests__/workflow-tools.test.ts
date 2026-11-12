import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultPolicy, type AuditLogEntry } from "@agenthost/core";
import type { AgentHostMcpContext } from "../context.js";
import { applyProductionExecutionMetadata } from "../tool-metadata.js";
import { runTool } from "../tool-runner.js";
import { createWorkflowTools } from "../tools/workflow.js";

const directories: string[] = [];
async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenthost-workflow-tools-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const tools = new Map(applyProductionExecutionMetadata(createWorkflowTools() as never).map((tool) => [tool.name, tool]));
const tool = (name: string) => tools.get(name)!;
function context(home: string): AgentHostMcpContext {
  return {
    sessionId: "workflow-test",
    config: { agentHostDir: home, configPath: path.join(home, "config.json"), logFile: path.join(home, "logs", "audit.jsonl") },
    policy: getDefaultPolicy(),
    logger: { log: async (_entry: AuditLogEntry) => undefined },
    tools: new Map([["app.open_url", {}], ["desktop.type_text", {}]]) as never,
    linux: {}
  } as unknown as AgentHostMcpContext;
}

describe("workflow tools", () => {
  it("saves, lists, and returns expanded steps without executing anything", async () => {
    const home = await tempHome();
    const ctx = context(home);
    const saved = await runTool(tool("workflow.save"), { name: "open-report", description: "Open a report", parameters: [{ name: "week" }], steps: [{ tool: "app.open_url", input: { url: "https://example.com/{{week}}" } }] }, ctx);
    expect(saved.ok).toBe(true);
    const listed = await runTool(tool("workflow.list"), {}, ctx);
    expect((listed.data as { workflows: Array<{ name: string }> }).workflows.map((workflow) => workflow.name)).toEqual(["open-report"]);
    const fetched = await runTool(tool("workflow.get"), { name: "open-report", parameters: { week: "45" } }, ctx);
    expect(fetched.ok).toBe(true);
    expect((fetched.data as { steps: Array<{ input: { url: string } }>; runWith: string }).steps[0]!.input.url).toBe("https://example.com/45");
    expect((fetched.data as { runWith: string }).runWith).toBe("computer.run_steps");
    expect((await runTool(tool("workflow.get"), { name: "open-report" }, ctx)).error?.code).toBe("workflow_parameters");
    expect((await runTool(tool("workflow.get"), { name: "nope-nope" }, ctx)).error?.code).toBe("workflow_not_found");
  });

  it("refuses unknown tools, banned tools, and secrets, and deletes", async () => {
    const home = await tempHome();
    const ctx = context(home);
    const save = (steps: unknown[]) => runTool(tool("workflow.save"), { name: "bad-one", description: "x", steps }, ctx);
    expect((await save([{ tool: "made.up_tool" }])).error?.code).toBe("workflow_invalid");
    expect((await save([{ tool: "agent.stop" }])).error?.code).toBe("workflow_invalid");
    expect((await save([{ tool: "desktop.type_text", input: { text: "password=hunter2hunter2hunter2" } }])).ok).toBe(false);
    await runTool(tool("workflow.save"), { name: "keep-me", description: "x", steps: [{ tool: "app.open_url", input: { url: "https://example.com" } }] }, ctx);
    expect((await runTool(tool("workflow.delete"), { name: "keep-me" }, ctx)).ok).toBe(true);
    expect((await runTool(tool("workflow.delete"), { name: "keep-me" }, ctx)).error?.code).toBe("workflow_not_found");
  });
});
