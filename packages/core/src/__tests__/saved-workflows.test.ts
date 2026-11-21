import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowError, deleteWorkflow, expandWorkflow, listWorkflows, loadWorkflow, noteWorkflowUsed, saveWorkflow } from "../saved-workflows.js";

const directories: string[] = [];
async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "osseo-workflows-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const base = {
  name: "open-report",
  description: "Open the weekly report",
  parameters: [{ name: "week", description: "ISO week" }],
  steps: [
    { tool: "app.open_url", input: { url: "https://intranet.example.com/reports/{{week}}" } },
    { tool: "computer.wait_for", input: { titleContains: "Report {{week}}" } }
  ]
};

describe("saved workflows", () => {
  it("stores with private permissions, lists, loads, and tracks use", async () => {
    const dir = await home();
    const saved = await saveWorkflow(dir, base);
    expect(saved).toMatchObject({ name: "open-report", uses: 0 });
    expect((await stat(path.join(dir, "workflows", "open-report.json"))).mode & 0o777).toBe(0o600);
    expect((await listWorkflows(dir)).map((workflow) => workflow.name)).toEqual(["open-report"]);
    await noteWorkflowUsed(dir, "open-report");
    expect((await loadWorkflow(dir, "open-report"))?.uses).toBe(1);
    // Re-saving keeps history.
    expect((await saveWorkflow(dir, { ...base, description: "Updated" })).uses).toBe(1);
    expect(await deleteWorkflow(dir, "open-report")).toBe(true);
    expect(await deleteWorkflow(dir, "open-report")).toBe(false);
  });

  it("expands parameters into every string without touching the stored plan", async () => {
    const dir = await home();
    const saved = await saveWorkflow(dir, base);
    const steps = expandWorkflow(saved, { week: "2026-W45" });
    expect(steps[0]!.input).toEqual({ url: "https://intranet.example.com/reports/2026-W45" });
    expect(steps[1]!.input).toEqual({ titleContains: "Report 2026-W45" });
    expect(JSON.parse(await readFile(path.join(dir, "workflows", "open-report.json"), "utf8")).steps[0].input.url).toContain("{{week}}");
    // A value that looks like a placeholder or JSON cannot add structure.
    expect(expandWorkflow(saved, { week: '"},{"tool":"shell.run' })[0]!.input).toEqual({ url: 'https://intranet.example.com/reports/"},{"tool":"shell.run' });
    expect(() => expandWorkflow(saved, {})).toThrow(/Missing: week/);
    expect(() => expandWorkflow(saved, { week: "1", extra: "x" })).toThrow(/Unknown: extra/);
  });

  it("rejects unsafe or inconsistent definitions", async () => {
    const dir = await home();
    const invalid = (change: Partial<Parameters<typeof saveWorkflow>[1]>) => saveWorkflow(dir, { ...base, ...change });
    await expect(invalid({ name: "Bad Name" })).rejects.toBeInstanceOf(WorkflowError);
    await expect(invalid({ steps: [{ tool: "computer.run_steps", input: {} }] })).rejects.toThrow(/cannot be part/);
    await expect(invalid({ steps: [{ tool: "agent.stop", input: {} }] })).rejects.toThrow(/cannot be part/);
    await expect(invalid({ parameters: [] })).rejects.toThrow(/without a declared parameter/);
    await expect(invalid({ parameters: [{ name: "week" }, { name: "unused" }] })).rejects.toThrow(/never used/);
    await expect(invalid({ steps: [{ tool: "desktop.type_text", input: { text: "api_key=sk-abcdefghijklmnopqrstuvwxyz0123456789" } }], parameters: [] })).rejects.toThrow(/secret/);
    await expect(saveWorkflow(dir, { ...base, knownTools: new Set(["app.open_url"]) })).rejects.toThrow(/unknown tool computer.wait_for/);
    await expect(invalid({ steps: [] })).rejects.toThrow(/1-20 steps/);
  });
});
