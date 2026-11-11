import { redactSensitiveText } from "@agenthost/core";
import type { ScheduleSpec } from "./workflow.js";

/*
 * Saved workflows on a schedule through Windows Task Scheduler (schtasks.exe).
 * Everything here is pure: command lines are built as argument arrays, and the
 * process runner is passed in, so tests need no Windows. Tasks are per-user
 * (no /RU, no password, no elevation) and live in the task folder "AgentHost".
 * A task only runs while the person is logged on, which desktop work needs.
 */

export const WINDOWS_TASK_FOLDER = "AgentHost";
const TASK_PREFIX = "wf-";
/** schtasks refuses a /TR value longer than this many characters. */
export const MAX_TASK_RUN_LENGTH = 261;
const NAME = /^[A-Za-z0-9._-]{1,64}$/u;
const DAY_NAMES = "MON,TUE,WED,THU,FRI";

export function isValidWindowsTaskWorkflow(name: string): boolean {
  return NAME.test(name) && name !== "." && name !== "..";
}

export function windowsTaskName(workflow: string): string {
  if (!isValidWindowsTaskWorkflow(workflow)) throw new Error("workflow_name_invalid");
  return `${WINDOWS_TASK_FOLDER}\\${TASK_PREFIX}${workflow}`;
}

/** One argument of the command that the task runs. Rejects what cannot be quoted safely for a Windows command line. */
export function quoteTaskArgument(value: string): string {
  if (value === "" || /[\0\r\n"%^&|<>`]/u.test(value)) throw new Error("schedule_argument_unsupported");
  if (!/[ \t]/u.test(value)) return value;
  // Backslashes before the closing quote must be doubled.
  const trailing = /\\+$/u.exec(value)?.[0] ?? "";
  return `"${value}${trailing}"`;
}

export interface WindowsScheduleInput {
  workflow: string;
  schedule: ScheduleSpec;
  params: Record<string, string>;
  nodePath: string;
  cliPath: string;
}

export interface SchtasksCreate {
  taskName: string;
  /** What the task runs (the value of /TR). */
  taskRun: string;
  /** Arguments for schtasks.exe, with no shell in between. */
  args: string[];
}

function scheduleArguments(schedule: ScheduleSpec): string[] {
  if (schedule.kind === "daily") return ["/SC", "DAILY", "/ST", schedule.time];
  if (schedule.kind === "weekdays") return ["/SC", "WEEKLY", "/D", DAY_NAMES, "/ST", schedule.time];
  if (schedule.minutes <= 1439) return ["/SC", "MINUTE", "/MO", String(schedule.minutes)];
  if (schedule.minutes % 1440 === 0) return ["/SC", "DAILY", "/MO", String(schedule.minutes / 1440), "/ST", "00:00"];
  throw new Error("schedule_interval_invalid_for_windows: use up to 23h59m, or whole days");
}

export function buildSchtasksCreate(input: WindowsScheduleInput): SchtasksCreate {
  const taskName = windowsTaskName(input.workflow);
  for (const [key, value] of Object.entries(input.params)) {
    // The command line is stored in plain text by Task Scheduler, so parameters must not be secrets.
    if (redactSensitiveText(`${key}=${value}`) !== `${key}=${value}`) throw new Error(`parameter_looks_secret:${key}`);
  }
  const parts = [input.nodePath, input.cliPath, "workflow", "run", input.workflow, "--unattended", ...Object.entries(input.params).flatMap(([key, value]) => ["--param", `${key}=${value}`])];
  const taskRun = parts.map(quoteTaskArgument).join(" ");
  if (taskRun.length > MAX_TASK_RUN_LENGTH) throw new Error(`schedule_command_too_long: ${taskRun.length} characters, the limit is ${MAX_TASK_RUN_LENGTH}`);
  return { taskName, taskRun, args: ["/Create", "/TN", taskName, "/TR", taskRun, ...scheduleArguments(input.schedule), "/RL", "LIMITED", "/F"] };
}

export function schtasksDeleteArgs(workflow: string): string[] {
  return ["/Delete", "/TN", windowsTaskName(workflow), "/F"];
}

export function schtasksQueryArgs(): string[] {
  return ["/Query", "/FO", "CSV", "/NH"];
}

/** Workflow names of AgentHost tasks in `schtasks /Query /FO CSV /NH` output. */
export function parseSchtasksList(csv: string): string[] {
  const names = new Set<string>();
  for (const line of csv.split(/\r?\n/u)) {
    const match = /^"\\AgentHost\\wf-([A-Za-z0-9._-]{1,64})"/u.exec(line.trim());
    if (match !== null) names.add(match[1]!);
  }
  return [...names].sort();
}

export interface SchtasksRun {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type SchtasksRunner = (args: string[]) => SchtasksRun;

export type WindowsScheduleResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

function failure(run: SchtasksRun): string {
  return `schtasks_failed: ${(run.stderr || run.stdout || `exit ${String(run.status)}`).trim().slice(0, 200)}`;
}

export function windowsScheduleList(run: SchtasksRunner): WindowsScheduleResult {
  const result = run(schtasksQueryArgs());
  // schtasks exits 1 with "no scheduled tasks" style text when the store is empty; treat an empty listing as none.
  if (result.status !== 0 && result.stdout.trim() !== "") return { ok: false, error: failure(result) };
  return { ok: true, data: { timers: parseSchtasksList(result.stdout) } };
}

export function windowsScheduleAdd(input: WindowsScheduleInput, apply: boolean, run: SchtasksRunner): WindowsScheduleResult {
  let plan: SchtasksCreate;
  try {
    plan = buildSchtasksCreate(input);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "schedule_invalid" };
  }
  const note = "Re-run with --apply to install. A scheduled run never approves anything: it stops at the first step that needs approval and notifies you. The task runs only while you are logged on.";
  if (!apply) return { ok: true, data: { preview: true, task: plan.taskName, command: `schtasks.exe ${plan.args.map((arg) => (/[ \t"]/u.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`, runs: plan.taskRun, note } };
  const result = run(plan.args);
  if (result.status !== 0) return { ok: false, error: failure(result) };
  return { ok: true, data: { installed: plan.taskName } };
}

export function windowsScheduleRemove(workflow: string, apply: boolean, run: SchtasksRunner): WindowsScheduleResult {
  if (!isValidWindowsTaskWorkflow(workflow)) return { ok: false, error: "workflow_name_invalid" };
  const taskName = windowsTaskName(workflow);
  if (!apply) return { ok: true, data: { preview: true, wouldRemove: [taskName], note: "Re-run with --apply to remove." } };
  const result = run(schtasksDeleteArgs(workflow));
  if (result.status !== 0) return { ok: false, error: failure(result) };
  return { ok: true, data: { removed: taskName } };
}
