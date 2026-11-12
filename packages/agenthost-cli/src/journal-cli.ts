import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadWorkflow, saveWorkflow, isValidWorkflowName } from "@agenthost/core";

/*
 * `agenthost journal show|save`: turn what the agent just did through the numbered actions into a
 * saved workflow. Saving is the person's decision, so it is CLI-only and previews unless --apply.
 * The journal holds element roles and names and the length of typed text, never the text.
 */

interface JournalStep { at: string; tool: string; number: number | null; role: string; name: string; inputKind: string; param?: string; textLength?: number; ok: boolean }
interface Journal { sessionId: string; startedAt: string; updatedAt: string; steps: JournalStep[]; skipped: number; truncated: boolean }
interface Draft {
  name: string; description: string;
  parameters: Array<{ name: string; description: string; required: true }>;
  steps: Array<{ tool: string; input: Record<string, unknown> }>;
  review: Array<{ step: number; tool: string; target: string }>;
}
export interface JournalApi {
  readJournal(agentHome: string, sessionId: string): Promise<Journal | undefined>;
  listJournals(agentHome: string): Promise<Array<{ sessionId: string; updatedAt: string; steps: number }>>;
  journalToWorkflow(journal: Journal, options: { name: string; description?: string; last?: number }): Draft;
}
export interface JournalDeps { load?: () => Promise<JournalApi>; mcpEntry?: string }

type Output = { ok: boolean; command: string; data?: unknown; error?: string };

function fail(command: string, error: string): Output { return { ok: false, command, error }; }

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index < 0 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

async function loadApi(deps: JournalDeps): Promise<JournalApi> {
  if (deps.load !== undefined) return deps.load();
  const entry = deps.mcpEntry ?? process.env.AGENTHOST_MCP_ENTRY;
  if (entry === undefined) throw new Error("mcp_entry_unknown");
  return await import(pathToFileURL(path.join(path.dirname(path.resolve(entry)), "journal.js")).href) as JournalApi;
}

function summarize(journal: Journal) {
  return {
    sessionId: journal.sessionId,
    updatedAt: journal.updatedAt,
    count: journal.steps.length,
    skipped: journal.skipped,
    truncated: journal.truncated,
    steps: journal.steps.map((step, index) => ({ step: index + 1, at: step.at, tool: step.tool, role: step.role, name: step.name, ...(step.param === undefined ? {} : { param: step.param, textLength: step.textLength ?? 0 }) }))
  };
}

export async function journalCommand(args: string[], agentHome: string, deps: JournalDeps = {}): Promise<Output> {
  const sub = args[0];
  if (sub !== "show" && sub !== "save") return fail("journal", "usage: agenthost journal show [--session <id>] | save <name> [--session <id>] [--last <n>] [--description <text>] [--apply]");
  const command = `journal ${sub}`;
  const api = await loadApi(deps);
  let sessionId = option(args, "session");
  if (sessionId === undefined) {
    sessionId = (await api.listJournals(agentHome))[0]?.sessionId;
    if (sessionId === undefined) return fail(command, "journal_not_found: nothing has been recorded yet");
  }
  const journal = await api.readJournal(agentHome, sessionId);
  if (journal === undefined) return fail(command, "journal_not_found");
  if (sub === "show") return { ok: true, command, data: summarize(journal) };

  const name = args[1] !== undefined && !args[1].startsWith("--") ? args[1] : undefined;
  if (name === undefined) return fail(command, "usage: agenthost journal save <name> [--session <id>] [--last <n>] [--description <text>] [--apply]");
  const lastRaw = option(args, "last");
  const last = lastRaw === undefined ? undefined : Number(lastRaw);
  if (last !== undefined && (!Number.isInteger(last) || last < 1)) return fail(command, "last_invalid");
  const description = option(args, "description");
  let draft: Draft;
  try {
    draft = api.journalToWorkflow(journal, { name, ...(description === undefined ? {} : { description }), ...(last === undefined ? {} : { last }) });
    if (!isValidWorkflowName(name)) return fail(command, "journal_name_invalid: saved workflow names are 2-49 characters of a-z, 0-9, _ or -");
  } catch (error) {
    const code = (error as { code?: string }).code ?? "journal_failed";
    return fail(command, `${code}: ${error instanceof Error ? error.message : ""}`.trim());
  }
  const preview = {
    name: draft.name,
    description: draft.description,
    parameters: draft.parameters.map((parameter) => ({ name: parameter.name, required: true, description: parameter.description })),
    steps: draft.steps,
    review: draft.review,
    run: `agenthost workflow run ${draft.name}${draft.parameters.map((parameter) => ` --param ${parameter.name}=...`).join("")}`
  };
  if (!args.includes("--apply")) return { ok: true, command, data: { preview: true, ...preview } };
  if (await loadWorkflow(agentHome, name) !== undefined) return fail(command, "workflow_exists: pick another name, or delete it with agenthost workflow delete");
  try {
    await saveWorkflow(agentHome, { name: draft.name, description: draft.description, parameters: draft.parameters, steps: draft.steps });
  } catch (error) {
    return fail(command, `${(error as { code?: string }).code ?? "workflow_invalid"}: ${error instanceof Error ? error.message : ""}`.trim());
  }
  return { ok: true, command, data: { preview: false, saved: draft.name, steps: draft.steps.length, parameters: draft.parameters.map((parameter) => parameter.name), run: preview.run } };
}
