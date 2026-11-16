import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { failureLogPath, readFailures, summarizeFailures, type FailureEntry } from "@agenthost/core";

/*
 * `agenthost failures summary|show|clear`: read the development failure log that the server writes in every
 * session (`logs/failures.jsonl`). `summary` groups by tool and error code, most frequent first, so the next
 * thing to fix is the first line. `clear` is a person's decision: it previews unless --apply.
 */

type Output = { ok: boolean; command: string; data?: unknown; error?: string };

export const FAILURES_USAGE = "usage: agenthost failures [summary] [--since 7d|<iso>] [--tool <name>] | show [--last <n>] [--since 7d|<iso>] [--tool <name>] [--json] | clear [--apply]";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  const value = index < 0 ? undefined : args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/** `7d`, `12h`, `30m` or an ISO timestamp, as an ISO timestamp. */
export function parseSince(value: string | undefined, now: number = Date.now()): string | undefined | "invalid" {
  if (value === undefined) return undefined;
  const relative = /^(\d{1,4})([dhm])$/.exec(value);
  if (relative !== null) {
    const unit = relative[2] === "d" ? 86_400_000 : relative[2] === "h" ? 3_600_000 : 60_000;
    return new Date(now - Number(relative[1]) * unit).toISOString();
  }
  return Number.isNaN(Date.parse(value)) ? "invalid" : new Date(value).toISOString();
}

export function failureLogFile(agentHome: string, env: NodeJS.ProcessEnv = process.env): string {
  return failureLogPath(env.AGENTHOST_LOG_FILE ?? path.join(agentHome, "logs", "agenthost.jsonl"));
}

function line(entry: FailureEntry): string {
  return `${entry.timestamp} ${entry.tool} ${entry.errorCode} (${entry.sessionId.slice(0, 16)}) ${entry.message}${entry.inputSummary ? `\n    input: ${entry.inputSummary}` : ""}${entry.hint ? `\n    hint: ${entry.hint}` : ""}`;
}

export async function failuresCommand(args: string[], agentHome: string, env: NodeJS.ProcessEnv = process.env): Promise<Output> {
  const first = args[0];
  const sub = first === undefined || first.startsWith("--") ? "summary" : first;
  if (sub !== "summary" && sub !== "show" && sub !== "clear") return { ok: false, command: "failures", error: FAILURES_USAGE };
  const command = `failures ${sub}`;
  const file = failureLogFile(agentHome, env);

  if (sub === "clear") {
    const files = [file, file.replace(/\.jsonl$/, ".1.jsonl")];
    const present: string[] = [];
    for (const candidate of files) if (await stat(candidate).then(() => true, () => false)) present.push(candidate);
    if (!args.includes("--apply")) return { ok: true, command, data: present.length === 0 ? "Nothing to clear." : `Would delete ${present.length} file(s): ${present.join(", ")}. Run again with --apply.` };
    for (const candidate of present) await rm(candidate, { force: true });
    return { ok: true, command, data: `Deleted ${present.length} file(s).` };
  }

  const since = parseSince(option(args, "since"));
  if (since === "invalid") return { ok: false, command, error: "invalid_since: use 7d, 12h, 30m or an ISO timestamp" };
  const tool = option(args, "tool");
  const lastRaw = option(args, "last");
  const last = lastRaw === undefined ? 20 : Number(lastRaw);
  if (!Number.isInteger(last) || last < 1 || last > 1000) return { ok: false, command, error: "invalid_last: use a whole number from 1 to 1000" };

  const all = await readFailures(file, { ...(since === undefined ? {} : { since }) });
  const entries = tool === undefined ? all : all.filter((entry) => entry.tool === tool);
  if (entries.length === 0) return { ok: true, command, data: "No failures recorded." };

  if (sub === "show") {
    const shown = entries.slice(-last);
    if (args.includes("--json")) return { ok: true, command, data: shown };
    return { ok: true, command, data: `${shown.map(line).join("\n")}\n(${shown.length} of ${entries.length})` };
  }
  const groups = summarizeFailures(entries);
  const rows = groups.map((group) => `${String(group.count).padStart(4)}x  ${group.tool}  ${group.errorCode}  (${group.sessions} session${group.sessions === 1 ? "" : "s"}, last ${group.lastSeen})\n        ${group.sampleMessage}`);
  return { ok: true, command, data: `${entries.length} failure(s), ${groups.length} distinct reason(s). Most frequent first:\n${rows.join("\n")}` };
}
