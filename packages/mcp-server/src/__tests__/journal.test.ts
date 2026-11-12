import { mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHostMcpContext } from "../context.js";

vi.mock("../nested.js", () => ({
  callGoverned: vi.fn(async (_c: unknown, name: string) => ({ ok: true, tool: name, riskLevel: "medium", approval: { required: false, status: "not_required" }, data: {}, observations: [], error: null }))
}));

import { JOURNAL_STEP_CAP, JournalError, journalToWorkflow, pruneJournals, readJournal, recordNumbered, recordStep, type JournalStep } from "../journal.js";
import { createNumberedTools } from "../tools/numbered.js";
import { forgetViews, rememberView } from "../view-registry.js";

const dir = () => mkdtempSync(path.join(os.tmpdir(), "agenthost-journal-"));
const ctx = (home: string, sessionId = "s1") => ({ sessionId, config: { agentHostDir: home } }) as unknown as AgentHostMcpContext;
afterEach(() => forgetViews());

describe("recordStep", () => {
  it("never records a sensitive field and counts it", async () => {
    const home = dir();
    await recordStep(ctx(home), { tool: "click", number: 1, role: "password text", name: "Password", ok: true });
    await recordStep(ctx(home), { tool: "click", number: 2, role: "entry", name: "Token", blocked: true, ok: true });
    await recordStep(ctx(home), { tool: "click", number: 3, role: "push button", name: "Save", ok: true });
    const journal = (await readJournal(home, "s1"))!;
    expect(journal.skipped).toBe(2);
    expect(journal.steps.map((s) => s.name)).toEqual(["Save"]);
  });

  it("stores the length and a placeholder for typed text, never the text", async () => {
    const home = dir();
    await recordStep(ctx(home), { tool: "type", number: 4, role: "entry", name: "Email", textLength: 17, ok: true });
    await recordStep(ctx(home), { tool: "type", number: 5, role: "entry", name: "Notes", textLength: 3, ok: true });
    const journal = (await readJournal(home, "s1"))!;
    expect(journal.steps.map((s) => [s.param, s.textLength])).toEqual([["text_1", 17], ["text_2", 3]]);
    const raw = readFileSync(path.join(home, "journal", "s1.json"), "utf8");
    expect(raw).not.toContain("hunter2-secret-value");
    expect(statSync(path.join(home, "journal", "s1.json")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(home, "journal")).mode & 0o777).toBe(0o700);
  });

  it("recordNumbered reads role and name from the view and drops the text", async () => {
    const home = dir();
    const view = rememberView({ windowKey: "w", source: "accessibility", targets: new Map([[1, { kind: "screen", bounds: { x: 0, y: 0, width: 1, height: 1 }, enabled: true, blocked: false, role: "entry", name: "Email", windowId: "w" }]]) });
    await recordNumbered(ctx(home), "type", { n: 1, view: view.id, text: "hunter2-secret-value" }, { ok: true });
    await recordNumbered(ctx(home), "type", { n: 1, view: view.id, text: "x", dryRun: true }, { ok: true });
    await recordNumbered(ctx(home), "click", { n: 1, view: view.id }, { ok: false });
    const journal = (await readJournal(home, "s1"))!;
    expect(journal.steps).toHaveLength(1);
    expect(journal.steps[0]).toMatchObject({ tool: "type", role: "entry", name: "Email", param: "text_1", textLength: 20 });
    expect(readFileSync(path.join(home, "journal", "s1.json"), "utf8")).not.toContain("hunter2");
  });

  it("caps at 200 steps and sets truncated", async () => {
    const home = dir();
    for (let i = 0; i < JOURNAL_STEP_CAP + 5; i += 1) await recordStep(ctx(home), { tool: "click", number: 1, role: "push button", name: `B${i}`, ok: true });
    const journal = (await readJournal(home, "s1"))!;
    expect(journal.steps).toHaveLength(JOURNAL_STEP_CAP);
    expect(journal.truncated).toBe(true);
    expect(journal.steps[0]!.name).toBe("B5");
  }, 60_000);
});

const step = (extra: Partial<JournalStep>): JournalStep => ({ at: "t", tool: "click", number: 1, role: "push button", name: "Save", inputKind: "click", ok: true, ...extra });
const journalOf = (steps: JournalStep[]) => ({ version: 1 as const, sessionId: "s1", startedAt: "t", updatedAt: "t", steps, skipped: 0, truncated: false, typeCount: 0 });

describe("journalToWorkflow", () => {
  it("declares a required parameter per type step and lists no values", () => {
    const draft = journalToWorkflow(journalOf([step({}), step({ tool: "type", inputKind: "type", role: "entry", name: "Email", param: "text_1", textLength: 9 }), step({ tool: "key", inputKind: "key", number: null, role: "keys", name: "ctrl+s" })]), { name: "my-flow" });
    expect(draft.parameters).toEqual([{ name: "text_1", description: "Text typed during the recorded task; enter it when you run the workflow.", required: true }]);
    expect(draft.steps).toEqual([
      { tool: "desktop.click", input: { label: "Save", role: "push button" } },
      { tool: "desktop.set_field", input: { label: "Email", role: "entry", text: "{{text_1}}" } },
      { tool: "desktop.hotkey", input: { keys: ["ctrl", "s"] } }
    ]);
  });
  it("validates the name and refuses an empty journal", () => {
    for (const bad of ["", "Bad", "-x", "a b", "x".repeat(65)]) expect(() => journalToWorkflow(journalOf([step({})]), { name: bad })).toThrow(JournalError);
    expect(() => journalToWorkflow(journalOf([]), { name: "ok" })).toThrow(/Nothing was recorded/);
  });
  it("refuses more than 20 steps unless last is given", () => {
    const many = journalOf(Array.from({ length: 25 }, () => step({})));
    expect(() => journalToWorkflow(many, { name: "ok" })).toThrow(/at most 20/);
    expect(journalToWorkflow(many, { name: "ok", last: 20 }).steps).toHaveLength(20);
  });
});

describe("pruneJournals", () => {
  it("removes only files older than the limit", async () => {
    const home = dir();
    await recordStep(ctx(home, "old"), { tool: "click", number: 1, role: "b", name: "A", ok: true });
    await recordStep(ctx(home, "new"), { tool: "click", number: 1, role: "b", name: "A", ok: true });
    const old = path.join(home, "journal", "old.json");
    const past = (Date.now() - 8 * 86_400_000) / 1000;
    utimesSync(old, past, past);
    expect(await pruneJournals(home, { maxAgeDays: 7 })).toBe(1);
    expect(readdirSync(path.join(home, "journal"))).toEqual(["new.json"]);
  });
});

describe("numbered actions", () => {
  it("a failing journal write does not change the result", async () => {
    const home = dir();
    const blocker = path.join(home, "file");
    writeFileSync(blocker, "x");
    const view = rememberView({ windowKey: "browser", source: "dom", targets: new Map([[1, { kind: "dom", ref: "s1-e2", role: "button", name: "Go", enabled: true, blocked: false }]]) });
    const tool = createNumberedTools().find((t) => t.name === "click")! as unknown as { handler(i: unknown, c: unknown): Promise<any> };
    const context = { sessionId: "s1", config: { agentHostDir: path.join(blocker, "sub") }, linux: { getActiveWindow: async () => ({}), listWindows: async () => ({ windows: [] }), browser: undefined } };
    const result = await tool.handler({ n: 1, view: view.id }, context);
    expect(result.ok).toBe(true);
    expect(result.tool).toBe("click");
  });
});
