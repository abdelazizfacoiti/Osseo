import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWorkflow, listWorkflows } from "@agenthost/core";
import { journalCommand, type JournalApi } from "../journal-cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const journalJs = path.resolve(here, "../../../mcp-server/dist/journal.js"); // needs a built mcp-server
const load = async (): Promise<JournalApi> => await import(pathToFileURL(journalJs).href) as JournalApi;
const record = async (home: string) => {
  const mod = await import(pathToFileURL(journalJs).href) as { recordStep(c: unknown, s: unknown): Promise<unknown> };
  const context = { sessionId: "s1", config: { agentHostDir: home } };
  await mod.recordStep(context, { tool: "click", number: 1, role: "push button", name: "New", ok: true });
  await mod.recordStep(context, { tool: "type", number: 2, role: "entry", name: "Title", textLength: 12, ok: true });
};
const home = () => mkdtempSync(path.join(os.tmpdir(), "agenthost-journal-cli-"));

describe("agenthost journal", () => {
  it("show lists the newest session with count and skipped", async () => {
    const h = home(); await record(h);
    const out = await journalCommand(["show"], h, { load });
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({ sessionId: "s1", count: 2, skipped: 0 });
  });

  it("save previews by default and writes nothing", async () => {
    const h = home(); await record(h);
    const out = await journalCommand(["save", "make-note"], h, { load });
    expect(out.ok).toBe(true);
    const data = out.data as { preview: boolean; parameters: Array<{ name: string }> };
    expect(data.preview).toBe(true);
    expect(data.parameters.map((p) => p.name)).toEqual(["text_1"]);
    expect(existsSync(path.join(h, "workflows"))).toBe(false);
  });

  it("save --apply writes one workflow the existing reader loads", async () => {
    const h = home(); await record(h);
    const out = await journalCommand(["save", "make-note", "--apply"], h, { load });
    expect(out.ok).toBe(true);
    expect(readdirSync(path.join(h, "workflows"))).toEqual(["make-note.json"]);
    const workflow = await loadWorkflow(h, "make-note");
    expect(workflow?.parameters.map((p) => p.name)).toEqual(["text_1"]);
    expect((await listWorkflows(h)).length).toBe(1);
    expect(readFileSync(path.join(h, "workflows", "make-note.json"), "utf8")).toContain("{{text_1}}");
    expect((await journalCommand(["save", "make-note", "--apply"], h, { load })).ok).toBe(false);
  });

  it("refuses a bad name and an unknown session", async () => {
    const h = home(); await record(h);
    expect((await journalCommand(["save", "Bad Name"], h, { load })).error).toMatch(/journal_name_invalid/);
    expect((await journalCommand(["show", "--session", "nope"], h, { load })).ok).toBe(false);
  });
});
