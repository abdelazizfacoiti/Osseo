import { HANDOFF_KINDS, beginHandoff, beginTakeover, clearActiveTaskApproval, readActiveTaskApproval, readHandoff, readRunState, requestStop, toolSuccess, type HandoffState, type RunStateSnapshot, type ToolResult, type ActiveTaskApproval } from "@osseo/core";
import { z } from "zod";
import type { OsseoMcpContext } from "../context.js";
import type { OsseoToolDefinition, AnyOsseoToolDefinition } from "../tool-runner.js";

const emptyInput = z.object({}).strict();
const reasonInput = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false });

export interface AgentStatusResult {
  runState: RunStateSnapshot;
  handoff: HandoffState;
  activeTaskApproval: ActiveTaskApproval | null;
  serverVersion?: string;
  serverPath?: string;
  startedAt?: string;
}

export function createAgentTools(): AnyOsseoToolDefinition<OsseoMcpContext>[] {
  const status: OsseoToolDefinition<z.infer<typeof emptyInput>, AgentStatusResult, OsseoMcpContext> = {
    name: "agent.status",
    description: "Reports stop, takeover, pause, and handoff state, the active task approval, and MCP server provenance.",
    riskLevel: "observe",
    inputSchema: emptyInput,
    mcpInputSchema: schema({}),
    inputSummary: "Agent status",
    safety: { actionType: "observe" },
    async handler(_input, context): Promise<ToolResult<AgentStatusResult>> {
      const [runState, approval, handoff] = await Promise.all([
        readRunState(context.config.osseoDir),
        readActiveTaskApproval(context.config.osseoDir),
        readHandoff(context.config.osseoDir)
      ]);
      return toolSuccess({
        tool: "agent.status",
        riskLevel: "observe",
        data: {
          runState,
          handoff,
          activeTaskApproval: approval ?? null,
          ...(context.runtime === undefined ? {} : {
            serverVersion: context.runtime.version,
            serverPath: context.runtime.entryPath,
            startedAt: context.runtime.startedAt
          })
        }
      });
    }
  };

  const stop: OsseoToolDefinition<z.infer<typeof reasonInput>, { runState: RunStateSnapshot }, OsseoMcpContext> = {
    name: "agent.stop",
    description: "Requests an emergency stop. All state-changing tools are then refused until an operator runs the CLI resume command.",
    riskLevel: "medium",
    inputSchema: reasonInput,
    mcpInputSchema: schema({ reason: { type: "string", maxLength: 500 } }),
    inputSummary: "Emergency stop",
    safety: { actionType: "inspect" },
    async handler(input, context): Promise<ToolResult<{ runState: RunStateSnapshot }>> {
      const reason = input.reason ?? "agent_requested_stop";
      await requestStop(context.config.osseoDir, reason);
      await clearActiveTaskApproval(context.config.osseoDir);
      return toolSuccess({
        tool: "agent.stop",
        riskLevel: "medium",
        data: { runState: await readRunState(context.config.osseoDir) },
        observations: ["Stop requested. State-changing tools are halted until an operator runs: osseo agent resume --stop"]
      });
    }
  };

  const takeover: OsseoToolDefinition<z.infer<typeof reasonInput>, { runState: RunStateSnapshot }, OsseoMcpContext> = {
    name: "agent.takeover_begin",
    description: "Marks human takeover. State-changing tools are refused until an operator clears takeover from the CLI.",
    riskLevel: "medium",
    inputSchema: reasonInput,
    mcpInputSchema: schema({ reason: { type: "string", maxLength: 500 } }),
    inputSummary: "Begin human takeover",
    safety: { actionType: "inspect" },
    async handler(input, context): Promise<ToolResult<{ runState: RunStateSnapshot }>> {
      await beginTakeover(context.config.osseoDir, input.reason ?? "agent_requested_takeover");
      await clearActiveTaskApproval(context.config.osseoDir);
      return toolSuccess({
        tool: "agent.takeover_begin",
        riskLevel: "medium",
        data: { runState: await readRunState(context.config.osseoDir) },
        observations: ["Human takeover active. State-changing tools are halted until an operator runs: osseo agent resume --takeover"]
      });
    }
  };

  const handoffInput = z.object({
    kind: z.enum(HANDOFF_KINDS),
    message: z.string().trim().min(1).max(300)
  }).strict();
  const handoff: OsseoToolDefinition<z.infer<typeof handoffInput>, { runState: RunStateSnapshot }, OsseoMcpContext> = {
    name: "agent.request_handoff",
    description: "Ask the human to do a step the agent must not do itself: log in, enter an MFA code, solve a CAPTCHA, or approve a payment. A card tells the human what to do; state-changing and screen-reading tools are refused until they press Continue. Never type credentials yourself.",
    riskLevel: "medium",
    inputSchema: handoffInput,
    mcpInputSchema: schema({ kind: { type: "string", enum: [...HANDOFF_KINDS] }, message: { type: "string", maxLength: 300, description: "What the human should do, in one short sentence. No secrets." } }, ["kind", "message"]),
    inputSummary: "Hand a step to the human",
    safety: { actionType: "inspect" },
    async handler(input, context): Promise<ToolResult<{ runState: RunStateSnapshot }>> {
      await beginHandoff(context.config.osseoDir, input);
      await clearActiveTaskApproval(context.config.osseoDir);
      return toolSuccess({
        tool: "agent.request_handoff",
        riskLevel: "medium",
        data: { runState: await readRunState(context.config.osseoDir) },
        observations: ["Handoff requested. Do not call state-changing or screen-reading tools: they are refused until the human presses Continue (or runs: osseo agent resume --takeover). Poll agent.status, then take a fresh screenshot."]
      });
    }
  };

  return [status, stop, takeover, handoff];
}
