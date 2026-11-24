import {
  MAX_WORKFLOW_STEPS,
  WorkflowError,
  deleteWorkflow,
  expandWorkflow,
  listWorkflows,
  loadWorkflow,
  noteWorkflowUsed,
  saveWorkflow,
  toolFailure,
  toolSuccess,
  type SavedWorkflow,
  type ToolResult,
  type WorkflowStep
} from "@osseo/core";
import { z } from "zod";
import type { OsseoMcpContext } from "../context.js";
import type { OsseoToolDefinition, AnyOsseoToolDefinition } from "../tool-runner.js";

/*
 * Saved workflows are recalled plans, not a second way to execute. workflow.get
 * returns steps with parameters filled in; the agent hands them to
 * computer.run_steps, which applies approval, per-step safety, stop/takeover,
 * and audit exactly as for a freshly written plan. Put computer.wait_for steps
 * between actions to verify each one landed (use stopOnError).
 */

const name = z.string().trim().min(2).max(49);
const stepSchema = z.object({ tool: z.string().trim().min(3).max(100), input: z.record(z.string(), z.unknown()).optional() }).strict();
const parameterSchema = z.object({ name: z.string().trim().min(1).max(40), description: z.string().trim().max(200).optional() }).strict();

const saveInput = z.object({
  name,
  description: z.string().trim().min(1).max(300),
  parameters: z.array(parameterSchema).max(10).optional(),
  steps: z.array(stepSchema).min(1).max(MAX_WORKFLOW_STEPS)
}).strict();
const listInput = z.object({}).strict();
const getInput = z.object({ name, parameters: z.record(z.string(), z.string().max(2_000)).optional() }).strict();
const deleteInput = z.object({ name }).strict();

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false });

function summary(workflow: SavedWorkflow) {
  return { name: workflow.name, description: workflow.description, parameters: workflow.parameters, steps: workflow.steps.length, uses: workflow.uses, updatedAt: workflow.updatedAt };
}

function failure(tool: string, error: unknown): ToolResult<never> {
  if (error instanceof WorkflowError) {
    return toolFailure({ tool, riskLevel: "low", error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, observations: ["No workflow was changed."] });
  }
  return toolFailure({ tool, riskLevel: "low", error: { code: "workflow_store_failed", message: "The workflow store could not be used." }, observations: ["No workflow was changed."] });
}

export function createWorkflowTools(): AnyOsseoToolDefinition<OsseoMcpContext>[] {
  const save: OsseoToolDefinition<z.infer<typeof saveInput>, { workflow: ReturnType<typeof summary> }, OsseoMcpContext> = {
    name: "workflow.save",
    description: "Saves a plan that just worked as a named, reusable workflow. Use {{param}} placeholders in step inputs for anything that changes between runs and declare each in parameters. Secrets are rejected: pass them as parameters at run time. Only the plan is stored; running it later still goes through computer.run_steps and every safety gate.",
    riskLevel: "low",
    inputSchema: saveInput,
    mcpInputSchema: schema({
      name: { type: "string", minLength: 2, maxLength: 49, description: "a-z, 0-9, _ or -" },
      description: { type: "string", maxLength: 300 },
      parameters: { type: "array", maxItems: 10, items: schema({ name: { type: "string", maxLength: 40 }, description: { type: "string", maxLength: 200 } }, ["name"]) },
      steps: { type: "array", minItems: 1, maxItems: MAX_WORKFLOW_STEPS, items: schema({ tool: { type: "string" }, input: { type: "object", additionalProperties: true } }, ["tool"]) }
    }, ["name", "description", "steps"]),
    inputSummary: "Save workflow",
    auditInputSummary: (i) => `Save workflow ${i.name} (${i.steps.length} steps).`,
    safety: { actionType: "inspect" },
    async handler(input, context): Promise<ToolResult<{ workflow: ReturnType<typeof summary> }>> {
      try {
        const workflow = await saveWorkflow(context.config.osseoDir, {
          name: input.name,
          description: input.description,
          parameters: (input.parameters ?? []).map((parameter) => ({ name: parameter.name, ...(parameter.description === undefined ? {} : { description: parameter.description }) })),
          steps: input.steps as WorkflowStep[],
          ...(context.tools === undefined ? {} : { knownTools: new Set(context.tools.keys()) })
        });
        return toolSuccess({ tool: "workflow.save", riskLevel: "low", data: { workflow: summary(workflow) }, observations: [`Saved "${workflow.name}". Recall it with workflow.get, then run it with computer.run_steps.`] });
      } catch (error) {
        return failure("workflow.save", error);
      }
    }
  };

  const list: OsseoToolDefinition<z.infer<typeof listInput>, { workflows: Array<ReturnType<typeof summary>> }, OsseoMcpContext> = {
    name: "workflow.list",
    description: "Lists saved workflows with their parameters. Check this before planning a task from scratch.",
    riskLevel: "observe",
    inputSchema: listInput,
    mcpInputSchema: schema({}),
    inputSummary: "List workflows",
    safety: { actionType: "observe" },
    async handler(_input, context): Promise<ToolResult<{ workflows: Array<ReturnType<typeof summary>> }>> {
      return toolSuccess({ tool: "workflow.list", riskLevel: "observe", data: { workflows: (await listWorkflows(context.config.osseoDir)).map(summary) } });
    }
  };

  const get: OsseoToolDefinition<z.infer<typeof getInput>, { name: string; description: string; steps: WorkflowStep[]; runWith: string }, OsseoMcpContext> = {
    name: "workflow.get",
    description: "Returns a saved workflow's steps with parameters filled in. It does not run anything: pass the returned steps to computer.run_steps (with stopOnError) to execute them under the usual approval and safety gates.",
    riskLevel: "observe",
    inputSchema: getInput,
    mcpInputSchema: schema({ name: { type: "string", minLength: 2, maxLength: 49 }, parameters: { type: "object", additionalProperties: { type: "string", maxLength: 2000 } } }, ["name"]),
    inputSummary: "Get workflow",
    safety: { actionType: "observe" },
    async handler(input, context): Promise<ToolResult<{ name: string; description: string; steps: WorkflowStep[]; runWith: string }>> {
      try {
        const workflow = await loadWorkflow(context.config.osseoDir, input.name);
        if (workflow === undefined) return toolFailure({ tool: "workflow.get", riskLevel: "observe", error: { code: "workflow_not_found", message: `No saved workflow named ${input.name}.` } });
        const steps = expandWorkflow(workflow, input.parameters ?? {});
        await noteWorkflowUsed(context.config.osseoDir, input.name).catch(() => undefined);
        return toolSuccess({ tool: "workflow.get", riskLevel: "observe", data: { name: workflow.name, description: workflow.description, steps, runWith: "computer.run_steps" }, observations: ["Not executed. Pass these steps to computer.run_steps. Re-check the screen first: it may have changed since the workflow was saved."] });
      } catch (error) {
        return failure("workflow.get", error);
      }
    }
  };

  const remove: OsseoToolDefinition<z.infer<typeof deleteInput>, { deleted: boolean }, OsseoMcpContext> = {
    name: "workflow.delete",
    description: "Deletes a saved workflow.",
    riskLevel: "low",
    inputSchema: deleteInput,
    mcpInputSchema: schema({ name: { type: "string", minLength: 2, maxLength: 49 } }, ["name"]),
    inputSummary: "Delete workflow",
    safety: { actionType: "inspect" },
    async handler(input, context): Promise<ToolResult<{ deleted: boolean }>> {
      try {
        const deleted = await deleteWorkflow(context.config.osseoDir, input.name);
        return deleted
          ? toolSuccess({ tool: "workflow.delete", riskLevel: "low", data: { deleted: true } })
          : toolFailure({ tool: "workflow.delete", riskLevel: "low", error: { code: "workflow_not_found", message: `No saved workflow named ${input.name}.` } });
      } catch (error) {
        return failure("workflow.delete", error);
      }
    }
  };

  return [save, list, get, remove];
}
