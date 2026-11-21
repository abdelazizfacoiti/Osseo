import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { clearActiveTaskApproval } from "./confirmations.js";
import { stripBom } from "./text.js";

export type AgentTaskStatus = "active" | "paused" | "completed" | "cancelled";
export type AgentTaskEventKind = "progress" | "observation" | "error" | "recovery" | "verification" | "note";

export interface AgentTaskEvent {
  at: string;
  kind: AgentTaskEventKind;
  summary: string;
}

export interface AgentTask {
  taskId: string;
  goal: string;
  /** Observable criteria that must all be verified before the task is done. */
  definitionOfDone?: string[];
  status: AgentTaskStatus;
  phase: string;
  currentAction: string;
  events: AgentTaskEvent[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
}

export type TaskErrorCode =
  | "task_not_found"
  | "invalid_task_id"
  | "task_terminal"
  | "task_invalid_transition"
  | "task_store_failed";

export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}

export function isValidTaskId(taskId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(taskId) && taskId !== "." && taskId !== "..";
}

function tasksDir(osseoDir: string): string {
  return path.join(osseoDir, "tasks");
}

function taskPath(osseoDir: string, taskId: string): string {
  if (!isValidTaskId(taskId)) throw new TaskError("invalid_task_id", "Task ID is invalid.");
  return path.join(tasksDir(osseoDir), `${taskId}.json`);
}

function log(task: AgentTask, kind: AgentTaskEventKind, summary: string): void {
  task.events.push({ at: new Date().toISOString(), kind, summary: summary.slice(0, 500) });
  task.events = task.events.slice(-200);
  task.updatedAt = new Date().toISOString();
}

function isTerminal(status: AgentTaskStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export async function loadTask(osseoDir: string, taskId: string): Promise<AgentTask | undefined> {
  try {
    return JSON.parse(stripBom(await readFile(taskPath(osseoDir, taskId), "utf8"))) as AgentTask;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof TaskError) throw error;
    return undefined;
  }
}

export async function saveTask(osseoDir: string, task: AgentTask): Promise<void> {
  const directory = tasksDir(osseoDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = taskPath(osseoDir, task.taskId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function createTask(osseoDir: string, goal: string, definitionOfDone: string[] = []): Promise<AgentTask> {
  const now = new Date().toISOString();
  const criteria = [...new Set(definitionOfDone.map((item) => item.trim()).filter((item) => item.length > 0))].slice(0, 12).map((item) => item.slice(0, 300));
  const task: AgentTask = {
    taskId: `task_${randomUUID()}`,
    goal,
    ...(criteria.length === 0 ? {} : { definitionOfDone: criteria }),
    status: "active",
    phase: "understand",
    currentAction: "inspect environment",
    events: [],
    createdAt: now,
    updatedAt: now
  };
  log(task, "note", `Task created: ${goal.slice(0, 200)}`);
  if (criteria.length > 0) log(task, "note", `Definition of done (${criteria.length}): ${criteria.join("; ")}`);
  await clearActiveTaskApproval(osseoDir);
  await saveTask(osseoDir, task);
  return task;
}

export async function listTasks(osseoDir: string): Promise<AgentTask[]> {
  let files: string[] = [];
  try {
    files = await readdir(tasksDir(osseoDir));
  } catch {
    return [];
  }
  const tasks: AgentTask[] = [];
  for (const file of files.filter((entry) => entry.endsWith(".json"))) {
    const task = await loadTask(osseoDir, file.slice(0, -5));
    if (task !== undefined) tasks.push(task);
  }
  return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function updateTask(
  osseoDir: string,
  taskId: string,
  patch: { phase?: string; currentAction?: string }
): Promise<AgentTask> {
  const task = await loadTask(osseoDir, taskId);
  if (task === undefined) throw new TaskError("task_not_found", "Task was not found.");
  if (isTerminal(task.status)) throw new TaskError("task_terminal", "Task is terminal and can no longer be updated.");
  if (patch.phase !== undefined) task.phase = patch.phase;
  if (patch.currentAction !== undefined) task.currentAction = patch.currentAction;
  log(task, "progress", `Phase: ${task.phase}; action: ${task.currentAction}`);
  await saveTask(osseoDir, task);
  return task;
}

export async function appendTaskEvent(
  osseoDir: string,
  taskId: string,
  kind: AgentTaskEventKind,
  summary: string
): Promise<AgentTask> {
  const task = await loadTask(osseoDir, taskId);
  if (task === undefined) throw new TaskError("task_not_found", "Task was not found.");
  if (isTerminal(task.status)) throw new TaskError("task_terminal", "Task is terminal and can no longer receive events.");
  log(task, kind, summary);
  await saveTask(osseoDir, task);
  return task;
}

export async function transitionTask(
  osseoDir: string,
  taskId: string,
  target: "paused" | "active" | "completed" | "cancelled"
): Promise<AgentTask> {
  const task = await loadTask(osseoDir, taskId);
  if (task === undefined) throw new TaskError("task_not_found", "Task was not found.");
  if (task.status === target) return task;
  if (isTerminal(task.status)) throw new TaskError("task_terminal", "Task is terminal and can no longer change state.");

  if (target === "paused" && task.status !== "active") {
    throw new TaskError("task_invalid_transition", "Only an active task can be paused.");
  }
  if (target === "active" && task.status !== "paused") {
    throw new TaskError("task_invalid_transition", "Only a paused task can be resumed.");
  }

  task.status = target;
  if (target === "completed") task.completedAt = new Date().toISOString();
  if (target === "cancelled") task.cancelledAt = new Date().toISOString();
  log(task, target === "cancelled" ? "note" : "progress", `Task state changed to ${target}.`);
  await saveTask(osseoDir, task);
  if (isTerminal(target)) await clearActiveTaskApproval(osseoDir);
  return task;
}
