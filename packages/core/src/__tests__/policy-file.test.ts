import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY_RULES,
  DEFAULT_POLICY_TEXT,
  PolicyParseError,
  actionCategory,
  auditPolicySource,
  decidePolicy,
  ensurePolicyFile,
  invalidatePolicyCache,
  loadPolicy,
  parsePolicy,
  policyFilePath,
  ruleMatches,
  type PolicyClassification,
  type PolicyRule
} from "../policy-file.js";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "osseo-policy-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  invalidatePolicyCache();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function errorLine(text: string): number | undefined {
  try {
    parsePolicy(text);
    return undefined;
  } catch (error) {
    return error instanceof PolicyParseError ? error.line : -1;
  }
}

const base: PolicyClassification = { riskLevel: "medium", stateChanging: true };

describe("policy.toml parser", () => {
  it("parses rules, comments, blank lines and string arrays", () => {
    const rules = parsePolicy(`# top comment

[[rule]]   # trailing comment
app = ["Slack", "Teams"]   # apps
site = "*.Admin.Shopify.com"
action = "send"
decision = "ask"
note = "say \\"hi\\""

[[rule]]
action = "any"
decision = "allow"
`);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ app: ["Slack", "Teams"], site: ["admin.shopify.com"], action: "send", decision: "ask", note: 'say "hi"', line: 3, endLine: 8 });
    expect(rules[1]).toMatchObject({ action: "any", decision: "allow", line: 10 });
  });

  it("parses the shipped default file", () => {
    expect(parsePolicy(DEFAULT_POLICY_TEXT).map((rule) => `${rule.action}:${rule.decision}`)).toEqual(["send:ask", "upload:ask", "delete:ask", "pay:ask"]);
  });

  it("reports each error with its line number", () => {
    expect(errorLine('[[rule]]\naction = "send"\ndecision = "maybe"\n')).toBe(3);
    expect(errorLine('[[rule]]\naction = "launch"\ndecision = "ask"\n')).toBe(2);
    expect(errorLine('[[rule]]\naction = "send"\n')).toBe(1);
    expect(errorLine('[[rule]]\ndecision = "ask"\n')).toBe(1);
    expect(errorLine('[[rule]]\naction = "send"\ncolour = "red"\ndecision = "ask"\n')).toBe(3);
    expect(errorLine('action = "send"\n')).toBe(1);
    expect(errorLine('# c\n\n[rule]\n')).toBe(3);
    expect(errorLine('[[rule]]\naction = send\n')).toBe(2);
    expect(errorLine('[[rule]]\naction = "send\n')).toBe(2);
    expect(errorLine('[[rule]]\napp = ["a", 3]\n')).toBe(2);
    expect(errorLine('[[rule]]\napp = ["a"\n')).toBe(2);
    expect(errorLine('[[rule]]\naction = "send" junk\n')).toBe(2);
    expect(errorLine('[[rule]]\naction = "send"\naction = "any"\n')).toBe(3);
    expect(errorLine('[[rule]]\nsite = "https://a.com/x"\naction = "send"\ndecision = "ask"\n')).toBe(2);
    expect(errorLine('[[rule]]\naction = ["send"]\n')).toBe(2);
    expect(errorLine('[[rule]]\nnote = "x"\nnoteq\n')).toBe(3);
  });

  it("refuses a file over 64 KB", () => {
    const big = `# ${"x".repeat(64 * 1024)}\n`;
    expect(() => parsePolicy(big)).toThrow(/too large/);
    expect(() => parsePolicy(`# ${"x".repeat(60 * 1024)}\n`)).not.toThrow();
  });

  it("refuses more than 500 rules and a note over 200 characters", () => {
    expect(() => parsePolicy('[[rule]]\naction = "send"\ndecision = "ask"\nnote = "' + "n".repeat(201) + '"\n')).toThrow(PolicyParseError);
    const many = '[[rule]]\naction = "send"\ndecision = "ask"\n\n'.repeat(501);
    expect(() => parsePolicy(many)).toThrow(/more than 500/);
  });
});

describe("policy matching", () => {
  const rule = (extra: Partial<PolicyRule>): PolicyRule => ({ action: "send", decision: "ask", line: 1, endLine: 1, ...extra });

  it("matches app names case-insensitively with wildcards", () => {
    expect(ruleMatches(rule({ app: ["slack"] }), "send", { app: "Slack" })).toBe(true);
    expect(ruleMatches(rule({ app: ["sla*"] }), "send", { app: "Slack" })).toBe(true);
    expect(ruleMatches(rule({ app: ["*ck"] }), "send", { app: "Slack" })).toBe(true);
    expect(ruleMatches(rule({ app: ["Slack"] }), "send", { app: "Slack Beta" })).toBe(false);
    expect(ruleMatches(rule({ app: ["Slack"] }), "send", {})).toBe(false);
  });

  it("treats * as every app, even an unknown one", () => {
    expect(ruleMatches(rule({ app: ["*"] }), "send", {})).toBe(true);
  });

  it("matches a wildcard pattern in linear time", () => {
    const evil = "a*".repeat(100) + "b";
    const started = Date.now();
    expect(ruleMatches(rule({ app: [evil] }), "send", { app: "a".repeat(200) })).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("matches a site by host suffix, browser targets only", () => {
    const shopify = rule({ site: ["shopify.com"] });
    expect(ruleMatches(shopify, "send", { site: "admin.shopify.com" })).toBe(true);
    expect(ruleMatches(shopify, "send", { site: "shopify.com" })).toBe(true);
    expect(ruleMatches(shopify, "send", { site: "evilshopify.com" })).toBe(false);
    expect(ruleMatches(shopify, "send", { app: "Chrome" })).toBe(false);
  });

  it("any matches every action; a named action matches only itself", () => {
    expect(ruleMatches(rule({ action: "any" }), "delete", {})).toBe(true);
    expect(ruleMatches(rule({ action: "send" }), "delete", {})).toBe(false);
  });

  it("first matching rule wins", () => {
    const rules = parsePolicy('[[rule]]\napp = "Slack"\naction = "send"\ndecision = "never"\nnote = "no"\n\n[[rule]]\naction = "send"\ndecision = "allow"\n');
    const outcome = decidePolicy(rules, { tool: "desktop.click", input: {}, target: { app: "Slack" }, classification: { ...base, appSensitivity: "communication" } });
    expect(outcome).toMatchObject({ source: "policy_rule", decision: "never", ruleIndex: 1, line: 1, note: "no" });
    expect(auditPolicySource(outcome)).toBe("policy_rule:1");
    const other = decidePolicy(rules, { tool: "desktop.click", input: {}, target: { app: "Gmail" }, classification: { ...base, appSensitivity: "communication" } });
    expect(other).toMatchObject({ decision: "allow", ruleIndex: 2, line: 7, exact: true });
    expect(auditPolicySource(other)).toBe("policy_rule:7");
  });
});

describe("decision sources", () => {
  const rules = parsePolicy('[[rule]]\naction = "any"\ndecision = "allow"\n');
  it("a blocked tier or a floor is never decided by a rule", () => {
    expect(decidePolicy(rules, { tool: "file.write", input: {}, target: {}, classification: { ...base, riskLevel: "blocked" } }).source).toBe("floor");
    expect(decidePolicy(rules, { tool: "browser.type", input: {}, target: {}, classification: base, floor: true }).source).toBe("floor");
  });
  it("no matching rule leaves the decision to the classifier", () => {
    expect(decidePolicy([], { tool: "x.y", input: {}, target: {}, classification: base })).toMatchObject({ source: "classifier" });
    expect(decidePolicy(DEFAULT_POLICY_RULES, { tool: "x.y", input: {}, target: {}, classification: base }).source).toBe("classifier");
  });
  it("categorises calls", () => {
    expect(actionCategory("desktop.click", {}, { ...base, appSensitivity: "communication" })).toBe("send");
    expect(actionCategory("desktop.click", {}, { ...base, appSensitivity: "financial" })).toBe("pay");
    expect(actionCategory("file.delete", {}, { ...base, actionType: "file_delete" })).toBe("delete");
    expect(actionCategory("browser.upload", {}, base)).toBe("upload");
    expect(actionCategory("browser.navigate", {}, base)).toBe("navigate");
    expect(actionCategory("browser.type", {}, base)).toBe("type");
    expect(actionCategory("desktop.click", {}, base)).toBe("click");
    expect(actionCategory("browser.click", {}, { ...base, consequential: true, summary: 'Click "Place order"' })).toBe("pay");
    expect(actionCategory("see", {}, { ...base, stateChanging: false })).toBe("any");
  });
});

describe("policy file on disk", () => {
  it("writes the default file once and never overwrites an edit", async () => {
    const dir = await temp();
    expect(await ensurePolicyFile(dir)).toBe(true);
    expect(await readFile(policyFilePath(dir), "utf8")).toBe(DEFAULT_POLICY_TEXT);
    await writeFile(policyFilePath(dir), '# mine\n[[rule]]\naction = "any"\ndecision = "ask"\n');
    expect(await ensurePolicyFile(dir)).toBe(false);
    expect(await readFile(policyFilePath(dir), "utf8")).toContain("# mine");
  });

  it("uses built-in behaviour when the file is missing", async () => {
    const dir = await temp();
    const loaded = await loadPolicy(dir);
    expect(loaded.exists).toBe(false);
    expect(loaded.rules).toBe(DEFAULT_POLICY_RULES);
  });

  it("re-reads when the file changes and keeps the last good rules after a bad edit", async () => {
    const dir = await temp();
    const file = policyFilePath(dir);
    await writeFile(file, '[[rule]]\naction = "send"\ndecision = "never"\n');
    expect((await loadPolicy(dir)).rules[0]?.decision).toBe("never");
    await writeFile(file, '[[rule]]\naction = "send"\ndecision = "allow"\n');
    await utimes(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    expect((await loadPolicy(dir)).rules[0]?.decision).toBe("allow");
    await writeFile(file, '[[rule]]\naction = "send"\ndecision = "oops"\n');
    await utimes(file, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    const bad = await loadPolicy(dir);
    expect(bad.error?.line).toBe(3);
    expect(bad.rules[0]?.decision).toBe("allow");
  });
});
