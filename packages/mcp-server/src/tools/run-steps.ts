import { createHash } from "node:crypto";
import { toolFailure, toolSuccess, type RiskLevel, type StepExpectation, type ToolResult } from "@agenthost/core";
import { z } from "zod";
import type { AgentHostMcpContext } from "../context.js";
import type { AgentHostToolDefinition, AnyAgentHostToolDefinition } from "../tool-runner.js";
import { runTool } from "../tool-runner.js";
import { settledPicture } from "./desktop.js";
import { findScreenTextMatches } from "./vision.js";

const MAX_STEPS = 20;
const MAX_INPUT_BYTES = 64 * 1024;

const expectationInput = z.object({
  screenChanged: z.boolean().optional(),
  windowTitle: z.string().trim().min(1).max(200).optional(),
  textVisible: z.string().trim().min(1).max(200).optional()
}).strict().refine((value) => Object.keys(value).length > 0, { message: "expect needs at least one check." });

const stepInput = z.object({
  tool: z.string().trim().min(3).max(100),
  input: z.record(z.unknown()).optional(),
  expect: expectationInput.optional()
}).strict();

const runStepsInput = z.object({
  steps: z.array(stepInput).min(1).max(MAX_STEPS),
  stopOnError: z.boolean().optional(),
  /** One picture of the window after the whole plan, instead of one per step. */
  returnScreenshot: z.enum(["none", "region", "window"]).optional()
}).strict().superRefine((value, ctx) => {
  if (Buffer.byteLength(JSON.stringify(value.steps), "utf8") > MAX_INPUT_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Plan input exceeds 64 KiB." });
  }
  for (const [index, step] of value.steps.entries()) {
    if (step.tool === "computer.run_steps") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["steps", index, "tool"], message: "Nested run_steps is not allowed." });
    }
  }
});

type RunStepsInput = z.infer<typeof runStepsInput>;
type Step = RunStepsInput["steps"][number];

const RISK_ORDER: Record<RiskLevel, number> = { observe: 0, low: 1, medium: 2, high: 3, blocked: 4 };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function planFingerprint(steps: Step[]): string {
  return createHash("sha256").update(canonical(steps.map((step) => ({ tool: step.tool, input: step.input ?? {} })))).digest("hex").slice(0, 20);
}

function nestedRequiresConfirmation(result: ToolResult): boolean {
  const data = result.data;
  return data !== null && typeof data === "object" && (data as { requiresConfirmation?: unknown }).requiresConfirmation === true;
}

function blockedCode(result: ToolResult): boolean {
  return ["invalid_input", "safety_blocked", "emergency_stop_requested", "human_takeover_active", "pause_requested"].includes(result.error?.code ?? "");
}

function maxRisk(results: Array<{ riskLevel: RiskLevel }>, fallback: RiskLevel): RiskLevel {
  return results.reduce<RiskLevel>((highest, entry) => RISK_ORDER[entry.riskLevel] > RISK_ORDER[highest] ? entry.riskLevel : highest, fallback);
}

/** Whether any text node under the outline contains the needle (names and text, case-insensitive). */
function outlineContains(node: { name?: string | null; text?: string | null; description?: string | null; children?: unknown[] } | undefined, needle: string): boolean {
  if (node === undefined) return false;
  for (const value of [node.name, node.text, node.description]) {
    if (typeof value === "string" && value.toLowerCase().includes(needle)) return true;
  }
  return (node.children ?? []).some((child) => outlineContains(child as typeof node, needle));
}

/** Whether text is visible in the active window: the accessibility outline first, OCR when there is none. */
async function textVisibleIn(context: AgentHostMcpContext, text: string): Promise<boolean | undefined> {
  const active = (await context.linux.getActiveWindow().catch(() => undefined))?.activeWindow;
  if (active !== undefined && (active.pid !== undefined || active.appName !== undefined)) {
    const tree = await context.linux.getAccessibilityTree({
      ...(active.pid !== undefined ? { pid: active.pid } : { appName: active.appName! }),
      maxDepth: 8,
      maxNodes: 300,
      includeText: true
    }).catch(() => undefined);
    if (tree?.supported === true && tree.root !== undefined) {
      return outlineContains(tree.root as Parameters<typeof outlineContains>[0], text.toLowerCase());
    }
  }
  const ocr = await findScreenTextMatches(context, { query: text, match: "contains", limit: 1 }).catch(() => undefined);
  if (ocr === undefined || !ocr.ok) return undefined;
  const matches = (ocr.data as { matches?: unknown[] } | null)?.matches ?? [];
  return matches.length > 0;
}

/** Checks a step's expectations against what the step reported and the window now shows. */
async function checkExpectation(
  context: AgentHostMcpContext,
  expect: StepExpectation,
  result: ToolResult
): Promise<{ ok: true } | { ok: false; code: "expectation_failed" | "expectation_unverified"; message: string }> {
  if (expect.screenChanged !== undefined) {
    const measured = (result.data as { effect?: { screenChanged?: boolean | null } } | null)?.effect?.screenChanged;
    if (measured !== true && measured !== false) {
      return { ok: false, code: "expectation_unverified", message: "The step did not measure the screen, so screenChanged cannot be checked. Leave verify on for that step." };
    }
    if (measured !== expect.screenChanged) {
      return { ok: false, code: "expectation_failed", message: `Expected screenChanged ${expect.screenChanged}, but the screen ${measured ? "changed" : "did not change"}.` };
    }
  }
  if (expect.windowTitle !== undefined) {
    const title = (await context.linux.getActiveWindow().catch(() => undefined))?.activeWindow?.title ?? "";
    if (!title.toLowerCase().includes(expect.windowTitle.toLowerCase())) {
      return { ok: false, code: "expectation_failed", message: `Expected the active window title to contain "${expect.windowTitle}".` };
    }
  }
  if (expect.textVisible !== undefined) {
    const visible = await textVisibleIn(context, expect.textVisible);
    if (visible === undefined) return { ok: false, code: "expectation_unverified", message: "Neither the accessibility outline nor OCR could check the text." };
    if (!visible) return { ok: false, code: "expectation_failed", message: `Expected "${expect.textVisible}" to be visible.` };
  }
  return { ok: true };
}

/** One line per step, so a long plan reads as a short log. */
function outcomeLine(index: number, tool: string, result: ToolResult, failure: ToolResult | undefined, expected: boolean): string {
  const number = index + 1;
  if (failure !== undefined) {
    const code = failure.error?.code ?? "failed";
    const expectationMissed = code === "expectation_failed" || code === "expectation_unverified";
    return expectationMissed ? `${number}. ${tool} ok, but ${failure.error?.message ?? code}` : `${number}. ${tool} failed: ${code}`;
  }
  const measured = (result.data as { effect?: { screenChanged?: boolean | null } } | null)?.effect?.screenChanged;
  const change = measured === true ? ", screen changed" : measured === false ? ", no visible change" : "";
  return `${number}. ${tool} ok${change}${expected ? ", expectation met" : ""}`;
}

function previewContext(context: AgentHostMcpContext): AgentHostMcpContext {
  const {
    actionOverlay: _actionOverlay,
    trace: _trace,
    confirmationSatisfied: _confirmationSatisfied,
    planApproval: _planApproval,
    ...rest
  } = context;
  return { ...rest, logger: { log: async () => undefined } };
}

export function createRunStepsTool(): AnyAgentHostToolDefinition<AgentHostMcpContext> {
  const tool: AgentHostToolDefinition<RunStepsInput, unknown, AgentHostMcpContext> = {
    name: "computer.run_steps",
    description: "Runs a bounded, governed plan of up to 20 AgentHost tool calls with one plan-scoped approval for low/medium effects. Each step still re-enters full safety, stop/takeover, confirmation, audit, and execution gates; high-risk steps still need their own token.",
    riskLevel: "medium",
    inputSchema: runStepsInput,
    mcpInputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: MAX_STEPS,
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              input: { type: "object", additionalProperties: true },
              expect: {
                type: "object",
                description: "Checked after the step; a failed check stops the plan. Give at least one: screenChanged, windowTitle, textVisible.",
                properties: {
                  screenChanged: { type: "boolean" },
                  windowTitle: { type: "string", minLength: 1, maxLength: 200 },
                  textVisible: { type: "string", minLength: 1, maxLength: 200 }
                },
                additionalProperties: false
              }
            },
            required: ["tool"],
            additionalProperties: false
          }
        },
        stopOnError: { type: "boolean" },
        returnScreenshot: { type: "string", enum: ["none", "region", "window"], description: "One picture of the window after the whole plan, inline: region (around the last click point) or window. Default none." }
      },
      required: ["steps"],
      additionalProperties: false
    },
    inputSummary: (input) => `Run ${input.steps.length} planned step${input.steps.length === 1 ? "" : "s"}`,
    safety: { actionType: "plan" },
    auditInputSummary: (input) => `Plan with ${input.steps.length} governed steps`,
    auditOutputSummary: (result) => result.ok ? "Plan completed." : `Plan stopped: ${result.error?.code ?? "failed"}`,
    preview: {
      async resolveEffect(input, context) {
        const fingerprint = planFingerprint(input.steps);
        const steps: Array<{ index: number; tool: string; ok: boolean; riskLevel: RiskLevel; status: "ready" | "blocked"; summary?: string; error?: string }> = [];
        const blockedReasons: string[] = [];
        let planNeedsConfirmation = false;
        const tools = context.tools;
        for (const [index, step] of input.steps.entries()) {
          const target = tools?.get(step.tool);
          if (target === undefined) {
            steps.push({ index, tool: step.tool, ok: false, riskLevel: "blocked", status: "blocked", error: "unknown_tool" });
            blockedReasons.push(`Step ${index + 1}: unknown tool ${step.tool}.`);
            continue;
          }
          const result = await runTool(
            target as AnyAgentHostToolDefinition<AgentHostMcpContext>,
            { ...(step.input ?? {}), dryRun: true },
            previewContext(context),
            { previewOnly: true }
          );
          const blocked = blockedCode(result) || result.riskLevel === "blocked";
          if (blocked) blockedReasons.push(`Step ${index + 1} ${step.tool}: ${result.error?.message ?? "blocked"}`);
          if (nestedRequiresConfirmation(result) && (result.riskLevel === "low" || result.riskLevel === "medium")) planNeedsConfirmation = true;
          const summary = typeof result.data === "object" && result.data !== null
            ? (result.data as { summary?: string }).summary
            : undefined;
          steps.push({
            index,
            tool: step.tool,
            ok: result.ok,
            riskLevel: result.riskLevel,
            status: blocked ? "blocked" : "ready",
            ...(summary === undefined ? {} : { summary }),
            ...(result.error?.code === undefined ? {} : { error: result.error.code })
          });
        }
        if (blockedReasons.length > 0) {
          return { summary: "Plan contains blocked steps.", blocked: true, reasons: blockedReasons, targetFingerprint: fingerprint, data: { planFingerprint: fingerprint, steps } };
        }
        return {
          summary: `Plan of ${input.steps.length} governed step${input.steps.length === 1 ? "" : "s"}`,
          targetFingerprint: fingerprint,
          requiresConfirmation: planNeedsConfirmation,
          data: { planFingerprint: fingerprint, steps, planRequiresConfirmation: planNeedsConfirmation }
        };
      }
    },
    async handler(input, context): Promise<ToolResult<unknown>> {
      const fingerprint = planFingerprint(input.steps);
      const tools = context.tools;
      if (tools === undefined) {
        return toolFailure({ tool: "computer.run_steps", riskLevel: "medium", error: { code: "plan_unavailable", message: "Tool registry is unavailable." }, observations: ["No action was executed."] });
      }
      const { confirmationSatisfied: _ignored, ...baseContext } = context;
      const planApproved = context.confirmationSatisfied === true;
      const childContext: AgentHostMcpContext = planApproved
        ? { ...baseContext, planApproval: { planFingerprint: fingerprint, maxRisk: "medium" } }
        : baseContext;
      const stopOnError = input.stopOnError !== false;
      const results: Array<{ index: number; tool: string; ok: boolean; riskLevel: RiskLevel; expectation?: "met" | "failed" | "not_checked"; error?: string }> = [];
      const outcomes: string[] = [];
      let failed: ToolResult | undefined;
      for (const [index, step] of input.steps.entries()) {
        const target = tools.get(step.tool);
        if (target === undefined) {
          failed = toolFailure({ tool: "computer.run_steps", riskLevel: "medium", error: { code: "unknown_tool", message: `Unknown tool: ${step.tool}` }, observations: [`Step ${index + 1} was not executed.`] });
          outcomes.push(`${index + 1}. ${step.tool} not run: unknown tool`);
          break;
        }
        const result = await runTool(target as AnyAgentHostToolDefinition<AgentHostMcpContext>, step.input ?? {}, {
          ...childContext,
          planStep: { index, total: input.steps.length }
        });
        let stepFailure: ToolResult | undefined = result.ok ? undefined : result;
        let expectationMissed = false;
        if (result.ok && step.expect !== undefined) {
          const verdict = await checkExpectation(context, step.expect, result);
          if (!verdict.ok) {
            expectationMissed = true;
            stepFailure = toolFailure({ tool: step.tool, riskLevel: result.riskLevel, error: { code: verdict.code, message: verdict.message }, observations: [verdict.message] });
          }
        }
        results.push({
          index,
          tool: step.tool,
          ok: stepFailure === undefined,
          riskLevel: result.riskLevel,
          ...(step.expect === undefined ? {} : { expectation: stepFailure === undefined ? "met" : expectationMissed ? "failed" : "not_checked" }),
          ...(stepFailure === undefined ? {} : { error: stepFailure.error?.code ?? "failed" })
        });
        outcomes.push(outcomeLine(index, step.tool, result, stepFailure, step.expect !== undefined));
        if (stepFailure !== undefined) {
          failed = stepFailure;
          // A missed expectation means the plan is not doing what it should: always stop there.
          if (stopOnError || expectationMissed) break;
        }
      }
      const failedCode = failed?.error?.code;
      // One picture at the end (not one per step), whatever the outcome.
      const picture = input.returnScreenshot === undefined || input.returnScreenshot === "none"
        ? undefined
        : await settledPicture(context, input.returnScreenshot);
      const data = {
        planFingerprint: fingerprint,
        outcomes,
        steps: results,
        ...(failedCode === undefined ? {} : { failedCode }),
        ...(picture ?? {})
      };
      if (failed !== undefined) {
        const code = failed.error?.code === "confirmation_required" || blockedCode(failed) || failed.error?.code === "expectation_failed" || failed.error?.code === "expectation_unverified"
          ? failed.error?.code ?? "step_failed"
          : "step_failed";
        const result: ToolResult<unknown> = toolFailure({
          tool: "computer.run_steps",
          riskLevel: maxRisk(results, "medium"),
          error: {
            code,
            message: code === "confirmation_required"
              ? "A plan step requires its own confirmation before the plan can continue."
              : failed.error?.message ?? "A plan step failed.",
            details: { failedStep: results.at(-1)?.index, failedTool: results.at(-1)?.tool }
          },
          observations: ["The plan stopped at the failed step.", ...(failed.observations ?? [])]
        });
        result.data = data;
        return result;
      }
      return toolSuccess({
        tool: "computer.run_steps",
        riskLevel: maxRisk(results, "medium"),
        data,
        observations: [`Completed ${results.length} governed step${results.length === 1 ? "" : "s"}.`, "Verify the final state before reporting completion."]
      });
    }
  };
  return tool as AnyAgentHostToolDefinition<AgentHostMcpContext>;
}
