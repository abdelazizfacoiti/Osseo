#!/usr/bin/env node
// Try to load the extension into headless Firefox through WebDriver BiDi (webExtension.install, type "path").
// Isolation: `-headless`, DISPLAY unset, MOZ_NO_REMOTE=1, HOME and -profile in a fresh temp dir; only the Firefox we start
// (and children carrying our profile path) are killed. The user's Firefox profile is never touched.
// Not tested here: the optional host permission (a user prompt), the content script, the native host.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, "../extension");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: " + label)), ms))]);
const results = [];
const record = (name, status, reason) => { results.push({ name, status }); console.log(`${status}: ${name} - ${reason}`); };

// Minimal WebSocket client (Node 20 has none built in).
function wsConnect(port, urlPath) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key } });
    req.on("response", (res) => reject(new Error("websocket upgrade refused: HTTP " + res.statusCode)));
    req.on("error", reject);
    req.on("upgrade", (_res, socket, head) => {
      const handlers = []; let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0); let text = [];
      const parse = () => {
        for (;;) {
          if (buf.length < 2) return;
          const fin = (buf[0] & 0x80) !== 0; const op = buf[0] & 0x0f; let len = buf[1] & 0x7f; let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len); buf = buf.subarray(off + len);
          if (op === 1 || op === 0) { text.push(payload); if (fin) { const s = Buffer.concat(text).toString("utf8"); text = []; handlers.forEach((h) => h(s)); } }
          else if (op === 9) socket.write(frame(10, payload));
        }
      };
      const frame = (op, payload) => {
        const mask = crypto.randomBytes(4); const n = payload.length;
        const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
        const masked = Buffer.alloc(n); for (let i = 0; i < n; i++) masked[i] = payload[i] ^ mask[i % 4];
        return Buffer.concat([head, mask, masked]);
      };
      socket.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
      parse();
      resolve({ send: (s) => socket.write(frame(1, Buffer.from(s, "utf8"))), onMessage: (h) => handlers.push(h), close: () => socket.destroy() });
    });
    req.end();
  });
}

function findFirefox() { try { return execFileSync("which", ["firefox"], { encoding: "utf8" }).trim(); } catch { return null; } }

async function main() {
  const firefox = findFirefox();
  if (!firefox) { record("firefox available", "NOT POSSIBLE", "no firefox on PATH"); return; }
  console.log("firefox: " + execFileSync(firefox, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH } }).trim());
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
  // Snap Firefox cannot read /tmp (private mount namespace: "Could not find profile folder"). Its common data dir is
  // readable, so the temp dir goes there and is removed in the finally. Never ~/.mozilla or the snap's own .mozilla.
  const snapCommon = path.join(os.homedir(), "snap", "firefox", "common");
  const isSnap = fs.realpathSync(firefox).startsWith("/snap/") || fs.existsSync(snapCommon);
  const base = isSnap && fs.existsSync(snapCommon) ? snapCommon : "/tmp";
  const tmp = fs.mkdtempSync(path.join(base, "ahf-"));
  console.log("temp dir base: " + base);
  const home = path.join(tmp, "home"); fs.mkdirSync(home, { recursive: true });
  const profile = path.join(tmp, "profile"); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, "user.js"), [
    'user_pref("browser.shell.checkDefaultBrowser", false);', 'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("app.update.auto", false);', 'user_pref("app.update.enabled", false);', 'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("remote.active-protocols", 1);'
  ].join("\n") + "\n");
  let child = null; let log = "";
  try {
    const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", MOZ_NO_REMOTE: "1", MOZ_CRASHREPORTER_DISABLE: "1", XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache") }; // no DISPLAY
    child = spawn(firefox, ["-headless", "-no-remote", "-profile", profile, "--remote-debugging-port=0", "about:blank"], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
    let exited = null; child.on("exit", (c, s) => { exited = `code ${c} signal ${s}`; });
    const portFile = path.join(profile, "DevToolsActivePort");
    let port = null; let wsPath = "/session";
    for (let i = 0; i < 100 && !port && !exited; i++) {
      if (fs.existsSync(portFile)) { const lines = fs.readFileSync(portFile, "utf8").split("\n"); if (lines[0] && /^\d+$/.test(lines[0].trim())) { port = Number(lines[0]); if (lines[1]) wsPath = lines[1].trim(); } }
      // Fallback: Firefox also prints "WebDriver BiDi listening on ws://127.0.0.1:<port>" (the port file is not written everywhere).
      if (!port) { const m = /WebDriver BiDi listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(log); if (m) port = Number(m[1]); }
      if (!port) await sleep(300);
    }
    if (!port) { record("BiDi endpoint", "NOT POSSIBLE", `no DevToolsActivePort in the temp profile and no BiDi port in the output${exited ? "; firefox exited: " + exited : ""}. Output: ${log.trim().slice(0, 400)}`); return; }
    console.log(`BiDi endpoint: 127.0.0.1:${port}${wsPath}`);
    let ws = null; let lastErr = "";
    for (let i = 0; i < 20 && !ws; i++) { try { ws = await wsConnect(port, wsPath); } catch (e) { lastErr = e.message; await sleep(500); } }
    if (!ws) { record("BiDi connect", "NOT POSSIBLE", lastErr); return; }
    let id = 0; const waiting = new Map();
    ws.onMessage((s) => { const m = JSON.parse(s); if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); w(m); } });
    const cmd = (method, params = {}) => withTimeout(new Promise((res) => { const n = ++id; waiting.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); }), 30000, method);

    const sess = await cmd("session.new", { capabilities: {} });
    if (sess.type === "error") { record("BiDi session", "NOT POSSIBLE", `session.new: ${sess.error}: ${sess.message}`); return; }
    console.log("BiDi session: " + JSON.stringify(sess.result).slice(0, 200));

    const install = await cmd("webExtension.install", { extensionData: { type: "path", path: extDir } });
    const bg = manifest.background || {};
    const bgDesc = `manifest has background.service_worker=${JSON.stringify(bg.service_worker)} and background.scripts=${JSON.stringify(bg.scripts)}`;
    if (install.type === "success") {
      record("webExtension.install (path)", "PASS", `Firefox accepted the manifest; reply ${JSON.stringify(install.result)}; ${bgDesc}; no manifest error returned for either background key. Optional host permission not granted (user prompt, not attempted).`);
      // List check: BiDi has no list command; ask the extension to confirm through a chrome-context-free route is not possible, so uninstall proves it was installed.
      const id0 = install.result && install.result.extension;
      if (id0) {
        const un = await cmd("webExtension.uninstall", { extension: id0 });
        record("installed add-on present", un.type === "success" ? "PASS" : "FAIL", `webExtension.uninstall of ${id0} -> ${un.type === "success" ? "success (it was installed)" : JSON.stringify(un)}`);
      }
    } else {
      record("webExtension.install (path)", "NOT POSSIBLE", `${install.error}: ${install.message}. ${bgDesc}. Optional host permission not attempted (user prompt).`);
    }
    ws.close();
  } catch (error) {
    record("harness", "FAIL", error.message + (log ? " | firefox output: " + log.trim().slice(0, 300) : ""));
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    await sleep(800);
    // Content processes carry our temp profile path in their command line; match only that.
    try { execFileSync("pkill", ["-KILL", "-f", "--", profile]); } catch { /* none left */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await main();
console.log("Scope: install through BiDi only. The host permission grant, content script in a page, and native host were not tested on Firefox.");
process.exit(results.length && results.every((r) => r.status !== "FAIL") && results.some((r) => r.status === "PASS") ? 0 : 1);
