import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "@osseo/core";
import type { OsseoMcpContext } from "./context.js";
import { recallView } from "./view-registry.js";

/*
 * The session journal: what the agent did through the numbered actions, kept so the person can
 * turn it into a saved workflow ("save what you just did"). One file per session under
 * <agentHome>/journal. It holds roles and names of elements, never typed text (only its length),
 * never a sensitive field. Saving a workflow is the person's decision and is done from the CLI.
 */

export const JOURNAL_STEP_CAP = 200;
export const JOURNAL_MAX_AGE_DAYS = 7;
export const TEXT_PARAMETER_DESCRIPTION = "Text typed during the recorded task; enter it when you run the workflow.";
const WORKFLOW_STEP_LIMIT = 20;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type JournalTool = "click" | "type" | "key";

export interface JournalStep {
  at: string;
  tool: JournalTool;
  number: number | null;
  role: string;
  name: string;
  inputKind: JournalTool;
  /** Type steps only: the parameter that stands for the typed text. The text itself is never kept. */
  param?: string;
  textLength?: number;
  ok: boolean;
}

export interface Journal {
  version: 1;
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  steps: JournalStep[];
  /** Steps left out because the target was sensitive, had no name, or a key could be typed text. */
  skipped: number;
  truncated: boolean;
  /** Type steps seen in this session, also those dropped by the cap, so text_<k> never repeats. */
  typeCount: number;
}

export interface StepInput {
  tool: JournalTool;
  number?: number | undefined;
  role: string;
  name: string;
  blocked?: boolean | undefined;
  textLength?: number | undefined;
  ok: boolean;
}

export class JournalError extends Error {
  readonly code: "journal_name_invalid" | "journal_empty" | "journal_too_long";
  constructor(code: JournalError["code"], message: string) {
    super(message);
    this.name = "JournalError";
    this.code = code;
  }
}

function safeId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "session_unknown";
}

export function journalDir(agentHome: string): string { return path.join(agentHome, "journal"); }
function journalPath(agentHome: string, sessionId: string): string { return path.join(journalDir(agentHome), `${safeId(sessionId)}.json`); }

export async function readJournal(agentHome: string, sessionId: string): Promise<Journal | undefined> {
  try {
    const value = JSON.parse(await readFile(journalPath(agentHome, sessionId), "utf8")) as Journal;
    return value.version === 1 && Array.isArray(value.steps) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Session ids that have a journal, newest file first. */
export async function listJournals(agentHome: string): Promise<Array<{ sessionId: string; updatedAt: string; steps: number }>> {
  let files: string[] = [];
  try { files = await readdir(journalDir(agentHome)); } catch { return []; }
  const found: Array<{ sessionId: string; updatedAt: string; steps: number; time: number }> = [];
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const id = file.slice(0, -5);
    const journal = await readJournal(agentHome, id);
    if (journal === undefined) continue;
    const info = await stat(path.join(journalDir(agentHome), file)).catch(() => undefined);
    found.push({ sessionId: id, updatedAt: journal.updatedAt, steps: journal.steps.length, time: info?.mtimeMs ?? 0 });
  }
  return found.sort((a, b) => b.time - a.time || b.updatedAt.localeCompare(a.updatedAt)).map(({ time: _time, ...rest }) => rest);
}

/** Removes journal files not touched for `maxAgeDays` days. Returns how many were removed. */
export async function pruneJournals(agentHome: string, options: { maxAgeDays?: number; now?: number } = {}): Promise<number> {
  const limit = (options.maxAgeDays ?? JOURNAL_MAX_AGE_DAYS) * 86_400_000;
  const now = options.now ?? Date.now();
  let files: string[] = [];
  try { files = await readdir(journalDir(agentHome)); } catch { return 0; }
  let removed = 0;
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const full = path.join(journalDir(agentHome), file);
    const info = await stat(full).catch(() => undefined);
    if (info !== undefined && now - info.mtimeMs > limit) {
      await rm(full, { force: true });
      removed += 1;
    }
  }
  return removed;
}

async function writeJournal(agentHome: string, journal: Journal): Promise<void> {
  const directory = journalDir(agentHome);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = journalPath(agentHome, journal.sessionId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

function looksSensitive(step: StepInput): boolean {
  if (step.blocked === true) return true;
  if (/password|passcode|otp|card|secret/i.test(step.role)) return true;
  return redactSensitiveText(step.name) !== step.name;
}

/** Appends one step to this session's journal. Throws on a write failure: callers must catch. */
export async function recordStep(context: Pick<OsseoMcpContext, "sessionId" | "config">, step: StepInput, now = new Date()): Promise<{ recorded: boolean }> {
  const agentHome = context.config.osseoDir;
  const sessionId = context.sessionId;
  const existing = await readJournal(agentHome, sessionId);
  const iso = now.toISOString();
  const journal: Journal = existing ?? { version: 1, sessionId: safeId(sessionId), startedAt: iso, updatedAt: iso, steps: [], skipped: 0, truncated: false, typeCount: 0 };
  if (existing === undefined) await pruneJournals(agentHome).catch(() => 0);
  const name = step.name.trim().slice(0, 120);
  const replayable = step.tool === "key" ? name.length > 0 && name.replace(/\+/g, "").length > 1 : step.number !== undefined && name.length > 0;
  if (looksSensitive(step) || !replayable) {
    journal.skipped += 1;
    journal.updatedAt = iso;
    await writeJournal(agentHome, journal);
    return { recorded: false };
  }
  let param: string | undefined;
  let textLength: number | undefined;
  if (step.tool === "type") {
    journal.typeCount += 1;
    param = `text_${journal.typeCount}`;
    textLength = step.textLength ?? 0;
  }
  journal.steps.push({
    at: iso,
    tool: step.tool,
    number: step.number ?? null,
    role: step.role.slice(0, 80),
    name,
    inputKind: step.tool,
    ...(param === undefined ? {} : { param }),
    ...(textLength === undefined ? {} : { textLength }),
    ok: step.ok
  });
  if (journal.steps.length > JOURNAL_STEP_CAP) {
    journal.steps = journal.steps.slice(journal.steps.length - JOURNAL_STEP_CAP);
    journal.truncated = true;
  }
  journal.updatedAt = iso;
  await writeJournal(agentHome, journal);
  return { recorded: true };
}

/**
 * Called by the numbered actions after a call. Records only a real, successful click, type or key
 * (not a preview or a refusal), reading the element's role and name from the stored view.
 */
export async function recordNumbered(context: OsseoMcpContext, tool: string, input: Record<string, unknown>, result: { ok: boolean; preview?: boolean | undefined }): Promise<void> {
  if (!result.ok || result.preview === true || input.dryRun === true) return;
  if (tool !== "click" && tool !== "type" && tool !== "key") return;
  if (tool === "key") {
    const keys = typeof input.keys === "string" ? [input.keys] : Array.isArray(input.keys) ? input.keys.map(String) : [];
    await recordStep(context, { tool, role: "keys", name: keys.join("+"), ok: true });
    return;
  }
  const number = typeof input.n === "number" ? input.n : undefined;
  const view = number === undefined ? undefined : recallView(typeof input.view === "string" ? input.view : undefined);
  const target = number === undefined ? undefined : view?.targets.get(number);
  await recordStep(context, {
    tool,
    number,
    role: target?.role ?? "",
    name: target?.name ?? "",
    blocked: target?.blocked === true,
    ...(tool === "type" ? { textLength: typeof input.text === "string" ? input.text.length : 0 } : {}),
    ok: true
  });
}

export interface WorkflowDraft {
  name: string;
  description: string;
  parameters: Array<{ name: string; description: string; required: true }>;
  steps: Array<{ tool: string; input: Record<string, unknown> }>;
  /** One line per step for the reviewer: the numbered action and the element it acted on. */
  review: Array<{ step: number; tool: string; target: string }>;
}

export function isValidJournalWorkflowName(name: string): boolean { return NAME.test(name); }

/** Builds the workflow record from a journal. Typed text is never in it: only `{{text_<k>}}` placeholders. */
export function journalToWorkflow(journal: Journal, options: { name: string; description?: string; last?: number }): WorkflowDraft {
  if (!NAME.test(options.name)) throw new JournalError("journal_name_invalid", "Workflow names are 1-64 characters of a-z, 0-9, ., _ or -, starting with a letter or digit.");
  if (journal.steps.length === 0) throw new JournalError("journal_empty", "Nothing was recorded in this session.");
  let chosen = journal.steps;
  if (options.last !== undefined) chosen = chosen.slice(Math.max(0, chosen.length - options.last));
  if (chosen.length > WORKFLOW_STEP_LIMIT) throw new JournalError("journal_too_long", `A workflow has at most ${WORKFLOW_STEP_LIMIT} steps and this session has ${chosen.length}. Pass --last ${WORKFLOW_STEP_LIMIT} (or fewer) to keep the final steps.`);
  const parameters: WorkflowDraft["parameters"] = [];
  const steps: WorkflowDraft["steps"] = [];
  const review: WorkflowDraft["review"] = [];
  for (const [index, step] of chosen.entries()) {
    if (step.tool === "type") {
      const param = step.param ?? `text_${index + 1}`;
      parameters.push({ name: param, description: TEXT_PARAMETER_DESCRIPTION, required: true });
      steps.push({ tool: "desktop.set_field", input: { label: step.name, ...(step.role === "" ? {} : { role: step.role }), text: `{{${param}}}` } });
    } else if (step.tool === "key") {
      steps.push({ tool: "desktop.hotkey", input: { keys: step.name.split("+") } });
    } else {
      steps.push({ tool: "desktop.click", input: { label: step.name, ...(step.role === "" ? {} : { role: step.role }) } });
    }
    review.push({ step: index + 1, tool: step.tool, target: step.tool === "key" ? step.name : `${step.role} ${step.name}`.trim() });
  }
  return {
    name: options.name,
    description: (options.description ?? `Recorded from session ${journal.sessionId}: ${steps.length} steps.`).slice(0, 300),
    parameters,
    steps,
    review
  };
}
