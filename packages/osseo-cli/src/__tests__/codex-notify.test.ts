import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_NOTIFY_LINE, codexNotifyAdd, codexNotifyRemove, codexNotifyState } from "../codex-notify.js";
import { integrationAdd, integrationConfigPath, integrationRemove, integrationStatus, publicIntegrationReport, type IntegrationPaths } from "../integrations.js";

vi.mock("@osseo/os-linux", () => ({
  findHostWindow: async () => undefined,
  getLinuxActiveWindow: async () => undefined,
  raiseLinuxWindow: async () => undefined,
  focusLinuxWindow: async () => undefined
}));

const roots: string[] = [];

async function makePaths(): Promise<IntegrationPaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), "osseo-codex-notify-"));
  roots.push(root);
  return { home: root, project: path.join(root, "project"), codexHome: path.join(root, "codex") };
}

async function seed(paths: IntegrationPaths, text: string): Promise<string> {
  const file = integrationConfigPath("codex", paths);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
  return file;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex notify through integrations", () => {
  it("previews without writing, applies with a backup, and a second apply is a no-op", async () => {
    const paths = await makePaths();
    const original = '# my config\nmodel = "gpt-5"\n';
    const file = await seed(paths, original);

    const preview = await integrationAdd("codex", paths, false);
    expect(preview).toMatchObject({ changed: true, applied: false, codexNotify: { configured: true, changed: true, applied: false } });
    expect(await readFile(file, "utf8")).toBe(original);
    expect(existsSync(`${file}.osseo.bak`)).toBe(false);

    const applied = await integrationAdd("codex", paths, true);
    expect(applied).toMatchObject({ applied: true, backup: true, codexNotify: { configured: true, applied: true } });
    expect(await readFile(`${file}.osseo.bak`, "utf8")).toBe(original);
    const text = await readFile(file, "utf8");
    expect(text.startsWith(`# my config\nmodel = "gpt-5"\n${CODEX_NOTIFY_LINE}\n`)).toBe(true);
    expect(text).toContain("[mcp_servers.osseo]");

    const again = await integrationAdd("codex", paths, true);
    expect(again).toMatchObject({ changed: false, applied: false, codexNotify: { configured: true, changed: false, applied: false } });
    expect(await readFile(file, "utf8")).toBe(text);
    expect((await integrationStatus("codex", paths)).codexNotify?.configured).toBe(true);
    expect(publicIntegrationReport(applied).codexNotify).toBeDefined();
  });

  it("keeps the key above the first table and the rest of the file byte for byte", async () => {
    const paths = await makePaths();
    const original = 'model = "gpt-5"   # keep\n\n# about tui\n[tui]\nnotifications = true\n\n[projects."/x"]\ntrust_level = "trusted"\n';
    const file = await seed(paths, original);
    await integrationAdd("codex", paths, true);
    const text = await readFile(file, "utf8");
    expect(text.indexOf("notify =")).toBeGreaterThan(-1);
    expect(text.indexOf("notify =")).toBeLessThan(text.indexOf("[tui]"));
    expect(text).toContain('model = "gpt-5"   # keep\n');
    expect(text).toContain("# about tui\n[tui]\nnotifications = true\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n");
    // removing the key and the MCP entry returns the original.
    const removed = await integrationRemove("codex", paths, true);
    expect(removed.codexNotify).toMatchObject({ configured: false, applied: true });
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("puts the key before the first table when the file starts with one", async () => {
    const paths = await makePaths();
    const file = await seed(paths, "# top\n\n[tui]\nx = 1\n");
    await integrationAdd("codex", paths, true);
    const text = await readFile(file, "utf8");
    expect(text.indexOf("notify =")).toBeLessThan(text.indexOf("[tui]"));
    expect(text.startsWith("# top\n\n")).toBe(true);
  });

  it("leaves a different notify program alone and says why", async () => {
    const paths = await makePaths();
    const original = 'notify = ["python3", "/home/me/notify.py"]\nmodel = "x"\n';
    const file = await seed(paths, original);
    const report = await integrationAdd("codex", paths, true);
    expect(report.codexNotify).toMatchObject({ configured: false, changed: false, applied: false });
    expect(report.codexNotify?.reason).toMatch(/different notify program/);
    const text = await readFile(file, "utf8");
    expect(text).toContain('notify = ["python3", "/home/me/notify.py"]');
    expect(text).not.toContain("osseo\", \"attention");
    expect((await integrationStatus("codex", paths)).codexNotify).toMatchObject({ configured: false });
    // remove does not touch it either.
    await integrationRemove("codex", paths, true);
    expect(await readFile(file, "utf8")).toContain('notify = ["python3", "/home/me/notify.py"]');
  });

  it("removes only its own notify and keeps a notify inside a table", async () => {
    const paths = await makePaths();
    const file = await seed(paths, '[other]\nnotify = ["keep"]\n');
    await integrationAdd("codex", paths, true);
    expect(codexNotifyState(await readFile(file, "utf8")).matches).toBe(true);
    await integrationRemove("codex", paths, true);
    const text = await readFile(file, "utf8");
    expect(text).toContain('[other]\nnotify = ["keep"]');
    expect(text).not.toContain("attention");
  });

  it("works on a file with no trailing newline and on a missing file", async () => {
    const paths = await makePaths();
    const file = await seed(paths, 'model = "x"');
    await integrationAdd("codex", paths, true);
    const text = await readFile(file, "utf8");
    expect(text.startsWith(`model = "x"\n${CODEX_NOTIFY_LINE}\n`)).toBe(true);

    const fresh = await makePaths();
    const created = await integrationAdd("codex", fresh, true);
    expect(created.codexNotify?.configured).toBe(true);
    expect(await readFile(created.configPath, "utf8")).toContain(CODEX_NOTIFY_LINE);
  });
});

describe("Codex notify text edits", () => {
  it("replaces an older Osseo notify in place", () => {
    const old = 'notify = ["osseo", "attention", "request", "--source", "codex"]\nmodel = "x"\n';
    const next = codexNotifyAdd(old).text;
    expect(next).toBe(`${CODEX_NOTIFY_LINE}\nmodel = "x"\n`);
  });

  it("reads a multi-line notify array and does not split at a bracket inside it", () => {
    const text = 'notify = [\n  "osseo", # ours\n  "attention",\n  "request",\n]\nmodel = "x"\n[t]\nk = 1\n';
    expect(codexNotifyState(text)).toMatchObject({ present: true, ours: true, matches: false });
    expect(codexNotifyRemove(text).text).toBe('model = "x"\n[t]\nk = 1\n');
  });

  it("is a no-op when ours is already exact", () => {
    const text = `${CODEX_NOTIFY_LINE}\n`;
    expect(codexNotifyAdd(text)).toMatchObject({ text, state: { matches: true } });
  });
});
