import type { CapabilityList, DependencyCheckResult, DependencyKind, SystemInfo, ToolResult } from "@osseo/core";
import { toolSuccess } from "@osseo/core";
import { z } from "zod";
import type { OsseoToolDefinition, AnyOsseoToolDefinition } from "../tool-runner.js";
import type { OsseoMcpContext } from "../context.js";

const emptyInputSchema = z.object({}).strict();

const emptyMcpInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
};

type EmptyInput = z.infer<typeof emptyInputSchema>;

const checkDependencyInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["command", "desktop_app", "any"]).optional()
  })
  .strict();

type CheckDependencyInput = z.infer<typeof checkDependencyInputSchema>;

export function createSystemTools(): AnyOsseoToolDefinition<OsseoMcpContext>[] {
  const getInfo: OsseoToolDefinition<EmptyInput, SystemInfo, OsseoMcpContext> = {
    name: "system.get_info",
    description: "Returns local system information and Osseo runtime details.",
    riskLevel: "observe",
    inputSchema: emptyInputSchema,
    mcpInputSchema: emptyMcpInputSchema,
    inputSummary: "Get system info",
    safety: {
      actionType: "observe"
    },
    async handler(_input, context): Promise<ToolResult<SystemInfo>> {
      return toolSuccess({
        tool: "system.get_info",
        riskLevel: "observe",
        data: {
          ...(await context.linux.getSystemInfo()),
          ...(context.runtime === undefined ? {} : {
            serverVersion: context.runtime.version,
            serverPath: context.runtime.entryPath,
            serverStartedAt: context.runtime.startedAt
          })
        },
        observations: ["Returned local runtime information."]
      });
    }
  };

  const listCapabilities: OsseoToolDefinition<EmptyInput, CapabilityList, OsseoMcpContext> = {
    name: "system.list_capabilities",
    description: "Lists Osseo strategies, tools, and registered app capabilities.",
    riskLevel: "observe",
    inputSchema: emptyInputSchema,
    mcpInputSchema: emptyMcpInputSchema,
    inputSummary: "List Osseo capabilities",
    safety: {
      actionType: "observe"
    },
    async handler(_input, context): Promise<ToolResult<CapabilityList>> {
      return toolSuccess({
        tool: "system.list_capabilities",
        riskLevel: "observe",
        data: {
          strategies: context.registry.listStrategies(),
          tools: context.registry.listTools(),
          appCapabilities: context.registry.listAppCapabilities()
        },
        observations: ["Returned registered Osseo capabilities."]
      });
    }
  };

  const checkDependency: OsseoToolDefinition<CheckDependencyInput, DependencyCheckResult, OsseoMcpContext> = {
    name: "system.check_dependency",
    description: "Checks whether a command or desktop app appears to be available.",
    riskLevel: "low",
    inputSchema: checkDependencyInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 200
        },
        kind: {
          type: "string",
          enum: ["command", "desktop_app", "any"]
        }
      },
      required: ["name"],
      additionalProperties: false
    },
    inputSummary: "Check dependency",
    safety: {
      actionType: "inspect"
    },
    async handler(input, context): Promise<ToolResult<DependencyCheckResult>> {
      const dependencyInput: { name: string; kind?: DependencyKind } = {
        name: input.name
      };

      if (input.kind !== undefined) {
        dependencyInput.kind = input.kind;
      }

      return toolSuccess({
        tool: "system.check_dependency",
        riskLevel: "low",
        data: await context.linux.checkDependency(dependencyInput),
        observations: ["Checked dependency availability without executing it."]
      });
    }
  };

  return [getInfo, listCapabilities, checkDependency];
}
