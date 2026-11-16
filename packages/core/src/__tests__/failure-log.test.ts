import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFailureEntry, failureLogPath, isDevFailure, JsonlFailureLog, readFailures, summarizeFailures, type FailureEntry } from "../index.js";

function entry(over: Partial<FailureEntry> = {}): FailureEntry {
  return buildFailureEntry({ timestamp: "2026-11-01T10:00:00.000Z", sessionId: "s1", tool: "click", errorCode: "label_not_found", message: "No control named Save", inputSummary: "Click Save", riskLevel: "low", durationMs: 5, platform: "linux", ...over });
}

describe("development failure log", () => {
  it("sits next to the audit log", () => {
    expect(failureLogPath("/home/u/.agenthost/logs/agenthost.jsonl")).toBe("/home/u/.agenthost/logs/failures.jsonl");
  });

  it("skips results that are the safety model working", () => {
    for (const code of ["confirmation_required", "pause_requested", "emergency_stop_requested", "human_takeover_active", "user_active"]) expect(isDevFailure(code)).toBe(false);
    expect(isDevFailure(undefined)).toBe(false);
    expect(isDevFailure("label_not_found")).toBe(true);
  });

  it("redacts and bounds the message and the hint", () => {
    const built = entry({ message: `token=abc123 ${"x".repeat(2000)}`, hint: "password=hunter2" });
    expect(built.message).toContain("token=[redacted]");
    expect(built.message.length).toBeLessThanOrEqual(300);
    expect(built.hint).toBe("password=[redacted]");
  });

  it("shortens the home directory to ~", () => {
    expect(entry({ message: `ENOENT: open '${os.homedir()}/Documents/a.txt'` }).message).toBe("ENOENT: open '~/Documents/a.txt'");
  });

  it("appends lines with private permissions and reads them back, skipping torn lines", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-failures-"));
    const file = path.join(dir, "logs", "failures.jsonl");
    const log = new JsonlFailureLog(file);
    await log.record(entry());
    await log.record(entry({ timestamp: "2026-11-02T10:00:00.000Z", tool: "set_field", errorCode: "accessibility_unavailable" }));
    await writeFile(file, `${await readFile(file, "utf8")}{"torn":\n`);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    const all = await readFailures(file);
    expect(all.map((item) => item.tool)).toEqual(["click", "set_field"]);
    expect(await readFailures(file, { since: "2026-11-02T00:00:00.000Z" })).toHaveLength(1);
    expect(await readFailures(file, { limit: 1 })).toHaveLength(1);
    expect(await readFailures(path.join(dir, "missing.jsonl"))).toEqual([]);
  });

  it("rotates to one older file when the log is large", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agenthost-failures-"));
    const file = path.join(dir, "failures.jsonl");
    const log = new JsonlFailureLog(file, 200);
    for (let i = 0; i < 6; i += 1) await log.record(entry({ sessionId: `s${i}` }));
    expect((await stat(path.join(dir, "failures.1.jsonl"))).size).toBeGreaterThan(0);
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean).length).toBeLessThan(6);
  });

  it("groups by tool and code, most frequent first, with sessions counted once", () => {
    const groups = summarizeFailures([
      entry({ sessionId: "a" }),
      entry({ sessionId: "a", timestamp: "2026-11-03T10:00:00.000Z", message: "newer message" }),
      entry({ sessionId: "b" }),
      entry({ tool: "set_field", errorCode: "accessibility_unavailable" })
    ]);
    expect(groups.map((group) => `${group.tool}:${group.count}:${group.sessions}`)).toEqual(["click:3:2", "set_field:1:1"]);
    expect(groups[0]).toMatchObject({ lastSeen: "2026-11-03T10:00:00.000Z", sampleMessage: "newer message" });
  });
});
