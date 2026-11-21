import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs module
import { FrameDecoder, MAX_MESSAGE_BYTES, checkRequest, encodeFrame, filterTabsForAllowedHosts, hostAllowed, isPlainHostname, validateRequest } from "../protocol.mjs";
// @ts-expect-error plain .mjs module
import { createRelay } from "../../host/native-host.mjs";

const root = path.resolve(__dirname, "../..");
const base = { id: "1", tabId: 3, host: "example.com" };

describe("framing", () => {
  it("round trips", () => {
    const d = new FrameDecoder();
    expect(d.push(encodeFrame({ a: 1, b: "é" }))).toEqual([{ a: 1, b: "é" }]);
  });
  it("handles a frame split across three chunks", () => {
    const frame: Buffer = encodeFrame({ hello: "world" });
    const d = new FrameDecoder();
    expect(d.push(frame.subarray(0, 2))).toEqual([]);
    expect(d.push(frame.subarray(2, 7))).toEqual([]);
    expect(d.push(frame.subarray(7))).toEqual([{ hello: "world" }]);
  });
  it("handles two frames in one chunk", () => {
    const d = new FrameDecoder();
    expect(d.push(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })]))).toEqual([{ n: 1 }, { n: 2 }]);
  });
  it("rejects a length above 1 MB", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(header)).toThrow("message_too_large");
    expect(() => encodeFrame({ x: "a".repeat(MAX_MESSAGE_BYTES) })).toThrow("message_too_large");
  });
});

describe("validation", () => {
  it("accepts each listed type", () => {
    expect(validateRequest({ ...base, type: "snapshot" }).ok).toBe(true);
    expect(validateRequest({ ...base, type: "read" }).ok).toBe(true);
    expect(validateRequest({ ...base, type: "click", ref: "s1-e0" }).ok).toBe(true);
    expect(validateRequest({ ...base, type: "type", ref: "s1-e0", text: "hi" }).ok).toBe(true);
    expect(validateRequest({ ...base, type: "select", ref: "s1-e0", value: "a" }).ok).toBe(true);
    expect(validateRequest({ ...base, type: "navigate", url: "https://example.com/x" }).ok).toBe(true);
  });
  it("accepts tabs without a tabId or host", () => {
    expect(validateRequest({ id: "1", type: "tabs" })).toEqual({ ok: true, request: { id: "1", type: "tabs" } });
    expect(checkRequest({ id: "1", type: "tabs" }, [])).toEqual({ ok: true, request: { id: "1", type: "tabs" } });
  });
  it("refuses an unknown type", () => {
    expect(validateRequest({ ...base, type: "cookies" })).toEqual({ ok: false, reason: "unknown_type" });
  });
  it("refuses a missing tabId", () => {
    expect(validateRequest({ id: "1", type: "snapshot", host: "example.com" })).toEqual({ ok: false, reason: "bad_tab_id" });
  });
  it("requires a plain hostname", () => {
    for (const host of ["javascript:alert(1)", "example.com/path", "example.com:8080", "exa mple.com", "", "https://example.com", "user@example.com"]) {
      expect(validateRequest({ ...base, host, type: "snapshot" }), host).toEqual({ ok: false, reason: "bad_host" });
      expect(isPlainHostname(host)).toBe(false);
    }
  });
  it("refuses non-http navigation and a missing ref", () => {
    expect(validateRequest({ ...base, type: "navigate", url: "javascript:alert(1)" }).reason).toBe("bad_url");
    expect(validateRequest({ ...base, type: "click" }).reason).toBe("missing_field");
  });
});

describe("allowed hosts", () => {
  it("matches exact and subdomain, not look-alikes", () => {
    expect(hostAllowed("example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("shop.example.com", ["example.com"])).toBe(true);
    expect(hostAllowed("evil-example.com", ["example.com"])).toBe(false);
    expect(hostAllowed("example.com.evil.io", ["example.com"])).toBe(false);
    expect(hostAllowed("example.com", [])).toBe(false);
  });
  it("checks the navigation target too", () => {
    const req = { ...base, type: "navigate", url: "https://other.org/" };
    expect(checkRequest(req, ["example.com"])).toEqual({ ok: false, reason: "host_not_allowed" });
  });
});

describe("filterTabsForAllowedHosts", () => {
  const allowed = ["example.com"];
  it("keeps exact and subdomain hosts, drops look-alikes and other hosts", () => {
    const out = filterTabsForAllowedHosts([
      { tabId: 1, host: "example.com", title: "a" },
      { tabId: 2, host: "shop.example.com", title: "b" },
      { tabId: 3, host: "evil-example.com", title: "c" },
      { tabId: 4, host: "example.com.evil.io", title: "d" },
      { tabId: 5, host: "other.org", title: "e" }
    ], allowed);
    expect(out.map((t: { tabId: number }) => t.tabId)).toEqual([1, 2]);
  });
  it("cuts titles to 80 characters and never outputs a url", () => {
    const out = filterTabsForAllowedHosts([{ tabId: 1, host: "example.com", title: "x".repeat(300), url: "https://example.com/p?q=1" }], allowed);
    expect(out[0].title).toHaveLength(80);
    expect(Object.keys(out[0]).sort()).toEqual(["host", "tabId", "title"]);
    expect(JSON.stringify(out)).not.toContain("https://");
  });
  it("returns nothing for a bad input or an empty allow list", () => {
    expect(filterTabsForAllowedHosts("nope", allowed)).toEqual([]);
    expect(filterTabsForAllowedHosts([{ tabId: 1, host: "example.com", title: "a" }], [])).toEqual([]);
    expect(filterTabsForAllowedHosts([{ tabId: -1, host: "example.com", title: "a" }, null, { host: "example.com" }], allowed)).toEqual([]);
  });
});

describe("native host relay", () => {
  it("filters a tabs reply by the allow list and strips other fields", () => {
    const sent: Buffer[] = [];
    const replies: any[] = [];
    const relay = createRelay({ getAllowedHosts: () => ["example.com"], toExtension: (f: Buffer) => sent.push(f) });
    relay.fromClient({ id: "7", type: "tabs" }, (r: unknown) => replies.push(r));
    expect(sent).toHaveLength(1);
    const forwarded = new FrameDecoder().push(sent[0])[0];
    expect(forwarded).toMatchObject({ type: "tabs" });
    relay.fromExtension({ id: forwarded.id, ok: true, tabs: [{ tabId: 1, host: "example.com", title: "A", url: "https://example.com/x" }, { tabId: 2, host: "other.org", title: "B" }] });
    expect(replies[0]).toEqual({ id: "7", ok: true, tabs: [{ tabId: 1, host: "example.com", title: "A" }] });
  });
  it("rejects a disallowed host without contacting the extension, and relays an allowed one", () => {
    const sent: Buffer[] = [];
    const replies: unknown[] = [];
    const relay = createRelay({ getAllowedHosts: () => ["example.com"], toExtension: (f: Buffer) => sent.push(f) });
    relay.fromClient({ ...base, host: "evil.com", type: "snapshot" }, (r: unknown) => replies.push(r));
    expect(sent).toHaveLength(0);
    expect(replies[0]).toMatchObject({ ok: false, reason: "host_not_allowed" });
    relay.fromClient({ ...base, type: "snapshot" }, (r: unknown) => replies.push(r));
    expect(sent).toHaveLength(1);
    const forwarded = new FrameDecoder().push(sent[0])[0];
    relay.fromExtension({ id: forwarded.id, ok: true, elements: [] });
    expect(replies[1]).toEqual({ id: "1", ok: true, elements: [] });
  });
});

describe("extension files", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
  it("has no broad host access", () => {
    const text = JSON.stringify(manifest);
    expect(text).not.toContain("<all_urls>");
    expect(manifest.host_permissions).toBeUndefined();
  });
  it("lists only the expected permissions", () => {
    // "storage" is added to the four named in the brief: the popup writes the allowed hosts to chrome.storage.local.
    expect([...manifest.permissions].sort()).toEqual(["activeTab", "nativeMessaging", "scripting", "storage", "tabs"]);
  });
  it("keeps the two copies of hostAllowed identical", () => {
    const block = (file: string) => {
      const text = fs.readFileSync(file, "utf8");
      return text.slice(text.indexOf("// BEGIN hostAllowed"), text.indexOf("// END hostAllowed"));
    };
    const bg = block(path.join(root, "extension/background.js"));
    expect(bg).toContain("function hostAllowed");
    const src = fs.readFileSync(path.join(root, "src/protocol.mjs"), "utf8");
    const from = src.indexOf("const HOST_PATTERN");
    const to = src.indexOf("/** Returns { ok: true, request }");
    const lines = (s: string) => s.split("\n").map((l) => l.replace(/^export /, "")).filter((l) => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("/**"));
    const protocolLines = lines(src.slice(from, to)).filter((l) => !l.includes("validateRequest"));
    const bgLines = lines(bg);
    expect(bgLines).toEqual(protocolLines);
  });
  it("content script never touches cookies or page storage", () => {
    const code = fs.readFileSync(path.join(root, "extension/content.js"), "utf8");
    expect(code).not.toMatch(/document\.cookie|localStorage|sessionStorage|indexedDB/);
  });
});

describe("install script", () => {
  const script = path.join(root, "host/install-host.mjs");
  it("writes nothing without --apply", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ext-"));
    const out = execFileSync("node", [script, "--browser", "firefox"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(out).toContain("Would write");
    expect(fs.readdirSync(home)).toEqual([]);
    fs.rmSync(home, { recursive: true });
  });
  it("writes inside the home folder with --apply", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ah-ext-"));
    execFileSync("node", [script, "--browser", "chromium", "--extension-id", "a".repeat(32), "--apply"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    const file = path.join(home, ".config/chromium/NativeMessagingHosts/dev.osseo.browser.json");
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.allowed_origins).toEqual([`chrome-extension://${"a".repeat(32)}/`]);
    expect(written.path).not.toContain("__HOST_PATH__");
    fs.rmSync(home, { recursive: true });
  });
});
