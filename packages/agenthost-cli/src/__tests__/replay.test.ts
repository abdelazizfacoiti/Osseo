import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReplay, deleteReplay, escapeHtml, listReplays, pruneReplays, renderReplayHtml, replayCommand, replayDir, writeReplay } from "../replay.js";

let home: string;
beforeEach(async () => { home = await mkdtemp(path.join(os.tmpdir(), "agenthost-replay-")); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function entry(sessionId: string, minute: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp: `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`, sessionId, tool: "desktop.click", riskLevel: "low", inputSummary: "{\"x\":1}", approvalStatus: "not_required", ok: true, durationMs: 12, outputSummary: "ok", ...extra });
}
async function fixture(): Promise<void> {
  await mkdir(path.join(home, "logs"), { recursive: true });
  const lines = [
    entry("session_aaaa1111-x", 1),
    entry("session_aaaa1111-x", 5, { tool: "shell.run", ok: false, errorCode: "tool_failed", durationMs: 40 }),
    entry("session_aaaa1111-x", 3, { tool: "file.delete", ok: false, approvalStatus: "required", errorCode: "confirmation_required", confirmationStatus: "previewGenerated" }),
    entry("session_aaaa1111-x", 4, { tool: "file.delete", confirmationStatus: "tokenAccepted", approvalStatus: "approved" }),
    entry("session_aaaa1111-x", 6, { tool: "file.write", ok: false, errorCode: "path_blocked" }),
    entry("session_bbbb2222-y", 30, { tool: "see", inputSummary: "task_demo" }),
    "not json"
  ];
  await writeFile(path.join(home, "logs", "agenthost.jsonl"), lines.join("\n") + "\n");
}

describe("escapeHtml", () => {
  it("escapes markup, quotes and ampersands", () => {
    expect(escapeHtml("<script>alert(\"a\" & 'b')</script>")).toBe("&lt;script&gt;alert(&quot;a&quot; &amp; &#39;b&#39;)&lt;/script&gt;");
  });
  it("hostile tool name cannot break out of the table", async () => {
    await fixture();
    const record = (await buildReplay(home, { sessionId: "session_aaaa1111-x" }))!;
    record.items[0]!.tool = "</td></tr></table><script>x</script>";
    const html = renderReplayHtml(record);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;");
  });
});

describe("buildReplay", () => {
  it("groups one session, orders by time, maps outcomes and counts approvals", async () => {
    await fixture();
    const r = (await buildReplay(home, { sessionId: "session_aaaa1111-x" }))!;
    expect(r.items.map((i) => i.at.slice(14, 16))).toEqual(["01", "03", "04", "05", "06"]);
    expect(r.items.map((i) => i.outcome)).toEqual(["ok", "waiting_approval", "ok", "failed", "blocked"]);
    expect(r.counts).toMatchObject({ actions: 5, ok: 2, failed: 1, blocked: 1, waitingApproval: 1, approvalsAsked: 1, approvalsGiven: 1 });
    expect(r.approvals.find((a) => a.kind === "given")?.decision).toBe("accepted");
    expect(r.items[3]!.durationMs).toBe(40);
    expect(r.id).toMatch(/^replay_aaaa1111_202610011001$/);
  });
  it("defaults to the newest session and finds a task by id", async () => {
    await fixture();
    expect((await buildReplay(home, { last: true }))!.sessionId).toBe("session_bbbb2222-y");
    expect((await buildReplay(home, { taskId: "task_demo" }))!.sessionId).toBe("session_bbbb2222-y");
    expect(await buildReplay(home, { sessionId: "nope" })).toBeUndefined();
  });
});

describe("html", () => {
  it("is self-contained with the CSP and footer", async () => {
    await fixture();
    const html = renderReplayHtml((await buildReplay(home))!);
    expect(html).toContain("<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("summaries only: no screenshots and no typed text");
    expect(html).toContain("prefers-color-scheme: dark");
  });
});

describe("storage", () => {
  it("writes 0600 in a 0700 directory with no temp file left", async () => {
    await fixture();
    const file = await writeReplay(home, (await buildReplay(home))!);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(replayDir(home))).mode & 0o777).toBe(0o700);
    expect((await readdir(replayDir(home))).filter((n) => n.includes(".tmp"))).toEqual([]);
  });
  it("refuses bad ids", async () => {
    for (const id of ["../x", "a/b", "", "a.b", "x".repeat(81)]) await expect(deleteReplay(home, id)).rejects.toThrow("replay_bad_id");
  });
  it("prunes by age and size, keeping the newest", async () => {
    const dir = replayDir(home);
    await mkdir(dir, { recursive: true });
    const now = Date.now() / 1000;
    for (const [id, ageDays, size] of [["old", 20, 10], ["a", 3, 100], ["b", 2, 100], ["c", 1, 100]] as const) {
      const f = path.join(dir, `${id}.html`);
      await writeFile(f, "x".repeat(size));
      await utimes(f, now - ageDays * 86400, now - ageDays * 86400);
    }
    const removed = await pruneReplays(home, { maxAgeDays: 14, maxTotalBytes: 250 });
    expect(removed.sort()).toEqual(["a", "old"]);
    expect((await listReplays(home)).map((f) => f.id)).toEqual(["c", "b"]);
  });
});

describe("replayCommand", () => {
  it("build, list, open, delete", async () => {
    await fixture();
    const built = await replayCommand(["replay", "build", "--json"], home);
    expect(built.ok).toBe(true);
    const data = built.data as { id: string; path: string; items: number };
    expect(data.items).toBe(1);
    expect((await readdir(replayDir(home))).length).toBe(1);
    expect(String((await replayCommand(["list"], home)).data)).toContain(data.id);
    const opened = await replayCommand(["open", data.id], home);
    expect(opened.data).toBe(data.path);
    expect((await replayCommand(["delete", data.id], home)).data).toContain("--apply");
    expect((await listReplays(home)).length).toBe(1);
    await replayCommand(["delete", data.id, "--apply"], home);
    expect((await listReplays(home)).length).toBe(0);
    expect((await replayCommand(["open", "../etc"], home)).ok).toBe(false);
    expect(await readFile(path.join(home, "logs", "agenthost.jsonl"), "utf8")).toContain("session_aaaa1111-x");
  });
});
