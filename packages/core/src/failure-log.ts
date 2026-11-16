import { readFile, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendJsonl, summarizeForLog } from "./logging.js";

/*
 * Development failure log: one JSONL line per tool call that failed for a reason worth fixing, written by the
 * server in every session next to the audit log (`~/.agenthost/logs/failures.jsonl`). It is for the people who
 * build AgentHost: read it with `agenthost failures`, then fix the most frequent reasons first.
 *
 * Only redacted, allowlisted fields are stored: the audit input summary, the error code and message, the tool,
 * the build and the platform. Never typed text, screenshots, or file contents.
 */

export const FAILURE_LOG_NAME = "failures.jsonl";
export const FAILURE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const MESSAGE_LIMIT = 300;

/** Results that are the safety model working as designed, not something to fix. */
const EXPECTED_CODES = new Set([
  "confirmation_required",
  "confirmation_not_approved",
  "confirmation_token_rejected",
  "confirmation_token_expired",
  "confirmation_token_not_found",
  "confirmation_token_used",
  "pause_requested",
  "emergency_stop_requested",
  "human_takeover_active",
  "user_active"
]);

export interface FailureEntry {
  timestamp: string;
  sessionId: string;
  tool: string;
  errorCode: string;
  message: string;
  inputSummary: string;
  riskLevel: string;
  durationMs: number;
  platform: string;
  serverVersion?: string;
  placement?: string;
  /** First observation the tool returned, when it names a next step. */
  hint?: string;
}

export interface FailureGroup {
  tool: string;
  errorCode: string;
  count: number;
  sessions: number;
  firstSeen: string;
  lastSeen: string;
  sampleMessage: string;
  sampleInput: string;
}

export interface FailureRecorder {
  record(entry: FailureEntry): Promise<void>;
}

export function failureLogPath(logFile: string): string {
  return path.join(path.dirname(logFile), FAILURE_LOG_NAME);
}

/** True when a failed call belongs in the development log. */
export function isDevFailure(errorCode: string | undefined): boolean {
  return errorCode !== undefined && errorCode.length > 0 && !EXPECTED_CODES.has(errorCode);
}

/** The person's home directory becomes `~`, so the log shows paths without naming the account. */
function tidy(text: string): string {
  const home = os.homedir();
  const shortened = home.length > 1 ? text.split(home).join("~") : text;
  return summarizeForLog(shortened).slice(0, MESSAGE_LIMIT);
}

export function buildFailureEntry(input: Omit<FailureEntry, "message" | "hint" | "timestamp"> & { timestamp?: string; message: string; hint?: string }): FailureEntry {
  const { hint, message, timestamp, ...rest } = input;
  return {
    timestamp: timestamp ?? new Date().toISOString(),
    ...rest,
    message: tidy(message),
    ...(hint === undefined || hint.length === 0 ? {} : { hint: tidy(hint) })
  };
}

export class JsonlFailureLog implements FailureRecorder {
  constructor(readonly file: string, private readonly maxBytes: number = FAILURE_LOG_MAX_BYTES) {}

  async record(entry: FailureEntry): Promise<void> {
    await this.rotateIfLarge();
    await appendJsonl(this.file, entry);
  }

  /** Keeps one older file (`failures.1.jsonl`), so the log never grows without bound. */
  private async rotateIfLarge(): Promise<void> {
    try {
      const size = (await stat(this.file)).size;
      if (size >= this.maxBytes) await rename(this.file, this.file.replace(/\.jsonl$/, ".1.jsonl"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** Newest last. Lines that are not valid entries are skipped, so a torn write never breaks reading. */
export async function readFailures(file: string, options: { since?: string; limit?: number } = {}): Promise<FailureEntry[]> {
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: FailureEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Partial<FailureEntry>;
      if (typeof parsed.tool === "string" && typeof parsed.errorCode === "string" && typeof parsed.timestamp === "string") {
        if (options.since !== undefined && parsed.timestamp < options.since) continue;
        entries.push(parsed as FailureEntry);
      }
    } catch {
      /* skip a torn or foreign line */
    }
  }
  return options.limit === undefined ? entries : entries.slice(-options.limit);
}

/** Groups by tool and error code, most frequent first: the order to fix things in. */
export function summarizeFailures(entries: FailureEntry[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup & { sessionIds: Set<string> }>();
  for (const entry of entries) {
    const key = `${entry.tool}\u0000${entry.errorCode}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { tool: entry.tool, errorCode: entry.errorCode, count: 0, sessions: 0, firstSeen: entry.timestamp, lastSeen: entry.timestamp, sampleMessage: entry.message, sampleInput: entry.inputSummary, sessionIds: new Set() };
      groups.set(key, group);
    }
    group.count += 1;
    group.sessionIds.add(entry.sessionId);
    if (entry.timestamp < group.firstSeen) group.firstSeen = entry.timestamp;
    if (entry.timestamp >= group.lastSeen) {
      group.lastSeen = entry.timestamp;
      group.sampleMessage = entry.message;
      group.sampleInput = entry.inputSummary;
    }
  }
  return [...groups.values()]
    .map(({ sessionIds, ...group }) => ({ ...group, sessions: sessionIds.size }))
    .sort((a, b) => b.count - a.count || (a.lastSeen < b.lastSeen ? 1 : -1));
}
