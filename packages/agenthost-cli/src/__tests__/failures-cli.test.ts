import { mkdir, mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFailureEntry, JsonlFailureLog } from "@agenthost/core";
import { failuresCommand, parseSince } from "../failures-cli.js";

async function seeded() {
  const home = await mkdtemp(path.join(os.tmpdir(), "agenthost-failures-cli-"));
  await mkdir(path.join(home, "logs"), { recursive: true });
  const log = new JsonlFailureLog(path.join(home, "logs", "failures.jsonl"));
  const base = { sessionId: "session_one", riskLevel: "low", durationMs: 4, platform: "linux", inputSummary: "Click Save" };
  await log.record(buildFailureEntry({ ...base, timestamp: "2026-11-01T10:00:00.000Z", tool: "click", errorCode: "label_not_found", message: "No control named Save" }));
  await log.record(buildFailureEntry({ ...base, timestamp: "2026-11-02T10:00:00.000Z", tool: "click", errorCode: "label_not_found", message: "No control named Save" }));
  await log.record(buildFailureEntry({ ...base, timestamp: "2026-11-02T11:00:00.000Z", tool: "set_field", errorCode: "accessibility_unavailable", message: "AT-SPI down" }));
  return home;
}

describe("agenthost failures", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("says so when nothing is recorded", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "agenthost-failures-cli-"));
    expect(await failuresCommand([], home, env)).toMatchObject({ ok: true, data: "No failures recorded." });
  });

  it("summarizes by reason, most frequent first", async () => {
    const home = await seeded();
    const out = await failuresCommand([], home, env);
    expect(out.ok).toBe(true);
    const text = String(out.data);
    expect(text).toContain("3 failure(s), 2 distinct reason(s)");
    expect(text.indexOf("label_not_found")).toBeLessThan(text.indexOf("accessibility_unavailable"));
  });

  it("shows recent entries, filtered by tool and as JSON", async () => {
    const home = await seeded();
    const shown = await failuresCommand(["show", "--tool", "set_field"], home, env);
    expect(String(shown.data)).toContain("AT-SPI down");
    expect(String(shown.data)).not.toContain("No control named Save");
    const json = await failuresCommand(["show", "--last", "1", "--json"], home, env);
    expect(Array.isArray(json.data) && json.data).toHaveLength(1);
  });

  it("rejects a bad --since or --last", async () => {
    const home = await seeded();
    expect((await failuresCommand(["--since", "soon"], home, env)).error).toMatch(/invalid_since/);
    expect((await failuresCommand(["show", "--last", "0"], home, env)).error).toMatch(/invalid_last/);
    expect((await failuresCommand(["nope"], home, env)).ok).toBe(false);
  });

  it("parses relative and absolute --since values", () => {
    expect(parseSince("2d", Date.parse("2026-11-10T00:00:00.000Z"))).toBe("2026-11-08T00:00:00.000Z");
    expect(parseSince("2026-11-01")).toBe("2026-11-01T00:00:00.000Z");
    expect(parseSince(undefined)).toBeUndefined();
    expect(parseSince("x")).toBe("invalid");
  });

  it("previews clear and deletes only with --apply", async () => {
    const home = await seeded();
    const file = path.join(home, "logs", "failures.jsonl");
    expect(String(( await failuresCommand(["clear"], home, env)).data)).toContain("Would delete 1 file(s)");
    await expect(stat(file)).resolves.toBeDefined();
    expect(String((await failuresCommand(["clear", "--apply"], home, env)).data)).toContain("Deleted 1 file(s)");
    await expect(stat(file)).rejects.toThrow();
  });
});
