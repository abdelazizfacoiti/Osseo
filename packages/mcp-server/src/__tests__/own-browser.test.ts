import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultPolicy, invalidatePolicyCache, type AuditLogEntry, type ToolExecutionMetadata } from "@agenthost/core";
import type { AgentHostMcpContext } from "../context.js";
import { FrameDecoder, encodeFrame } from "../browser-extension-client.js";
import { runTool } from "../tool-runner.js";
import { createOwnBrowserTools } from "../tools/own-browser.js";

const base = { externalEffect: false, requiresDryRun: false, requiresConfirmationToken: false, requiresExactTarget: false, source: "base", availability: "available", requiredBindings: [], confirmationLevel: "none", cleanupKind: "none" } as const;
const readOnly = { ...base, executionClass: "read_only", operationFamily: "observe", operation: "inspect", reversibility: "reversible", sensitivity: "normal", verificationKind: "none" } as unknown as ToolExecutionMetadata;
const changing = { ...base, executionClass: "state_changing", operationFamily: "state_change", operation: "governed_action", reversibility: "persistent", sensitivity: "normal", verificationKind: "tool_result" } as unknown as ToolExecutionMetadata;
const tools = new Map(createOwnBrowserTools().map((t) => [t.name, { ...t, execution: /own_(snapshot|read|tabs)$/.test(t.name) ? readOnly : changing }]));
const tool = (name: string) => tools.get(name)!;

const cleanup: Array<() => Promise<void> | void> = [];
const saved = { socket: process.env.AGENTHOST_BROWSER_SOCKET, allowed: process.env.AGENTHOST_BROWSER_ALLOWED_HOSTS_FILE };
beforeEach(() => { delete process.env.AGENTHOST_BROWSER_SOCKET; delete process.env.AGENTHOST_BROWSER_ALLOWED_HOSTS_FILE; invalidatePolicyCache(); });
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  if (saved.socket === undefined) delete process.env.AGENTHOST_BROWSER_SOCKET; else process.env.AGENTHOST_BROWSER_SOCKET = saved.socket;
  if (saved.allowed === undefined) delete process.env.AGENTHOST_BROWSER_ALLOWED_HOSTS_FILE; else process.env.AGENTHOST_BROWSER_ALLOWED_HOSTS_FILE = saved.allowed;
});

interface Env { home: string; entries: AuditLogEntry[]; ctx: AgentHostMcpContext; received: Array<Record<string, unknown>> }

/** A temp agent home with a policy file and a fake native host on run/browser-extension.sock. */
async function setup(policy: string, reply: (m: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true })): Promise<Env> {
  const home = await mkdtemp(path.join(os.tmpdir(), "ah-own-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "policy.toml"), policy);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(home, "run"), { recursive: true });
  const received: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const message of decoder.push(chunk) as Array<Record<string, unknown>>) {
        received.push(message);
        socket.write(encodeFrame({ id: message.id, ...reply(message) }));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path.join(home, "run", "browser-extension.sock"), resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const entries: AuditLogEntry[] = [];
  const ctx = {
    sessionId: "own-browser-test",
    config: { agentHostDir: home, configPath: path.join(home, "config.json"), logFile: path.join(home, "logs", "audit.jsonl") },
    policy: getDefaultPolicy(),
    logger: { log: async (entry: AuditLogEntry) => { entries.push(entry); } },
    linux: {}
  } as unknown as AgentHostMcpContext;
  return { home, entries, ctx, received };
}

const allow = (site: string) => `[[rule]]\nsite = "${site}"\naction = "any"\ndecision = "allow"\n`;
const snapshot = (env: Env, host = "example.com") => runTool(tool("browser.own_snapshot"), { tabId: 1, host }, env.ctx);

describe("own browser tools", () => {
  it("registers the six tools and the tab list", () => {
    expect([...tools.keys()].sort()).toEqual(["browser.own_click", "browser.own_navigate", "browser.own_read", "browser.own_select", "browser.own_snapshot", "browser.own_tabs", "browser.own_type"]);
  });

  it("refuses a host with no rule before anything is sent", async () => {
    const env = await setup(allow("example.com"));
    const result = await snapshot(env, "other.org");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("host_not_allowed");
    expect(env.received).toEqual([]);
    const none = await setup("");
    expect((await snapshot(none)).error?.code).toBe("host_not_allowed");
    expect(none.received).toEqual([]);
  });

  it("passes a host with an allow rule and returns the extension's fields", async () => {
    const env = await setup(allow("example.com"), () => ({ ok: true, url: "https://example.com/", elements: [{ ref: "s1-e0", role: "button", name: "Go" }] }));
    const result = await snapshot(env);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ ok: true, elements: [{ ref: "s1-e0", role: "button", name: "Go" }] });
    expect(env.received).toHaveLength(1);
    expect(env.received[0]).toMatchObject({ type: "snapshot", tabId: 1, host: "example.com" });
  });

  it("refuses a host that a never rule names first, and uses first match", async () => {
    const env = await setup(`[[rule]]\nsite = "example.com"\naction = "any"\ndecision = "never"\n\n${allow("example.com")}`);
    expect((await snapshot(env)).error?.code).toBe("host_not_allowed");
    const askFirst = await setup(`[[rule]]\nsite = "example.com"\naction = "any"\ndecision = "ask"\n\n${allow("example.com")}`);
    expect((await snapshot(askFirst)).error?.code).toBe("host_not_allowed");
    expect(env.received.length + askFirst.received.length).toBe(0);
  });

  it("lets a suffix rule match subdomains only", async () => {
    const env = await setup(allow("example.com"));
    expect((await snapshot(env, "app.example.com")).ok).toBe(true);
    expect((await snapshot(env, "evil-example.com")).error?.code).toBe("host_not_allowed");
    expect((await snapshot(env, "example.com.evil.org")).error?.code).toBe("host_not_allowed");
    expect(env.received).toHaveLength(1);
  });

  it("refuses a host that is not a plain hostname", async () => {
    const env = await setup(allow("example.com"));
    for (const host of ["https://example.com", "example.com/path", "example.com:8080", "user@example.com", "Example.com"]) {
      expect((await snapshot(env, host)).error?.code).toBe("bad_host");
    }
    expect(env.received).toEqual([]);
  });

  it("requires the navigation target to be allowed too", async () => {
    const env = await setup(allow("example.com"));
    const bad = await runTool(tool("browser.own_navigate"), { tabId: 1, host: "example.com", url: "https://other.org/" }, env.ctx);
    expect(bad.error?.code).toBe("host_not_allowed");
    expect(env.received).toEqual([]);
    const good = await runTool(tool("browser.own_navigate"), { tabId: 1, host: "example.com", url: "https://www.example.com/x?token=abc" }, env.ctx);
    expect(good.ok).toBe(true);
    expect(env.received[0]).toMatchObject({ type: "navigate", url: "https://www.example.com/x?token=abc" });
  });

  it("passes refusal reasons through unchanged with no field value", async () => {
    for (const reason of ["password_field", "sensitive_autocomplete", "sensitive_name", "ref_stale", "host_not_allowed"]) {
      const env = await setup(allow("example.com"), () => ({ ok: false, reason, value: "hunter2-secret", text: "hunter2-secret" }));
      const result = await runTool(tool("browser.own_type"), { tabId: 1, host: "example.com", ref: "s1-e1", text: "hunter2-secret" }, env.ctx);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(reason);
      expect(JSON.stringify(result)).not.toContain("hunter2-secret");
    }
  });

  it("replaces an odd reason from the extension", async () => {
    const env = await setup(allow("example.com"), () => ({ ok: false, reason: "field says: hunter2" }));
    const result = await snapshot(env);
    expect(result.error?.code).toBe("extension_error");
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("reports extension_not_running when the host has no socket", async () => {
    const env = await setup(allow("example.com"));
    process.env.AGENTHOST_BROWSER_SOCKET = path.join(env.home, "run", "missing.sock");
    const result = await snapshot(env);
    expect(result.error?.code).toBe("extension_not_running");
  });

  it("never logs typed text, only its length", async () => {
    const env = await setup(allow("example.com"));
    const text = "my-private-sentence";
    const result = await runTool(tool("browser.own_type"), { tabId: 1, host: "example.com", ref: "s1-e1", text }, env.ctx);
    expect(result.ok).toBe(true);
    expect(env.received[0]).toMatchObject({ type: "type", text });
    expect(env.entries.length).toBeGreaterThan(0);
    const logged = JSON.stringify(env.entries);
    expect(logged).not.toContain(text);
    expect(logged).toContain(`Type ${text.length} characters`);
    const select = await runTool(tool("browser.own_select"), { tabId: 1, host: "example.com", ref: "s1-e2", value: "secret-option" }, env.ctx);
    expect(select.ok).toBe(true);
    expect(JSON.stringify(env.entries)).not.toContain("secret-option");
  });

  it("applies a type rule: never refuses, ask needs a confirmation", async () => {
    const never = await setup(`[[rule]]\nsite = "example.com"\naction = "type"\ndecision = "never"\n\n${allow("example.com")}`);
    const refused = await runTool(tool("browser.own_type"), { tabId: 1, host: "example.com", ref: "s1-e1", text: "x" }, never.ctx);
    expect(refused.ok).toBe(false);
    expect(never.received).toEqual([]);
    const ask = await setup(`[[rule]]\nsite = "example.com"\naction = "click"\ndecision = "ask"\n\n${allow("example.com")}`);
    const held = await runTool(tool("browser.own_click"), { tabId: 1, host: "example.com", ref: "s1-e1" }, ask.ctx);
    expect(held.ok).toBe(false);
    expect(ask.received).toEqual([]);
  });

  it("lists tabs from the extension, only on allowed hosts and only three fields", async () => {
    const env = await setup(allow("example.com"), () => ({ ok: true, tabs: [
      { tabId: 1, host: "example.com", title: "Home", url: "https://example.com/secret?x=1" },
      { tabId: 2, host: "shop.example.com", title: "t".repeat(200) },
      { tabId: 3, host: "other.org", title: "Not allowed" },
      { tabId: 4, host: "evil-example.com", title: "Lookalike" }
    ] }));
    const result = await runTool(tool("browser.own_tabs"), {}, env.ctx);
    expect(result.ok).toBe(true);
    const data = result.data as { ok: boolean; tabs: Array<Record<string, unknown>> };
    expect(data.ok).toBe(true);
    expect(data.tabs.map((t) => t.tabId)).toEqual([1, 2]);
    expect(data.tabs.every((t) => Object.keys(t).sort().join() === "host,tabId,title")).toBe(true);
    expect((data.tabs[1]!.title as string).length).toBe(80);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(env.received[0]).toMatchObject({ type: "tabs" });
  });

  it("returns extension_not_running when there is no socket", async () => {
    const env = await setup(allow("example.com"));
    process.env.AGENTHOST_BROWSER_SOCKET = path.join(env.home, "run", "missing.sock");
    const result = await runTool(tool("browser.own_tabs"), {}, env.ctx);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("extension_not_running");
  });

  it("passes on the extension's reason", async () => {
    const env = await setup(allow("example.com"), () => ({ ok: false, reason: "timeout" }));
    expect((await runTool(tool("browser.own_tabs"), {}, env.ctx)).error?.code).toBe("timeout");
  });

});

describe("allowed-hosts file", () => {
  it("is written 0600 with only allow-rule hosts, and rewritten only when policy.toml changes", async () => {
    const env = await setup(`${allow("example.com")}\n[[rule]]\nsite = "denied.org"\naction = "any"\ndecision = "never"\n\n[[rule]]\nsite = "asked.org"\naction = "any"\ndecision = "ask"\n\n[[rule]]\nsite = "typing.org"\naction = "type"\ndecision = "allow"\n`);
    const file = path.join(env.home, "browser-extension", "allowed-hosts.json");
    await snapshot(env);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(["example.com"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // Same policy, many calls: the file is not touched.
    const old = new Date(Date.now() - 60_000);
    await utimes(file, old, old);
    await snapshot(env);
    await snapshot(env, "other.org");
    expect((await stat(file)).mtimeMs).toBeLessThan(Date.now() - 30_000);

    // A touched policy file with the same hosts does not rewrite it either.
    await writeFile(path.join(env.home, "policy.toml"), `# comment\n${allow("example.com")}`);
    await snapshot(env);
    expect((await stat(file)).mtimeMs).toBeLessThan(Date.now() - 30_000);

    // A new allow rule changes the file.
    await writeFile(path.join(env.home, "policy.toml"), `${allow("example.com")}\n${allow("second.org")}`);
    await snapshot(env, "second.org");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(["example.com", "second.org"]);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    // Removing every allow rule empties it.
    await writeFile(path.join(env.home, "policy.toml"), `[[rule]]\naction = "send"\ndecision = "ask"\n`);
    await snapshot(env);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([]);
  });
});
