import {
  AUTOMATION_STRATEGIES,
  TOOL_EXECUTION_CLASSES,
  type AppCapability,
  type AutomationStrategy,
  type CapabilityRegistrySnapshot,
  type ToolCapability,
  type ToolExecutionMetadata
} from "./types.js";

const TOOL_SOURCES = new Set(["base", "optional_adapter"]);
const TOOL_AVAILABILITIES = new Set(["available", "unavailable"]);

function normalizeExecutionMetadata(metadata: ToolExecutionMetadata): ToolExecutionMetadata {
  const stateChanging = metadata.executionClass === "state_changing";
  return {
    ...metadata,
    operationFamily: metadata.operationFamily ?? (stateChanging ? "state_change" : "observe"),
    operation: metadata.operation ?? (stateChanging ? "governed_action" : "inspect"),
    reversibility: metadata.reversibility ?? (stateChanging ? "persistent" : "reversible"),
    sensitivity: metadata.sensitivity ?? "normal",
    requiredBindings: metadata.requiredBindings ?? (metadata.requiresExactTarget ? ["target"] : []),
    confirmationLevel: metadata.confirmationLevel ?? (stateChanging ? "standard" : "none"),
    verificationKind: metadata.verificationKind ?? (stateChanging ? "tool_result" : "none"),
    cleanupKind: metadata.cleanupKind ?? "none"
  };
}

/**
 * Runtime validation shared by the core registry boundary.  MCP metadata
 * validation remains stricter about tool-definition shape, but a capability
 * registry must never accept a missing or contradictory execution contract.
 */
export function validateToolExecutionMetadata(metadata: ToolExecutionMetadata, toolName: string): void {
  if (metadata === undefined || metadata === null || typeof metadata !== "object") {
    throw new Error(`Missing execution metadata for ${toolName}`);
  }
  if (!TOOL_EXECUTION_CLASSES.includes(metadata.executionClass)) {
    throw new Error(`Unknown execution class for ${toolName}`);
  }
  if (typeof metadata.externalEffect !== "boolean"
    || typeof metadata.requiresDryRun !== "boolean"
    || typeof metadata.requiresConfirmationToken !== "boolean"
    || typeof metadata.requiresExactTarget !== "boolean") {
    throw new Error(`Invalid execution metadata for ${toolName}`);
  }
  if (!TOOL_SOURCES.has(metadata.source) || !TOOL_AVAILABILITIES.has(metadata.availability)) {
    throw new Error(`Invalid execution metadata source or availability for ${toolName}`);
  }
  const inert = metadata.executionClass !== "state_changing";
  if (inert && (metadata.externalEffect || metadata.requiresDryRun || metadata.requiresConfirmationToken || metadata.requiresExactTarget)) {
    throw new Error(`Contradictory execution metadata for ${toolName}`);
  }
  if (metadata.executionClass === "state_changing" && metadata.requiresExactTarget && !metadata.requiresConfirmationToken) {
    throw new Error(`Exact-target execution metadata is incomplete for ${toolName}`);
  }
  if (metadata.operationFamily !== undefined && (typeof metadata.operationFamily !== "string" || metadata.operationFamily.length === 0 || metadata.operationFamily.length > 100)) throw new Error(`Invalid operation family metadata for ${toolName}`);
  if (metadata.operation !== undefined && (typeof metadata.operation !== "string" || metadata.operation.length === 0 || metadata.operation.length > 160)) throw new Error(`Invalid operation metadata for ${toolName}`);
  if (metadata.reversibility !== undefined && !["reversible", "persistent", "external", "destructive", "prohibited"].includes(metadata.reversibility)) throw new Error(`Invalid reversibility metadata for ${toolName}`);
  if (metadata.confirmationLevel !== undefined && !["none", "standard", "strong"].includes(metadata.confirmationLevel)) throw new Error(`Invalid confirmation metadata for ${toolName}`);
  if (metadata.requiredBindings !== undefined && (!Array.isArray(metadata.requiredBindings) || metadata.requiredBindings.some((binding) => !["target", "recipient", "content", "artifact", "channel", "route"].includes(binding)))) throw new Error(`Invalid binding metadata for ${toolName}`);
}

function bootstrapExecutionMetadata(name: string): ToolExecutionMetadata {
  if (name.startsWith("strategy.")) {
    const executionClass = name === "strategy.health" || name === "strategy.verify_outcome" ? "diagnostic" : name === "strategy.list" || name === "strategy.get" || name === "strategy.explain_selection" || name === "strategy.route_preview" || name === "strategy.goal_plan_preview" || name === "strategy.capability_graph" || name === "strategy.failure_memory" || name === "strategy.recall_episodes" ? "read_only" : "metadata_only";
    return { executionClass, externalEffect: false, requiresDryRun: false, requiresConfirmationToken: false, requiresExactTarget: false, source: "base", availability: "available" };
  }
  if (name === "overlay.assistance_step_preview" || name === "overlay.assistance_session_explain" || name === "overlay.assistance_template_validate" || name === "overlay.assistance_template_preview" || name === "overlay.assistance_template_get" || name === "overlay.assistance_template_list") return { executionClass: "read_only", externalEffect: false, requiresDryRun: false, requiresConfirmationToken: false, requiresExactTarget: false, source: "base", availability: "available" };
  if (name === "overlay.assistance_template_save" || name === "overlay.assistance_template_archive" || name === "overlay.assistance_template_instantiate") return { executionClass: "metadata_only", externalEffect: false, requiresDryRun: false, requiresConfirmationToken: false, requiresExactTarget: false, source: "base", availability: "available" };
  const visual = name.startsWith("overlay.");
  let metadata: ToolExecutionMetadata["executionClass"] = "read_only";
  if (name === "speech.get_capabilities" || name === "speech.routing_diagnose") metadata = "diagnostic";
  else if (/^speech\.(synthesize|play|stop|transmission_execute)$/.test(name)) metadata = "state_changing";
  else if (name === "speech.transmission_prepare") metadata = "metadata_only";
  else if (name.startsWith("speech.")) metadata = "read_only";
  else if (name === "forge.check_sandbox_support" || name === "system.check_dependency") metadata = "diagnostic";
  else if (name === "browser.setup_status" || name === "browser.setup_verify") metadata = "diagnostic";
  else if (name.startsWith("browser.setup_")) metadata = "state_changing";
  else if (/^forge\.(run_sandboxed_tool|dispatch_generated_tool)$/.test(name)) metadata = "state_changing";
  else if (name.startsWith("workflow.") || name.startsWith("scheduler.") || name.startsWith("forge.")) metadata = "metadata_only";
  else if (/^(task\.(create|update|log_event|pause|resume|complete)|agent\.(stop|resume|takeover_begin|takeover_end))$/.test(name)) metadata = "metadata_only";
  else if (name.startsWith("guide.")) metadata = "metadata_only";
  else if (name === "file.ensure_dir" || /^file\.(copy|move|delete)$/.test(name)) metadata = "state_changing";
  else if (visual) metadata = "visual_only";
  else if (/(^|\.)(open|write|delete|click|type|focus|hotkey|scroll|drag|mouse|invoke|set_value|run_|send|upload)/.test(name)) metadata = "state_changing";
  const stateChanging = metadata === "state_changing";
  return {
    executionClass: metadata,
    externalEffect: false,
    requiresDryRun: stateChanging,
    requiresConfirmationToken: stateChanging,
    requiresExactTarget: stateChanging && (/browser|desktop|window|accessibility|click|type|focus|scroll|drag|mouse/.test(name) || /^(file\.(copy|move|delete|ensure_dir)|shell\.run_safe)$/.test(name)),
    source: "base",
    availability: "available"
  };
}

export class CapabilityRegistry implements CapabilityRegistrySnapshot {
  readonly #tools = new Map<string, ToolCapability>();
  readonly #appCapabilities = new Map<string, AppCapability>();
  readonly #allowBootstrapMetadata: boolean;

  constructor(options: { allowBootstrapMetadata?: boolean } = {}) {
    // Bootstrap inference is intentionally opt-in and only used by the
    // static fallback catalog. Loaded production MCP definitions must carry
    // explicit metadata through materializeToolDefinitions().
    this.#allowBootstrapMetadata = options.allowBootstrapMetadata === true;
  }

  registerTool(capability: ToolCapability): void {
    if (this.#tools.has(capability.name)) {
      throw new Error(`Tool capability is already registered: ${capability.name}`);
    }

    const execution = capability.execution === undefined
      ? this.#allowBootstrapMetadata
        ? bootstrapExecutionMetadata(capability.name)
        : undefined
      : capability.execution;
    if (execution === undefined) throw new Error(`Missing execution metadata for ${capability.name}`);
    validateToolExecutionMetadata(execution, capability.name);
    const normalized = normalizeExecutionMetadata(execution);
    this.#tools.set(capability.name, {
      ...capability,
      execution: { ...normalized }
    });
  }

  syncTools(capabilities: ToolCapability[]): void {
    const names = new Set<string>();
    const normalized: ToolCapability[] = [];
    for (const capability of capabilities) {
      if (names.has(capability.name)) {
        throw new Error(`Tool capability is duplicated in loaded tool set: ${capability.name}`);
      }
      names.add(capability.name);
      if (capability.execution === undefined) throw new Error(`Missing execution metadata for ${capability.name}`);
      validateToolExecutionMetadata(capability.execution, capability.name);
      normalized.push({
        ...capability,
        execution: normalizeExecutionMetadata(capability.execution)
      });
    }
    this.#tools.clear();
    for (const capability of normalized) this.#tools.set(capability.name, capability);
  }

  registerAppCapability(capability: AppCapability): void {
    if (this.#appCapabilities.has(capability.id)) {
      throw new Error(`App capability is already registered: ${capability.id}`);
    }

    this.#appCapabilities.set(capability.id, { ...capability });
  }

  listStrategies(): AutomationStrategy[] {
    return [...AUTOMATION_STRATEGIES];
  }

  listTools(): ToolCapability[] {
    return [...this.#tools.values()].map((capability) => ({ ...capability }));
  }

  listAppCapabilities(): AppCapability[] {
    return [...this.#appCapabilities.values()].map((capability) => ({ ...capability }));
  }
}

/**
 * An empty registry. The server fills it from the tool definitions it really
 * loads (`syncTools`), so the manifest lists only tools that exist.
 */
export function createBaseCapabilityRegistry(): CapabilityRegistry {
  return new CapabilityRegistry({ allowBootstrapMetadata: true });
}
