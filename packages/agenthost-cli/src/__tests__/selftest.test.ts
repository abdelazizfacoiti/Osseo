import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selftestCommand, type SelftestStep } from "../selftest.js";

const BUILT_SERVER = fileURLToPath(new URL("../../../mcp-server/dist/index.js", import.meta.url));
const tmpDirs = () => readdirSync(os.tmpdir()).filter((name) => name.startsWith("agenthost-selftest-")).sort();

// A stand-in server: answers initialize, then tools/call from canned results. FAKE_FAIL names a tool that fails.
const FAKE = `
const fs = require("fs");
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
let seen = 0;
const reply = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(body) }] } }) + "\\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } }) + "\\n");
  if (m.method !== "tools/call") return;
  const name = m.params.name;
  if (name === process.env.FAKE_FAIL) return reply(m.id, { ok: false, error: { code: "boom" } });
  if (name === "see") { seen += 1; return reply(m.id, { ok: true, data: { list: seen === 1 ? '[1] entry "Name"\\n[2] button "Save"' : '[1] entry "Name" = "Ada"\\n[2] button "Save"' } }); }
  if (name === "browser.snapshot") return reply(m.id, { ok: true, data: { text: "Saved: Ada" } });
  reply(m.id, { ok: true, data: {} });
});
`;

describe("agenthost selftest", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "selftest-fake-")); writeFileSync(path.join(dir, "fake.js"), FAKE); });
  afterEach(() => { delete process.env.FAKE_FAIL; delete process.env.FAKE_PID_FILE; rmSync(dir, { recursive: true, force: true }); });
  const fake = () => path.join(dir, "fake.js");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it("passes every step against a fake server, cleans up, and exits 0", async () => {
    const before = tmpDirs();
    process.env.FAKE_PID_FILE = path.join(dir, "pid");
    const result = await selftestCommand([], dir, { mcpEntry: fake(), chromePath: process.execPath });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.data).toMatch(/PASS\s+initialize/);
    expect(String(result.data).match(/PASS/g)).toHaveLength(6);
    expect(tmpDirs()).toEqual(before);
    expect(alive(Number(readFileSync(path.join(dir, "pid"), "utf8")))).toBe(false);
  });

  it("stops at a failed step, skips the rest and exits 1", async () => {
    process.env.FAKE_FAIL = "type";
    const result = await selftestCommand(["--json"], dir, { mcpEntry: fake(), chromePath: process.execPath });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    const steps = (result.data as { steps: SelftestStep[] }).steps;
    expect(steps.map((s) => s.status)).toEqual(["pass", "pass", "pass", "fail", "skipped", "skipped"]);
    expect(steps[3]!.detail).toContain("boom");
  });

  it("--json returns the steps with name, status, ms and detail", async () => {
    const result = await selftestCommand(["--json"], dir, { mcpEntry: fake(), chromePath: process.execPath });
    const data = result.data as { steps: SelftestStep[]; summary: string };
    expect(data.steps.map((s) => s.name)).toEqual(["initialize", "open", "see", "type", "click", "see again"]);
    for (const step of data.steps) expect(step).toEqual({ name: step.name, status: "pass", ms: expect.any(Number), detail: expect.any(String) });
    expect(data.summary).toContain("passed");
  });

  it("fails the first step when the server is missing", async () => {
    const result = await selftestCommand([], dir, { mcpEntry: path.join(dir, "nope.js"), chromePath: process.execPath });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("built server not found");
  });

  const chrome = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"].some((name) => (process.env.PATH ?? "").split(path.delimiter).some((d) => d !== "" && existsSync(path.join(d, name))));
  it.skipIf(!existsSync(BUILT_SERVER) || !chrome)("real run: six steps pass against the built server", async () => {
    const before = tmpDirs();
    const result = await selftestCommand(["--json"], dir, { mcpEntry: BUILT_SERVER });
    const steps = (result.data as { steps: SelftestStep[] }).steps;
    expect(steps.map((s) => `${s.name}:${s.status}:${s.detail}`)).toEqual(steps.map((s) => `${s.name}:pass:${s.detail}`));
    expect(steps).toHaveLength(6);
    expect(steps[5]!.detail).toContain("Saved: Ada");
    expect(result.exitCode).toBe(0);
    expect(tmpDirs()).toEqual(before);
  }, 90_000);
});
