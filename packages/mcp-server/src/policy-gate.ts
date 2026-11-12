import {
  classifyAppSensitivity,
  decidePolicy,
  auditPolicySource,
  loadPolicy,
  summarizeForLog,
  type PolicyAction,
  type PolicyClassification,
  type PolicyTarget
} from "@agenthost/core";
import type { AgentHostMcpContext } from "./context.js";
import type { AnyAgentHostToolDefinition, ToolPreviewEffect } from "./tool-runner.js";

/**
 * Where policy.toml meets the tool runner.
 *
 * Order: floors (nothing can change them), then file rules (first match wins), then the
 * classifier's own decision, which is already inside `effect`.
 * An allow rule removes an approval only when it names the action exactly (send, upload, delete or
 * pay), never through `any`. It cannot touch a blocked effect or a floor.
 */

const PASSWORD_MANAGER = /1password|bitwarden|keepass|lastpass|dashlane|enpass|proton pass|keyring|seahorse/i;
/** The categories a person can pre-approve; navigation, typing and plain clicks never need a prompt of their own. */
const APPROVABLE: ReadonlySet<PolicyAction> = new Set<PolicyAction>(["send", "upload", "delete", "pay"]);
/** Metadata-only control tools are exempt from file rules, so a broad rule can never lock the operator out. */
const EXEMPT_FAMILIES = new Set(["agent", "task"]);

export interface PolicyGateResult {
  effect: ToolPreviewEffect;
  /** `floor`, `policy_rule:<line>` or `classifier`. */
  source: string;
  note?: string;
  /** A file rule removed the approval this call would otherwise need. */
  allowedByRule: boolean;
}

function hostOf(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

async function resolveTarget(
  tool: AnyAgentHostToolDefinition,
  input: unknown,
  effect: ToolPreviewEffect,
  context: AgentHostMcpContext
): Promise<{ target: PolicyTarget; url: string | undefined; safetyInput: Record<string, unknown> }> {
  let safetyInput: Record<string, unknown> = {};
  try {
    safetyInput = (tool.safety.getInput?.(input) ?? {}) as Record<string, unknown>;
  } catch {
    safetyInput = {};
  }
  const data = effect.data as Record<string, unknown> | undefined;
  const app = stringField(data?.activeWindow, "appName")
    ?? stringField(safetyInput, "appName")
    ?? stringField(input, "appName")
    ?? stringField((input as Record<string, unknown> | null)?.activeWindow, "appName")
    ?? stringField((input as Record<string, unknown> | null)?.target, "appName");
  let url: string | undefined;
  let site: string | undefined;
  if (tool.name.startsWith("browser.")) {
    url = stringField(safetyInput, "url") ?? stringField(input, "url");
    if (url === undefined) {
      try {
        url = (await context.linux?.browser?.state())?.url;
      } catch {
        url = undefined;
      }
    }
    site = hostOf(url);
  }
  return { target: { app, site }, url, safetyInput };
}

export async function applyFilePolicy(
  tool: AnyAgentHostToolDefinition,
  input: unknown,
  effect: ToolPreviewEffect,
  context: AgentHostMcpContext
): Promise<PolicyGateResult> {
  const family = tool.name.split(".", 1)[0] ?? "";
  if (EXEMPT_FAMILIES.has(family)) return { effect, source: "classifier", allowedByRule: false };

  const stateChanging = tool.execution?.executionClass === "state_changing";
  const { target, url, safetyInput } = await resolveTarget(tool, input, effect, context);

  // Floors. The effect already carries the blocked tier and any refused sensitive field
  // (password, one-time-code and card fields are refused by the tool's own preview and handler).
  const blockedByClassifier = effect.blocked === true || effect.riskLevel === "blocked" || effect.approval?.status === "denied";
  const passwordManager = stateChanging && target.app !== undefined && PASSWORD_MANAGER.test(target.app);
  if (passwordManager && effect.blocked !== true) {
    return {
      effect: { ...effect, blocked: true, riskLevel: "blocked", reasons: [...(effect.reasons ?? []), "Password managers are never automated."] },
      source: "floor",
      allowedByRule: false
    };
  }
  if (blockedByClassifier) return { effect, source: "floor", allowedByRule: false };

  const classification: PolicyClassification = {
    riskLevel: effect.riskLevel ?? tool.riskLevel,
    appSensitivity: classifyAppSensitivity({ ...(target.app === undefined ? {} : { appName: target.app }), ...(url === undefined ? {} : { url }) }),
    stateChanging,
    externalEffect: safetyInput.externalEffect === true,
    destructive: safetyInput.destructive === true,
    communicative: safetyInput.communicative === true,
    consequential: effect.requiresConfirmation === true,
    actionType: tool.safety.actionType,
    ...(effect.summary === undefined ? {} : { summary: effect.summary })
  };
  const loaded = await loadPolicy(context.config.agentHostDir);
  const outcome = decidePolicy(loaded.rules, { tool: tool.name, input, target, classification });
  const source = auditPolicySource(outcome);
  if (outcome.source !== "policy_rule" || outcome.decision === undefined) return { effect, source, allowedByRule: false };

  const note = outcome.note === undefined ? undefined : summarizeForLog(outcome.note);
  const where = `policy.toml line ${outcome.line ?? "?"}${note === undefined ? "" : ` (${note})`}`;
  if (outcome.decision === "never") {
    return {
      effect: { ...effect, blocked: true, blockedCode: "policy_never", reasons: [`Refused by ${where}.`, ...(effect.reasons ?? [])] },
      source,
      ...(note === undefined ? {} : { note }),
      allowedByRule: false
    };
  }
  if (outcome.decision === "ask") {
    return {
      effect: { ...effect, requiresConfirmation: true, reasons: [`Approval required by ${where}.`, ...(effect.reasons ?? [])] },
      source,
      ...(note === undefined ? {} : { note }),
      allowedByRule: false
    };
  }
  // allow
  const removes = outcome.exact === true && APPROVABLE.has(outcome.category);
  return { effect, source, ...(note === undefined ? {} : { note }), allowedByRule: removes };
}
