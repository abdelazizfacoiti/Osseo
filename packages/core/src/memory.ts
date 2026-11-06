import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSensitiveText } from "./safety/redaction.js";

/*
 * Agent memory: short lessons that outlast a session ("Settings opens slowly;
 * wait for the title before clicking"). It deliberately cannot hold task
 * content: entries are capped at one or two sentences and anything that looks
 * like a secret is refused. A lesson can originate from a hostile page, so
 * reads are marked untrusted, and the operator can list and erase everything
 * from the CLI.
 */

export const MAX_MEMORY_ENTRIES = 200;
export const MAX_LESSON_CHARS = 300;
const TOPIC = /^[a-z0-9][a-z0-9._-]{1,59}$/;

export interface MemoryEntry { id: string; topic: string; lesson: string; createdAt: string }

export class MemoryError extends Error {
  readonly code: "memory_invalid" | "memory_not_found" | "memory_limit";
  constructor(code: MemoryError["code"], message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

function memoryPath(agentHostDir: string): string { return path.join(agentHostDir, "memory", "lessons.json"); }

export async function listMemory(agentHostDir: string): Promise<MemoryEntry[]> {
  try {
    const value = JSON.parse(await readFile(memoryPath(agentHostDir), "utf8")) as { entries?: MemoryEntry[] };
    return Array.isArray(value.entries) ? value.entries : [];
  } catch {
    return [];
  }
}

async function write(agentHostDir: string, entries: MemoryEntry[]): Promise<void> {
  const target = memoryPath(agentHostDir);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(target), 0o700);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function saveMemory(agentHostDir: string, input: { topic: string; lesson: string }): Promise<MemoryEntry> {
  const topic = input.topic.trim().toLowerCase();
  const lesson = input.lesson.trim().replace(/\s+/g, " ");
  if (!TOPIC.test(topic)) throw new MemoryError("memory_invalid", "Topics are 2-60 characters of a-z, 0-9, . _ or -, such as an app name.");
  if (lesson.length < 5 || lesson.length > MAX_LESSON_CHARS) throw new MemoryError("memory_invalid", `A lesson is 5-${MAX_LESSON_CHARS} characters: how to work, not what the task contained.`);
  if (redactSensitiveText(lesson) !== lesson) throw new MemoryError("memory_invalid", "That looks like it contains a secret. Lessons must not hold secrets.");
  const entries = await listMemory(agentHostDir);
  const existing = entries.find((entry) => entry.topic === topic && entry.lesson.toLowerCase() === lesson.toLowerCase());
  if (existing !== undefined) return existing;
  if (entries.length >= MAX_MEMORY_ENTRIES) throw new MemoryError("memory_limit", `At most ${MAX_MEMORY_ENTRIES} lessons are kept. Delete one first.`);
  const entry: MemoryEntry = { id: `mem_${randomUUID().slice(0, 8)}`, topic, lesson, createdAt: new Date().toISOString() };
  await write(agentHostDir, [...entries, entry]);
  return entry;
}

export async function searchMemory(agentHostDir: string, input: { query?: string; topic?: string; limit?: number }): Promise<MemoryEntry[]> {
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  const topic = input.topic?.trim().toLowerCase();
  return (await listMemory(agentHostDir))
    .filter((entry) => topic === undefined || entry.topic === topic)
    .filter((entry) => words.length === 0 || words.some((word) => `${entry.topic} ${entry.lesson}`.toLowerCase().includes(word)))
    .reverse()
    .slice(0, Math.max(1, Math.min(50, input.limit ?? 20)));
}

export async function deleteMemory(agentHostDir: string, id: string): Promise<void> {
  const entries = await listMemory(agentHostDir);
  if (!entries.some((entry) => entry.id === id)) throw new MemoryError("memory_not_found", `No lesson ${id.slice(0, 40)}.`);
  await write(agentHostDir, entries.filter((entry) => entry.id !== id));
}

export async function clearMemory(agentHostDir: string): Promise<void> {
  await rm(memoryPath(agentHostDir), { force: true });
}
