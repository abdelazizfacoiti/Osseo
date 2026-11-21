import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveText, type AuditLogEntry } from "@osseo/core";
import { parseFlags } from "./flags.js";

/*
 * Session replay: one self-contained HTML page per session, built only from the
 * audit log. The audit log holds summaries (no screenshots, no typed text), so
 * the replay holds none either. Stored apart from the log under <home>/replays.
 */

export type ReplayOutcome = "ok" | "failed" | "blocked" | "waiting_approval";

export interface ReplayItem {
  at: string;
  tool: string;
  input: string;
  outcome: ReplayOutcome;
  errorCode?: string;
  durationMs: number;
}

export interface ReplayApproval {
  at: string;
  kind: "asked" | "given";
  tool: string;
  decision?: "accepted" | "rejected";
  detail?: string;
}

export interface ReplayRecord {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  items: ReplayItem[];
  approvals: ReplayApproval[];
  counts: { actions: number; ok: number; failed: number; blocked: number; waitingApproval: number; approvalsAsked: number; approvalsGiven: number };
}

export interface BuildReplayOptions { sessionId?: string; taskId?: string; last?: boolean }

const ID_PATTERN = /^[A-Za-z0-9_]{1,80}$/;
const MAX_TEXT = 300;

export function isValidReplayId(id: string): boolean { return ID_PATTERN.test(id); }

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"'`]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;", "`": "&#96;" })[c]!);
}

function clean(value: string | undefined): string {
  if (value === undefined) return "";
  const home = os.homedir();
  let text = redactSensitiveText(value);
  if (home.length > 1) text = text.split(home).join("[home]");
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text;
}

export function replayDir(osseoDir: string): string { return path.join(osseoDir, "replays"); }

async function readAudit(osseoDir: string): Promise<AuditLogEntry[]> {
  const dir = path.join(osseoDir, "logs");
  let names: string[];
  try { names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl")); } catch { return []; }
  const entries: AuditLogEntry[] = [];
  for (const name of names) {
    let raw: string;
    try { raw = await readFile(path.join(dir, name), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditLogEntry;
        if (typeof e?.timestamp === "string" && typeof e.sessionId === "string" && typeof e.tool === "string" && !Number.isNaN(Date.parse(e.timestamp))) entries.push(e);
      } catch { /* skip bad line */ }
    }
  }
  return entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

const BLOCK_CODE = /block|denied|policy|never|stop|takeover|paused|forbidden|protected|refused/i;

export function outcomeOf(e: AuditLogEntry): ReplayOutcome {
  if (e.errorCode === "confirmation_required" || (e.approvalStatus === "required" && !e.ok)) return "waiting_approval";
  if (e.ok) return "ok";
  if (BLOCK_CODE.test(e.errorCode ?? "") || e.approvalStatus === "denied" || e.riskLevel === "blocked") return "blocked";
  return "failed";
}

function givenDecision(e: AuditLogEntry): "accepted" | "rejected" | undefined {
  if (e.confirmationStatus === "tokenRejected" || e.approvalStatus === "denied") return "rejected";
  if (e.confirmationStatus === "tokenAccepted" || e.confirmationStatus === "tokenUsed" || e.approvalStatus === "approved") return "accepted";
  return undefined;
}

function askedBy(e: AuditLogEntry): boolean {
  return e.approvalStatus === "required" || e.confirmationStatus === "previewGenerated" || e.errorCode === "confirmation_required";
}

function stamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

export async function buildReplay(osseoDir: string, options: BuildReplayOptions = {}): Promise<ReplayRecord | undefined> {
  const all = await readAudit(osseoDir);
  let sessionId = options.sessionId;
  if (sessionId === undefined) {
    // The audit stores no task id; a task is matched by its id in the input summary.
    const pool = options.taskId === undefined ? all : all.filter((e) => e.inputSummary?.includes(options.taskId!));
    sessionId = pool.at(-1)?.sessionId;
  }
  if (sessionId === undefined) return undefined;
  const entries = all.filter((e) => e.sessionId === sessionId);
  if (entries.length === 0) return undefined;

  const items: ReplayItem[] = [];
  const approvals: ReplayApproval[] = [];
  for (const e of entries) {
    const outcome = outcomeOf(e);
    items.push({ at: e.timestamp, tool: clean(e.tool), input: clean(e.inputSummary), outcome, ...(e.errorCode === undefined ? {} : { errorCode: clean(e.errorCode) }), durationMs: Number.isFinite(e.durationMs) ? e.durationMs : 0 });
    const decision = givenDecision(e);
    if (decision !== undefined) approvals.push({ at: e.timestamp, kind: "given", tool: clean(e.tool), decision, ...(e.confirmationReason === undefined ? {} : { detail: clean(e.confirmationReason) }) });
    else if (askedBy(e)) approvals.push({ at: e.timestamp, kind: "asked", tool: clean(e.tool), ...(e.policyNote === undefined ? {} : { detail: clean(e.policyNote) }) });
  }
  const count = (o: ReplayOutcome): number => items.filter((i) => i.outcome === o).length;
  const startedAt = entries[0]!.timestamp, endedAt = entries.at(-1)!.timestamp;
  const short = sessionId.replace(/^session_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "unknown";
  // A task build adds the task id's first 8 characters so two tasks of one session never share a file.
  const taskShort = options.taskId === undefined ? "" : `_${options.taskId.replace(/^task_/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
  return {
    id: `replay_${short}_${stamp(startedAt)}${taskShort === "_" ? "" : taskShort}`, sessionId: clean(sessionId), startedAt, endedAt, items, approvals,
    counts: { actions: items.length, ok: count("ok"), failed: count("failed"), blocked: count("blocked"), waitingApproval: count("waiting_approval"), approvalsAsked: approvals.filter((a) => a.kind === "asked").length, approvalsGiven: approvals.filter((a) => a.kind === "given").length }
  };
}

export function renderReplayHtml(record: ReplayRecord): string {
  const e = escapeHtml;
  const rows = record.items.map((i) => `<tr class="${e(i.outcome)}"><td>${e(i.at)}</td><td>${e(i.tool)}</td><td>${e(i.input)}</td><td>${e(i.outcome)}</td><td>${e(i.errorCode ?? "")}</td><td>${e(i.durationMs)} ms</td></tr>`).join("\n");
  const appr = record.approvals.map((a) => `<li>${e(a.at)} - ${a.kind === "asked" ? "approval asked" : `approval given (${e(a.decision ?? "")})`}: ${e(a.tool)}${a.detail ? ` - ${e(a.detail)}` : ""}</li>`).join("\n");
  const c = record.counts;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session replay ${e(record.id)}</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#59636e;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top;word-break:break-word}
.ok td:nth-child(4){color:var(--ok)}.failed td:nth-child(4),.blocked td:nth-child(4){color:var(--bad)}.waiting_approval td:nth-child(4){color:var(--warn)}
.muted,footer{color:var(--muted)}footer{margin-top:24px;border-top:1px solid var(--line);padding-top:8px}
</style></head><body>
<header><h1>Session replay</h1>
<p>Session ${e(record.sessionId)}<br>Start ${e(record.startedAt)}<br>End ${e(record.endedAt)}</p>
<p class="muted">${e(c.actions)} actions: ${e(c.ok)} ok, ${e(c.failed)} failed, ${e(c.blocked)} blocked, ${e(c.waitingApproval)} waiting for approval. Approvals asked ${e(c.approvalsAsked)}, given ${e(c.approvalsGiven)}.</p></header>
<h2>Timeline</h2>
<table><thead><tr><th>Time</th><th>Tool</th><th>Input</th><th>Outcome</th><th>Error</th><th>Duration</th></tr></thead>
<tbody>
${rows}
</tbody></table>
<h2>Approvals</h2>
${appr ? `<ul>\n${appr}\n</ul>` : "<p class=\"muted\">No approvals in this session.</p>"}
<footer>This file contains summaries only: no screenshots and no typed text. It is built from the redacted audit log and stored apart from it.</footer>
</body></html>
`;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
    await chmod(file, 0o600);
  } catch (error) { await rm(tmp, { force: true }); throw error; }
}

export async function writeReplay(osseoDir: string, record: ReplayRecord, outFile?: string): Promise<string> {
  if (!isValidReplayId(record.id)) throw new Error("replay_bad_id");
  const dir = replayDir(osseoDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = outFile === undefined ? path.join(dir, `${record.id}.html`) : path.resolve(outFile);
  if (outFile !== undefined) await mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, renderReplayHtml(record));
  return file;
}

export interface ReplayFile { id: string; path: string; bytes: number; modifiedMs: number }

export async function listReplays(osseoDir: string): Promise<ReplayFile[]> {
  const dir = replayDir(osseoDir);
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const out: ReplayFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".html")) continue;
    const id = name.slice(0, -5);
    if (!isValidReplayId(id)) continue;
    try { const s = await stat(path.join(dir, name)); if (s.isFile()) out.push({ id, path: path.join(dir, name), bytes: s.size, modifiedMs: s.mtimeMs }); } catch { /* gone */ }
  }
  return out.sort((a, b) => b.modifiedMs - a.modifiedMs);
}

export async function deleteReplay(osseoDir: string, id: string): Promise<boolean> {
  if (!isValidReplayId(id)) throw new Error("replay_bad_id");
  const file = path.join(replayDir(osseoDir), `${id}.html`);
  try { await stat(file); } catch { return false; }
  await rm(file, { force: true });
  return true;
}

export async function pruneReplays(osseoDir: string, limits: { maxAgeDays: number; maxTotalBytes: number } = { maxAgeDays: 14, maxTotalBytes: 50 * 1024 * 1024 }): Promise<string[]> {
  const files = await listReplays(osseoDir); // newest first
  const removed: string[] = [];
  const cutoff = Date.now() - limits.maxAgeDays * 86_400_000;
  let kept = files.filter((f) => { if (f.modifiedMs < cutoff) { removed.push(f.id); return false; } return true; });
  let total = kept.reduce((n, f) => n + f.bytes, 0);
  while (total > limits.maxTotalBytes && kept.length > 0) { const oldest = kept.at(-1)!; removed.push(oldest.id); total -= oldest.bytes; kept = kept.slice(0, -1); }
  for (const id of removed) await deleteReplay(osseoDir, id);
  return removed;
}

type Output = { ok: boolean; command: string; data?: unknown; error?: string };
const USAGE = "usage: osseo replay build [--session <id> | --task <id> | --last] [--out <file>] | list | open <id> | delete <id> [--apply]";

export async function replayCommand(input: string[] | ReturnType<typeof parseFlags>, agentHome: string): Promise<Output> {
  const args = Array.isArray(input) ? parseFlags(input) : input;
  const positional = args.positional[0] === "replay" ? args.positional.slice(1) : args.positional;
  const json = args.flags.has("json") || args.values.has("json");
  const fail = (command: string, error: string): Output => ({ ok: false, command, error });
  const action = positional[0] ?? "build";
  const out = (command: string, data: Record<string, unknown>, text: string): Output => ({ ok: true, command, data: json ? data : text });

  if (action === "build") {
    const session = args.values.get("session"), task = args.values.get("task");
    const record = await buildReplay(agentHome, { ...(session === undefined ? {} : { sessionId: session }), ...(task === undefined ? {} : { taskId: task }), last: args.flags.has("last") });
    if (!record) return fail("replay build", "no_session_found");
    let file: string;
    try { file = await writeReplay(agentHome, record, args.values.get("out")); } catch (error) { return fail("replay build", error instanceof Error ? error.message : "write_failed"); }
    await pruneReplays(agentHome).catch(() => undefined);
    return out("replay build", { id: record.id, path: file, items: record.items.length, approvals: record.approvals.length }, `${file}\n${record.items.length} items, ${record.approvals.length} approvals`);
  }
  if (action === "list") {
    const files = await listReplays(agentHome);
    return out("replay list", { replays: files.map((f) => ({ id: f.id, bytes: f.bytes, modified: new Date(f.modifiedMs).toISOString() })) },
      files.length === 0 ? "No replays." : files.map((f) => `${f.id}  ${f.bytes} bytes  ${new Date(f.modifiedMs).toISOString()}`).join("\n"));
  }
  const id = positional[1];
  if (action === "open" || action === "delete") {
    if (id === undefined || !isValidReplayId(id)) return fail(`replay ${action}`, "replay_bad_id");
    const file = path.join(replayDir(agentHome), `${id}.html`);
    const exists = (await listReplays(agentHome)).some((f) => f.id === id);
    if (!exists) return fail(`replay ${action}`, "replay_not_found");
    if (action === "open") return out("replay open", { id, path: file }, file);
    if (!args.flags.has("apply")) return out("replay delete", { id, path: file, applied: false }, `Would delete ${file}. Add --apply to delete it.`);
    await deleteReplay(agentHome, id);
    return out("replay delete", { id, path: file, applied: true }, `Deleted ${file}`);
  }
  return fail("replay", USAGE);
}
