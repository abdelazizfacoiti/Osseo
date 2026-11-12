import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareConfirmation, readConfirmation } from "@agenthost/core";

const CLI = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const freshHome = (): string => { const home = mkdtempSync(path.join(os.tmpdir(), "agenthost-policy-cli-")); homes.push(home); return home; };
function cli(home: string, args: string[]) {
  const run = spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: path.join(home, "config.json") }, encoding: "utf8" });
  return { code: run.status, out: run.stdout, err: run.stderr };
}
const file = (home: string) => path.join(home, "policy.toml");
const FILE = "# my notes\n\n[[rule]]\naction = \"send\"\ndecision = \"ask\"\n\n# uploads\n[[rule]]\napp = \"Slack\"\naction = \"upload\"\ndecision = \"ask\"\nnote = \"files\"\n";
const pending = (home: string, category: "send" | "any" = "send") => prepareConfirmation({ agentHostDir: home, tool: "desktop.click", riskLevel: "high", args: {}, summary: "Send", policyTarget: { app: "Slack", category } });

describe("agenthost confirm --always", () => {
  it("approves and writes exactly one rule", async () => {
    const home = freshHome();
    const record = await pending(home);
    const run = cli(home, ["confirm", record.tokenId, "--always", "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out).data.alwaysAllow).toMatchObject({ written: true });
    expect((await readConfirmation(home, record.tokenId))?.status).toBe("accepted");
    expect(readFileSync(file(home), "utf8").split("\n").filter((line) => line.includes("added from an approval prompt"))).toHaveLength(1);
  });

  it("also works with --always before the token", async () => {
    const home = freshHome();
    const record = await pending(home);
    expect(cli(home, ["confirm", "--always", record.tokenId]).code).toBe(0);
    expect(existsSync(file(home))).toBe(true);
  });

  it("without the flag it only approves", async () => {
    const home = freshHome();
    const record = await pending(home);
    const run = cli(home, ["confirm", record.tokenId, "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out).data.alwaysAllow).toBeUndefined();
    expect((await readConfirmation(home, record.tokenId))?.status).toBe("accepted");
    expect(existsSync(file(home))).toBe(false);
  });

  it("a category that cannot be remembered is approved once with the reason", async () => {
    const home = freshHome();
    const record = await pending(home, "any");
    const run = cli(home, ["confirm", record.tokenId, "--always", "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.out).data.alwaysAllow).toMatchObject({ written: false });
    expect(existsSync(file(home))).toBe(false);
  });

  it("deny --always is refused", async () => {
    const home = freshHome();
    const record = await pending(home);
    expect(cli(home, ["deny", record.tokenId, "--always"]).code).toBe(1);
    expect((await readConfirmation(home, record.tokenId))?.status).toBe("pending");
  });
});

describe("agenthost policy", () => {
  it("list says when there is no file", () => {
    const run = cli(freshHome(), ["policy", "list"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("There is no policy.toml");
  });

  it("list shows line numbers", () => {
    const home = freshHome();
    writeFileSync(file(home), FILE);
    const run = cli(home, ["policy", "list"]);
    expect(run.out).toContain("line 3  ASK  send");
    expect(run.out).toContain("line 8  ASK  upload  app=Slack  # files");
    const json = JSON.parse(cli(home, ["policy", "list", "--json"]).out);
    expect(json.data.rules.map((rule: { line: number }) => rule.line)).toEqual([3, 8]);
  });

  it("list prints the parse error with its line and says the last good rules stay", () => {
    const home = freshHome();
    writeFileSync(file(home), `${FILE}\n[[rule]]\naction = "bogus"\ndecision = "ask"\n`);
    const run = cli(home, ["policy", "list"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("line 15");
    expect(run.err).toContain("last good rules stay in use");
  });

  it("add previews by default and --apply writes one rule", () => {
    const home = freshHome();
    writeFileSync(file(home), FILE);
    const preview = cli(home, ["policy", "add", "--action", "delete", "--decision", "never", "--app", "Files", "--note", "no deletes"]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("action = \"delete\"");
    expect(preview.out).toContain("Would add rule 3 at line 14");
    expect(readFileSync(file(home), "utf8")).toBe(FILE);
    const applied = cli(home, ["policy", "add", "--action", "delete", "--decision", "never", "--app", "Files", "--note", "no deletes", "--apply"]);
    expect(applied.code).toBe(0);
    const after = readFileSync(file(home), "utf8");
    expect(after.startsWith(FILE)).toBe(true);
    expect(after.slice(FILE.length)).toBe("\n[[rule]]\napp = \"Files\"\naction = \"delete\"\ndecision = \"never\"\nnote = \"no deletes\"\n");
  });

  it("add with an invalid rule writes nothing", () => {
    const home = freshHome();
    writeFileSync(file(home), FILE);
    for (const bad of [["--action", "explode", "--decision", "allow"], ["--action", "send", "--decision", "maybe"], ["--action", "send", "--decision", "allow", "--site", "https://x.com/path"], ["--decision", "allow"]]) {
      const run = cli(home, ["policy", "add", ...bad, "--apply"]);
      expect(run.code).toBe(1);
    }
    expect(readFileSync(file(home), "utf8")).toBe(FILE);
  });

  it("remove previews, then removes exactly that rule and keeps the comments", () => {
    const home = freshHome();
    writeFileSync(file(home), FILE);
    const preview = cli(home, ["policy", "remove", "3"]);
    expect(preview.code).toBe(0);
    expect(readFileSync(file(home), "utf8")).toBe(FILE);
    expect(cli(home, ["policy", "remove", "4", "--apply"]).code).toBe(1); // not a rule header
    expect(cli(home, ["policy", "remove", "3", "--apply"]).code).toBe(0);
    expect(readFileSync(file(home), "utf8")).toBe("# my notes\n\n# uploads\n[[rule]]\napp = \"Slack\"\naction = \"upload\"\ndecision = \"ask\"\nnote = \"files\"\n");
  });
});
