import { pathToFileURL } from "node:url";
import { isValidWorkflowName, loadOsseoConfig, loadWorkflow, expandWorkflow, redactSensitiveText, WorkflowError } from "@osseo/core";

/*
 * Running a saved workflow without an agent, and scheduling it. A run goes
 * through the real computer.run_steps tool in a fresh MCP server context, so
 * every safety gate applies. It never approves anything on its own: the first
 * step that needs an exact confirmation stops the run (exit code 2) and the
 * person is notified. Stop, pause, and takeover flags halt it like any call.
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_NEEDS_APPROVAL = 2;
export const EXIT_HALTED = 3;

/** Repeated `--param key=value` (or `--param=key=value`) arguments. */
export function parseParams(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    let spec: string | undefined;
    if (item === "--param") spec = argv[index + 1];
    else if (item.startsWith("--param=")) spec = item.slice("--param=".length);
    if (spec === undefined) continue;
    const equals = spec.indexOf("=");
    if (equals < 1) throw new Error(`parameter_invalid:${spec.slice(0, 40)}`);
    const key = spec.slice(0, equals);
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) throw new Error(`parameter_name_invalid:${key.slice(0, 40)}`);
    values[key] = spec.slice(equals + 1).slice(0, 2_000);
  }
  return values;
}

export type ScheduleSpec =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "every"; minutes: number };

export function parseSchedule(values: Map<string, string>): ScheduleSpec {
  const time = (raw: string): string => {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw);
    if (match === null) throw new Error("schedule_time_invalid: use HH:MM (24h)");
    return `${match[1]!.padStart(2, "0")}:${match[2]}`;
  };
  const chosen = ["daily", "weekdays", "every"].filter((key) => values.has(key));
  if (chosen.length !== 1) throw new Error("schedule_required: pass exactly one of --daily HH:MM, --weekdays HH:MM, --every 30m|2h");
  if (values.has("daily")) return { kind: "daily", time: time(values.get("daily")!) };
  if (values.has("weekdays")) return { kind: "weekdays", time: time(values.get("weekdays")!) };
  const every = /^(\d{1,4})([mh])$/.exec(values.get("every")!);
  if (every === null) throw new Error("schedule_interval_invalid: use 30m or 2h");
  const minutes = Number(every[1]) * (every[2] === "h" ? 60 : 1);
  if (minutes < 5 || minutes > 7 * 24 * 60) throw new Error("schedule_interval_invalid: between 5 minutes and 7 days");
  return { kind: "every", minutes };
}

/** systemd ExecStart quoting: double quotes, with backslash, quote, `%`, and `$` escaped. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%").replaceAll("$", "$$$$")}"`;
}

export function scheduleUnitName(workflow: string): string { return `osseo-wf-${workflow}`; }

export interface UnitInput {
  workflow: string;
  schedule: ScheduleSpec;
  params: Record<string, string>;
  nodePath: string;
  cliPath: string;
  agentHome: string;
  environment: Record<string, string | undefined>;
}

export function buildScheduleUnits(input: UnitInput): { service: string; timer: string; unit: string } {
  if (!isValidWorkflowName(input.workflow)) throw new Error("workflow_name_invalid");
  for (const [key, value] of Object.entries(input.params)) {
    // Parameters sit in a plain-text unit file, so they must not be secrets.
    if (redactSensitiveText(`${key}=${value}`) !== `${key}=${value}`) throw new Error(`parameter_looks_secret:${key}`);
  }
  const unit = scheduleUnitName(input.workflow);
  const exec = [input.nodePath, input.cliPath, "workflow", "run", input.workflow, "--unattended", ...Object.entries(input.params).flatMap(([key, value]) => ["--param", `${key}=${value}`])].map(quote).join(" ");
  const env = ["DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "OSSEO_HOME", "OSSEO_CONFIG"]
    .map((key) => [key, key === "OSSEO_HOME" ? input.agentHome : input.environment[key]] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== undefined && entry[1] !== "" && !/[\n\r]/.test(entry[1]))
    .map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`);
  const service = [
    "[Unit]",
    `Description=Osseo saved workflow ${input.workflow}`,
    "",
    "[Service]",
    "Type=oneshot",
    ...env,
    `ExecStart=${exec}`,
    ""
  ].join("\n");
  const when = input.schedule.kind === "every"
    ? [`OnBootSec=5min`, `OnUnitActiveSec=${input.schedule.minutes}min`]
    : [`OnCalendar=${input.schedule.kind === "weekdays" ? "Mon..Fri " : ""}*-*-* ${input.schedule.time}:00`, "Persistent=false"];
  const timer = ["[Unit]", `Description=Schedule for Osseo workflow ${input.workflow}`, "", "[Timer]", ...when, "", "[Install]", "WantedBy=timers.target", ""].join("\n");
  return { service, timer, unit };
}

export interface WorkflowRunSummary {
  status: "completed" | "needs_approval" | "halted" | "failed";
  workflow: string;
  code?: string;
  message?: string;
  steps?: number;
}

export function exitCodeFor(status: WorkflowRunSummary["status"]): number {
  return status === "completed" ? EXIT_OK : status === "needs_approval" ? EXIT_NEEDS_APPROVAL : status === "halted" ? EXIT_HALTED : EXIT_FAILED;
}

const HALT_CODES = new Set(["emergency_stop_requested", "human_takeover_active", "pause_requested", "handoff_active", "user_active"]);

export function summarizeRun(workflow: string, steps: number, result: { ok: boolean; error?: { code?: string; message?: string } | null }): WorkflowRunSummary {
  if (result.ok) return { status: "completed", workflow, steps };
  const code = result.error?.code ?? "failed";
  const message = (result.error?.message ?? "The workflow did not complete.").slice(0, 300);
  if (code === "confirmation_required" || code === "approval_required") return { status: "needs_approval", workflow, code, message, steps };
  if (HALT_CODES.has(code)) return { status: "halted", workflow, code, message, steps };
  return { status: "failed", workflow, code, message, steps };
}

export async function runSavedWorkflow(input: { agentHome: string; mcpEntry: string; name: string; params: Record<string, string> }): Promise<WorkflowRunSummary> {
  const workflow = await loadWorkflow(input.agentHome, input.name);
  if (workflow === undefined) return { status: "failed", workflow: input.name, code: "workflow_not_found", message: `No saved workflow named ${input.name}.` };
  let steps;
  try {
    steps = expandWorkflow(workflow, input.params);
  } catch (error) {
    return { status: "failed", workflow: input.name, code: error instanceof WorkflowError ? error.code : "workflow_invalid", message: error instanceof Error ? error.message : "Parameters do not match." };
  }
  const server = await import(pathToFileURL(input.mcpEntry).href) as {
    createOsseoMcpServer: (options: { config: unknown }) => Promise<{ context: { tools?: Map<string, unknown> }; closeResources: () => Promise<void> }>;
    runTool: (tool: unknown, input: unknown, context: unknown) => Promise<{ ok: boolean; error?: { code?: string; message?: string } | null }>;
  };
  // An unattended run must never offer to install system packages.
  const config = { ...(await loadOsseoConfig({ env: process.env })), autoInstallDependencies: false };
  const { context, closeResources } = await server.createOsseoMcpServer({ config });
  try {
    const tool = context.tools?.get("computer.run_steps");
    if (tool === undefined) return { status: "failed", workflow: input.name, code: "plan_unavailable", message: "computer.run_steps is not available." };
    const result = await server.runTool(tool, { steps, stopOnError: true }, context);
    return summarizeRun(input.name, steps.length, result);
  } finally {
    await closeResources().catch(() => undefined);
  }
}
