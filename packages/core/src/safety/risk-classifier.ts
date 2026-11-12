import type {
  AppSensitivity,
  PathAccessMode,
  PermissionDefault,
  RuntimePolicy,
  RiskLevel,
  SafetyDecision,
  SafetyEvaluationContext,
  SafetyInput
} from "../types.js";
import { isStateChangingAction } from "../grants.js";
import { evaluateApprovalRequirement, isApprovalSatisfied } from "./approval.js";
import { classifyAppSensitivity } from "./app-sensitivity.js";
import { classifyPath } from "./path-policy.js";
import { classifyShellCommand } from "./shell-classifier.js";
import { actionEffectFromSafetyInput, decideGovernedAction } from "../action-policy.js";

const RISK_ORDER: RiskLevel[] = ["observe", "low", "medium", "high", "blocked"];

function maxRiskLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

function baseRiskForAction(actionType: SafetyInput["actionType"]): RiskLevel {
  switch (actionType) {
    case "observe":
      return "observe";
    case "inspect":
    case "file_read":
      return "low";
    case "app_launch":
    case "shell_command":
    case "file_write":
    case "gui_click":
    case "gui_type":
    case "accessibility_action":
    case "accessibility_set_value":
    case "accessibility_focus":
    case "browser_action":
      return "medium";
    case "file_delete":
    case "communication_send":
    case "upload":
    case "system_change":
      return "high";
    case "unknown":
      return "medium";
  }
}

function accessForAction(actionType: SafetyInput["actionType"]): PathAccessMode {
  switch (actionType) {
    case "file_write":
      return "write";
    case "file_delete":
      return "delete";
    default:
      return "read";
  }
}

function applyAppSensitivityRisk(
  riskLevel: RiskLevel,
  appSensitivity: AppSensitivity,
  input: SafetyInput,
  reasons: string[],
  matchedRules: string[]
): RiskLevel {
  if (appSensitivity === "credential_or_security") {
    if (input.actionType !== "observe" && input.actionType !== "inspect") {
      reasons.push("Credential or security apps are blocked for state-changing or data-moving actions.");
      matchedRules.push("app.credential_or_security.blocked");
      return "blocked";
    }

    reasons.push("Credential or security app inspection is sensitive.");
    matchedRules.push("app.credential_or_security.inspect");
    return maxRiskLevel(riskLevel, "high");
  }

  if (appSensitivity === "financial") {
    if (input.actionType !== "observe" && input.actionType !== "inspect") {
      reasons.push("Financial/payment actions require a dedicated governed route, strong confirmation, and independent verification.");
      matchedRules.push("app.financial.governed_required");
      return maxRiskLevel(riskLevel, "high");
    }

    reasons.push("Financial/payment app inspection is high-risk.");
    matchedRules.push("app.financial.inspect");
    return maxRiskLevel(riskLevel, "high");
  }

  if (appSensitivity === "communication") {
    if (
      input.communicative ||
      input.externalEffect ||
      input.actionType === "communication_send" ||
      input.actionType === "gui_type" ||
      input.actionType === "gui_click" ||
      input.actionType === "accessibility_action" ||
      input.actionType === "accessibility_set_value" ||
      input.actionType === "accessibility_focus" ||
      input.actionType === "browser_action" ||
      input.effect?.sensitivity === "communication"
    ) {
      reasons.push("Communication actions that type, send, post, or affect external recipients are high-risk.");
      matchedRules.push("app.communication.high_risk");
      return maxRiskLevel(riskLevel, "high");
    }
  }

  if (appSensitivity === "system_settings" && input.actionType !== "observe" && input.actionType !== "inspect") {
    reasons.push("Changing system settings is high-risk.");
    matchedRules.push("app.system_settings.high_risk");
    return maxRiskLevel(riskLevel, "high");
  }

  return riskLevel;
}

/**
 * Reading or inspecting a communication app (observe, inspect, file_read) is
 * allowed to proceed when the risk is at most medium, even if the policy
 * default for the action would otherwise deny it or route it to guide mode.
 * Sends and other external effects are not covered: they still need an exact
 * single-use confirmation through the normal approval rules.
 */
export function communicationInspectionAllowed(
  input: SafetyInput,
  appSensitivity: AppSensitivity,
  riskLevel: RiskLevel
): boolean {
  return (
    appSensitivity === "communication" &&
    (input.actionType === "observe" || input.actionType === "inspect" || input.actionType === "file_read") &&
    RISK_ORDER.indexOf(riskLevel) <= RISK_ORDER.indexOf("medium")
  );
}

function permissionDefaultFor(policy: RuntimePolicy, input: SafetyInput): PermissionDefault {
  if (input.tool === "desktop.screenshot") {
    return policy.defaults.screenshots;
  }

  if (input.tool === "window.focus") {
    return policy.allowGenericClick ? "allow" : policy.defaults.windowFocus;
  }

  if (input.tool === "desktop.hotkey") {
    return policy.allowGenericType ? "allow" : policy.defaults.guiHotkey;
  }

  if (input.dataSensitivity === "sensitive" || input.dataSensitivity === "secret") {
    return policy.defaults.privateDataReads;
  }

  switch (input.actionType) {
    case "observe":
    case "inspect":
      return input.actionType === "inspect" ? policy.defaults.accessibilityRead : "allow";
    case "app_launch":
      return policy.defaults.appOpen;
    case "shell_command":
      return policy.defaults.shell;
    case "file_read":
      return policy.defaults.fileRead;
    case "file_write":
    case "file_delete":
      return input.destructive ? policy.defaults.destructiveActions : policy.defaults.fileWrite;
    case "gui_click":
      return policy.allowGenericClick ? "allow" : policy.defaults.guiClick;
    case "gui_type":
      return policy.allowGenericType ? "allow" : policy.defaults.guiType;
    case "accessibility_action":
    case "accessibility_set_value":
    case "accessibility_focus":
      return policy.defaults.accessibilityActions;
    case "browser_action":
      return policy.defaults.browserAutomation;
    case "communication_send":
      return policy.defaults.communicationActions;
    case "upload":
      return policy.defaults.externalSendsUploads;
    case "system_change":
      return policy.defaults.destructiveActions;
    case "unknown":
      return "approval_required";
  }
}

interface PolicyEvaluation {
  blocked: boolean;
  guideOnly: boolean;
  requiresApproval: boolean;
  requiresConfirmationToken: boolean;
  reasons: string[];
  matchedRules: string[];
}

/** Policy-level defaults and the confirmation-token rule for one call. */
function evaluatePolicyDefaults(
  input: SafetyInput,
  policy: RuntimePolicy,
  appSensitivity: AppSensitivity,
  riskLevel: RiskLevel
): PolicyEvaluation {
  const reasons: string[] = [];
  const matchedRules: string[] = [];
  let requiresConfirmationToken = policy.requireConfirmationForStateChanging && isStateChangingAction(input.actionType);
  let requiresApproval = false;
  let blocked = false;
  let guideOnly = false;

  const defaultPermission = permissionDefaultFor(policy, input);
  if (defaultPermission === "deny") {
    blocked = true;
    reasons.push("Policy denies this capability by default.");
    matchedRules.push(`policy.default.${input.actionType}.deny`);
  } else if (defaultPermission === "guide_only") {
    guideOnly = true;
    reasons.push("Policy routes this capability to guide mode by default.");
    matchedRules.push(`policy.default.${input.actionType}.guide_only`);
  } else if (defaultPermission === "approval_required") {
    requiresApproval = true;
    reasons.push("Policy requires approval for this capability by default.");
    matchedRules.push(`policy.default.${input.actionType}.approval_required`);
  }

  if (communicationInspectionAllowed(input, appSensitivity, riskLevel)) {
    blocked = false;
    guideOnly = false;
    reasons.push("Inspecting a communication app is allowed within medium risk.");
    matchedRules.push("app.communication.inspection_allowed");
  }

  // Consequential effects are never silently executed: they require an exact
  // single-use confirmation bound to the current input and target.
  if (input.externalEffect === true || input.destructive === true || appSensitivity === "financial") {
    requiresConfirmationToken = true;
    reasons.push("External, destructive, or financial effects require exact single-use confirmation.");
    matchedRules.push("effect.exact_confirmation_required");
  }
  if (input.dataSensitivity === "sensitive" || input.dataSensitivity === "secret") {
    requiresConfirmationToken = true;
    reasons.push("Private-data access requires exact single-use confirmation.");
    matchedRules.push("data.private_confirmation_required");
  }

  return { blocked, guideOnly, requiresApproval, requiresConfirmationToken, reasons, matchedRules };
}

export function classifyRisk(
  input: SafetyInput,
  policy: RuntimePolicy,
  context: SafetyEvaluationContext = {}
): SafetyDecision {
  let riskLevel = baseRiskForAction(input.actionType);
  const classifiedSensitivity = classifyAppSensitivity(input);
  const appSensitivity = input.effect?.sensitivity !== undefined && input.effect.sensitivity !== "normal"
    ? input.effect.sensitivity
    : classifiedSensitivity;
  const reasons: string[] = [];
  const matchedRules: string[] = [`action.${input.actionType}`];

  riskLevel = applyAppSensitivityRisk(riskLevel, appSensitivity, input, reasons, matchedRules);

  if (input.filePath !== undefined) {
    const pathDecision = classifyPath(input.filePath, policy, { ...context, access: accessForAction(input.actionType) });
    riskLevel = maxRiskLevel(riskLevel, pathDecision.riskLevel);
    reasons.push(...pathDecision.reasons);
    matchedRules.push(...pathDecision.matchedRules);
  }

  if (input.shellCommand !== undefined) {
    const shellDecision = classifyShellCommand(input.shellCommand, policy, context);
    riskLevel = maxRiskLevel(riskLevel, shellDecision.riskLevel);
    reasons.push(...shellDecision.reasons);
    matchedRules.push(...shellDecision.matchedRules);
  }

  if (input.dataSensitivity === "secret") {
    riskLevel = "blocked";
    reasons.push("Secret data must not be accessed, typed, uploaded, or sent by default.");
    matchedRules.push("data.secret.blocked");
  } else if (input.dataSensitivity === "sensitive") {
    const readOnlySensitive =
      input.actionType === "observe" || input.actionType === "inspect" || input.actionType === "file_read";
    riskLevel = maxRiskLevel(riskLevel, readOnlySensitive ? "medium" : "high");
    reasons.push(
      readOnlySensitive
        ? "Sensitive data inspection requires elevated controls."
        : "Sensitive data makes the action high-risk."
    );
    matchedRules.push(readOnlySensitive ? "data.sensitive.read_requires_controls" : "data.sensitive.high_risk");
  }

  if (input.destructive) {
    riskLevel = maxRiskLevel(riskLevel, "high");
    reasons.push("Destructive actions are high-risk.");
    matchedRules.push("action.destructive.high_risk");
  }

  if (input.externalEffect) {
    riskLevel = maxRiskLevel(riskLevel, "high");
    reasons.push("Actions with external effects are high-risk.");
    matchedRules.push("action.external_effect.high_risk");
  }

  if (input.communicative) {
    riskLevel = maxRiskLevel(riskLevel, "high");
    reasons.push("Communicative actions are high-risk.");
    matchedRules.push("action.communicative.high_risk");
  }

  if (input.actionType === "shell_command" && !policy.allowShell) {
    riskLevel = maxRiskLevel(riskLevel, "high");
    reasons.push("Shell is disabled by policy.");
    matchedRules.push("policy.shell.disabled");
  }

  if (input.tool === "desktop.screenshot" && !policy.allowScreenshots) {
    riskLevel = "blocked";
    reasons.push("Screenshots are disabled by policy.");
    matchedRules.push("policy.screenshot.disabled");
  }


  if (input.actionType === "unknown") {
    reasons.push("Unknown actions default to a conservative risk level.");
    matchedRules.push("action.unknown.conservative");
  }

  if (!policy.enabled && isStateChangingAction(input.actionType)) {
    riskLevel = "blocked";
    reasons.push("State-changing execution is disabled by policy.");
    matchedRules.push("policy.disabled");
  }

  const policyEvaluation = evaluatePolicyDefaults(input, policy, appSensitivity, riskLevel);
  reasons.push(...policyEvaluation.reasons);
  matchedRules.push(...policyEvaluation.matchedRules);

  let approval = evaluateApprovalRequirement(riskLevel, policy, reasons, context.confirmationSatisfied === true);

  if (
    policyEvaluation.requiresApproval &&
    context.confirmationSatisfied !== true &&
    approval.status !== "denied" &&
    approval.status !== "required"
  ) {
    approval = {
      required: true,
      status: "required",
      reason: "Policy requires approval for this capability before execution."
    };
  }

  const blocked = riskLevel === "blocked" || approval.status === "denied" || policyEvaluation.blocked || policyEvaluation.guideOnly;

  if (blocked && approval.status !== "denied") {
    approval = {
      required: false,
      status: "denied",
      reason: reasons.join(" ")
    };
  }

  const actionDecision = input.effect === undefined ? undefined : decideGovernedAction({
    effect: actionEffectFromSafetyInput(input, context.ownerSessionId ?? "unknown-session", "state_changing"),
    safety: { allowed: !blocked, blocked, guideOnly: policyEvaluation.guideOnly, riskLevel, appSensitivity },
    policy
  });

  return {
    riskLevel,
    appSensitivity,
    approval,
    allowed: !blocked && isApprovalSatisfied(approval),
    blocked,
    guideOnly: policyEvaluation.guideOnly,
    reasons,
    matchedRules: [...new Set(matchedRules)],
    requiresConfirmationToken: policyEvaluation.requiresConfirmationToken,
    ...(actionDecision === undefined ? {} : { actionDecision })
  };
}

export const evaluateSafety = classifyRisk;
