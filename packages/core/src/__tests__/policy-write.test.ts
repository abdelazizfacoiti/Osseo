import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addRule, alwaysAllowFromConfirmation, invalidatePolicyCache, loadPolicy, removeRule } from "../policy-file.js";

const dirs: string[] = [];
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-policy-write-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  invalidatePolicyCache();
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

const OLD = "# keep me\n\n[[rule]]\naction = \"send\"\ndecision = \"ask\"\n";

describe("policy.toml writes", () => {
  it("the next load sees a rule written by alwaysAllowFromConfirmation", async () => {
    const home = await tempHome();
    await writeFile(path.join(home, "policy.toml"), OLD);
    expect((await loadPolicy(home)).rules).toHaveLength(1);
    const result = await alwaysAllowFromConfirmation(home, { riskLevel: "high", policyTarget: { app: "Slack", category: "send" } });
    expect(result.written).toBe(true);
    const loaded = await loadPolicy(home);
    expect(loaded.error).toBeUndefined();
    expect(loaded.rules.map((rule) => [rule.action, rule.decision, rule.app])).toEqual([["send", "allow", ["Slack"]], ["send", "ask", undefined]]);
    expect((await readFile(path.join(home, "policy.toml"), "utf8")).startsWith("# keep me\n")).toBe(true);
  });

  it("a failed write leaves the old file intact and no temporary file behind", async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const home = await tempHome();
    const file = path.join(home, "policy.toml");
    await writeFile(file, OLD);
    await chmod(home, 0o500); // the temporary file cannot be created
    await expect(addRule(home, { app: "Slack", action: "send", decision: "allow" })).rejects.toThrow();
    const result = await alwaysAllowFromConfirmation(home, { riskLevel: "high", policyTarget: { app: "Slack", category: "send" } });
    expect(result).toMatchObject({ written: false, reason: "write_failed" });
    await chmod(home, 0o700);
    expect(await readFile(file, "utf8")).toBe(OLD);
    expect((await readdir(home)).sort()).toEqual(["policy.toml"]);
  });

  it("a rename that cannot happen leaves nothing behind", async () => {
    const home = await tempHome();
    // policy.toml is a directory, so the final rename fails after the temporary file was written.
    await mkdir(path.join(home, "policy.toml"));
    await expect(addRule(home, { app: "Slack", action: "send", decision: "allow" })).rejects.toThrow();
    expect((await readdir(home)).sort()).toEqual(["policy.toml"]);
  });

  it("remove keeps the comments and the other rules byte for byte", async () => {
    const home = await tempHome();
    const text = "# top\n\n# first\n[[rule]]\naction = \"send\"\ndecision = \"ask\"\n\n# second\n[[rule]]\napp = \"Slack\"\naction = \"upload\"\ndecision = \"allow\"\n";
    await writeFile(path.join(home, "policy.toml"), text);
    await removeRule(home, 2);
    expect(await readFile(path.join(home, "policy.toml"), "utf8")).toBe("# top\n\n# first\n[[rule]]\naction = \"send\"\ndecision = \"ask\"\n\n# second\n");
  });
});
