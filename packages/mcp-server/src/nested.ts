import { toolFailure, type ToolResult } from "@agenthost/core";
import type { AgentHostMcpContext } from "./context.js";
import type { AnyAgentHostToolDefinition } from "./tool-runner.js";
import { runTool } from "./tool-runner.js";

/**
 * Calls another registered tool through the full runner (schema, stop/takeover gates, preview,
 * confirmation, audit), the same way computer.run_steps runs its steps. While a plan is only being
 * previewed, the nested call is preview-only too, so it never mints a token.
 */
export async function callGoverned(context: AgentHostMcpContext, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  const target = context.tools?.get(name);
  if (target === undefined) {
    return toolFailure({ tool: name, riskLevel: "medium", error: { code: "unknown_tool", message: `Unknown tool: ${name}` }, observations: ["No action was executed."] });
  }
  return runTool(target as AnyAgentHostToolDefinition<AgentHostMcpContext>, input, context, context.previewOnly === true ? { previewOnly: true } : {});
}
