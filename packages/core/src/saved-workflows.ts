import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "./safety/redaction.js";

/*
 * Saved workflows: a plan the agent already ran successfully, stored with named
 * parameters so it can be recalled instead of re-derived. A workflow is only
 * data. Running one means handing its expanded steps to `computer.run_steps`,
 * so approval, per-step safety, stop/takeover, and audit apply exactly as for a
 * fresh plan. Nothing here executes anything.
 */

export const MAX_WORKFLOWS = 100;
export const MAX_WORKFLOW_STEPS = 20;
const WORKFLOW_NAME = /^[a-z0-9][a-z0-9_-]{1,48}$/;
const PARAMETER_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}/g;
const BANNED_TOOL_PREFIXES = ["agent.", "task.", "workflow.", "computer.run_steps"];

export interface WorkflowParameter { name: string; description?: string }
export interface WorkflowStep { tool: string; input?: Record<string, unknown> }
export interface SavedWorkflow {
  version: 1;
  name: string;
  description: string;
  parameters: WorkflowParameter[];
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  uses: number;
  lastUsedAt?: string;
}

export class WorkflowError extends Error {
  readonly code: "workflow_invalid" | "workflow_not_found" | "workflow_limit" | "workflow_parameters";
  readonly details?: Record<string, unknown>;
  constructor(code: WorkflowError["code"], message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isValidWorkflowName(name: string): boolean {
  return WORKFLOW_NAME.test(name);
}

function workflowsDir(agentHostDir: string): string { return path.join(agentHostDir, "workflows"); }

function workflowPath(agentHostDir: string, name: string): string {
  if (!isValidWorkflowName(name)) throw new WorkflowError("workflow_invalid", "Workflow names are 2-49 characters of a-z, 0-9, _ or -.");
  return path.join(workflowsDir(agentHostDir), `${name}.json`);
}

function collectPlaceholders(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(PLACEHOLDER)) found.add(match[1]!);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectPlaceholders(entry, found);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) collectPlaceholders(entry, found);
  }
}

function substitute(value: unknown, parameters: Record<string, string>): unknown {
  if (typeof value === "string") return value.replace(PLACEHOLDER, (_match, name: string) => parameters[name] ?? "");
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, parameters));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, substitute(entry, parameters)]));
  }
  return value;
}

/** Throws WorkflowError when a workflow definition is unsafe to store. */
export function validateWorkflowDefinition(input: { name: string; parameters: WorkflowParameter[]; steps: WorkflowStep[]; knownTools?: ReadonlySet<string> }): void {
  if (!isValidWorkflowName(input.name)) throw new WorkflowError("workflow_invalid", "Workflow names are 2-49 characters of a-z, 0-9, _ or -.");
  if (input.steps.length < 1 || input.steps.length > MAX_WORKFLOW_STEPS) throw new WorkflowError("workflow_invalid", `A workflow has 1-${MAX_WORKFLOW_STEPS} steps.`);
  const declared = new Set<string>();
  for (const parameter of input.parameters) {
    if (!PARAMETER_NAME.test(parameter.name) || declared.has(parameter.name)) throw new WorkflowError("workflow_invalid", `Parameter name "${parameter.name.slice(0, 40)}" is invalid or repeated.`);
    declared.add(parameter.name);
  }
  const used = new Set<string>();
  for (const [index, step] of input.steps.entries()) {
    if (BANNED_TOOL_PREFIXES.some((prefix) => step.tool.startsWith(prefix))) throw new WorkflowError("workflow_invalid", `Step ${index + 1}: ${step.tool} cannot be part of a saved workflow.`);
    if (input.knownTools !== undefined && !input.knownTools.has(step.tool)) throw new WorkflowError("workflow_invalid", `Step ${index + 1}: unknown tool ${step.tool.slice(0, 60)}.`);
    const serialized = JSON.stringify(step.input ?? {});
    // Secrets belong in parameters supplied at run time, never in a stored plan.
    if (redactSensitiveText(serialized) !== serialized) throw new WorkflowError("workflow_invalid", `Step ${index + 1} contains what looks like a secret. Use a parameter instead.`);
    collectPlaceholders(step.input ?? {}, used);
  }
  const undeclared = [...used].filter((name) => !declared.has(name));
  if (undeclared.length > 0) throw new WorkflowError("workflow_invalid", `Placeholders without a declared parameter: ${undeclared.join(", ")}.`);
  const unused = [...declared].filter((name) => !used.has(name));
  if (unused.length > 0) throw new WorkflowError("workflow_invalid", `Declared parameters never used: ${unused.join(", ")}.`);
}

async function write(agentHostDir: string, workflow: SavedWorkflow): Promise<void> {
  const directory = workflowsDir(agentHostDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = workflowPath(agentHostDir, workflow.name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(workflow, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function loadWorkflow(agentHostDir: string, name: string): Promise<SavedWorkflow | undefined> {
  try {
    const value = JSON.parse(await readFile(workflowPath(agentHostDir, name), "utf8")) as SavedWorkflow;
    return value.version === 1 && value.name === name && Array.isArray(value.steps) ? value : undefined;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    return undefined;
  }
}

export async function listWorkflows(agentHostDir: string): Promise<SavedWorkflow[]> {
  let files: string[] = [];
  try { files = await readdir(workflowsDir(agentHostDir)); } catch { return []; }
  const result: SavedWorkflow[] = [];
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const workflow = await loadWorkflow(agentHostDir, file.slice(0, -5)).catch(() => undefined);
    if (workflow !== undefined) result.push(workflow);
  }
  return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveWorkflow(agentHostDir: string, input: { name: string; description: string; parameters: WorkflowParameter[]; steps: WorkflowStep[]; knownTools?: ReadonlySet<string> }): Promise<SavedWorkflow> {
  validateWorkflowDefinition(input);
  const existing = await loadWorkflow(agentHostDir, input.name);
  if (existing === undefined && (await listWorkflows(agentHostDir)).length >= MAX_WORKFLOWS) throw new WorkflowError("workflow_limit", `At most ${MAX_WORKFLOWS} workflows can be saved. Delete one first.`);
  const now = new Date().toISOString();
  const workflow: SavedWorkflow = {
    version: 1,
    name: input.name,
    description: input.description.slice(0, 300),
    parameters: input.parameters.map((parameter) => ({ name: parameter.name, ...(parameter.description === undefined ? {} : { description: parameter.description.slice(0, 200) }) })),
    steps: input.steps.map((step) => ({ tool: step.tool, ...(step.input === undefined ? {} : { input: step.input }) })),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    uses: existing?.uses ?? 0,
    ...(existing?.lastUsedAt === undefined ? {} : { lastUsedAt: existing.lastUsedAt })
  };
  await write(agentHostDir, workflow);
  return workflow;
}

export async function deleteWorkflow(agentHostDir: string, name: string): Promise<boolean> {
  const existing = await loadWorkflow(agentHostDir, name);
  if (existing === undefined) return false;
  await rm(workflowPath(agentHostDir, name), { force: true });
  return true;
}

/** Fills in parameters. Every declared parameter is required and unknown ones are refused. */
export function expandWorkflow(workflow: SavedWorkflow, values: Record<string, string>): WorkflowStep[] {
  const declared = new Set(workflow.parameters.map((parameter) => parameter.name));
  const missing = [...declared].filter((name) => values[name] === undefined);
  const unknown = Object.keys(values).filter((name) => !declared.has(name));
  if (missing.length > 0 || unknown.length > 0) {
    throw new WorkflowError("workflow_parameters", `Parameters do not match. ${missing.length > 0 ? `Missing: ${missing.join(", ")}. ` : ""}${unknown.length > 0 ? `Unknown: ${unknown.join(", ")}.` : ""}`.trim(), { missing, unknown });
  }
  return workflow.steps.map((step) => ({ tool: step.tool, ...(step.input === undefined ? {} : { input: substitute(step.input, values) as Record<string, unknown> }) }));
}

export async function noteWorkflowUsed(agentHostDir: string, name: string): Promise<void> {
  const workflow = await loadWorkflow(agentHostDir, name);
  if (workflow === undefined) return;
  await write(agentHostDir, { ...workflow, uses: workflow.uses + 1, lastUsedAt: new Date().toISOString() });
}
