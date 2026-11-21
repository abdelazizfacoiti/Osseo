#!/usr/bin/env node
// Real headless Chrome check of the browser extension bridge. Not a unit test; vitest does not run it.
// Isolation: headless=new only, DISPLAY unset, HOME and --user-data-dir in a fresh temp dir, only the Chrome we start is killed.
// Exit code 0 only when steps 1 to 3 pass. Firefox is never run.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFrame, FrameDecoder } from "../src/protocol.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(here, "../extension");
const hostScript = path.resolve(here, "../host/native-host.mjs");
const HOST_NAME = "dev.osseo.browser";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (step, status, reason) => { results.push({ step, status, reason }); console.log(`${step}: ${status} - ${reason}`); };
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: " + label)), ms))]);

function findChrome() {
  for (const c of ["google-chrome-stable", "google-chrome"]) {
    try { return execFileSync("which", [c], { encoding: "utf8" }).trim(); } catch { /* next */ }
  }
  return null;
}

class Pipe {
  constructor(child) {
    this.id = 0; this.waiting = new Map(); this.buf = ""; this.events = [];
    child.stdio[4].on("data", (d) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!raw) continue;
        const m = JSON.parse(raw);
        if (m.id && this.waiting.has(m.id)) { const w = this.waiting.get(m.id); this.waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
        else this.events.push(m);
      }
    });
    this.out = child.stdio[3];
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return withTimeout(new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); }), 20000, method);
  }
}

async function evalIn(pipe, sessionId, expression, userGesture = false) {
  const r = await pipe.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

function socketRequest(sock, message, ms = 8000) {
  return withTimeout(new Promise((res, rej) => {
    const c = net.createConnection(sock);
    const dec = new FrameDecoder();
    c.on("connect", () => c.write(encodeFrame(message)));
    c.on("data", (d) => { try { const [m] = dec.push(d); if (m) { c.end(); res(m); } } catch (e) { rej(e); } });
    c.on("error", rej);
  }), ms, "socket " + message.type);
}

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const osseoDir = path.join(os.homedir(), ".osseo");
const fingerprint = () => { try { return execFileSync("sh", ["-c", `find '${osseoDir}' -printf '%p %T@ %s\\n' 2>/dev/null | sort | md5sum`], { encoding: "utf8" }).trim(); } catch { return "unreadable"; } };

async function main() {
  const chrome = findChrome();
  if (!chrome) { record("1 manifest loads", "NOT POSSIBLE", "no google-chrome-stable on PATH"); return; }
  const version = execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim();
  console.log("chrome: " + version);
  const before = fingerprint();
  const tmp = fs.mkdtempSync(path.join("/tmp", "ahx-"));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const profile = path.join(tmp, "profile");
  let child = null; let server = null;
  try {
    // Local test page.
    const pageDir = path.join(tmp, "www");
    fs.mkdirSync(pageDir);
    fs.writeFileSync(path.join(pageDir, "index.html"), `<!doctype html><title>Check page</title><label for="user">User</label><input id="user" type="text"><br><label for="pw">Pass</label><input id="pw" type="password"><br><button id="go">Go</button>`);
    const port = await freePort();
    server = spawn("python3", ["-I", "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", pageDir], { stdio: "ignore", env: { PATH: process.env.PATH, HOME: home } });
    await sleep(800);

    const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", XDG_CONFIG_HOME: path.join(home, ".config") };
    const baseArgs = ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`, `--load-extension=${extDir}`, "about:blank"];
    child = spawn(chrome, baseArgs, { env, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const pipe = new Pipe(child);
    await pipe.send("Target.setDiscoverTargets", { discover: true });

    const findSw = async () => {
      const { targetInfos } = await pipe.send("Target.getTargets");
      return targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("background.js"));
    };
    let sw = null; let loadedBy = "--load-extension";
    for (let i = 0; i < 20 && !sw; i++) { sw = await findSw(); if (!sw) await sleep(300); }
    if (!sw) {
      // Branded Chrome ignores --load-extension in recent versions; try the debugging protocol.
      try {
        await pipe.send("Extensions.loadUnpacked", { path: extDir });
        loadedBy = "Extensions.loadUnpacked (--load-extension was ignored)";
      } catch (e) { loadedBy = "none: " + e.message; }
      for (let i = 0; i < 20 && !sw; i++) { sw = await findSw(); if (!sw) await sleep(300); }
    }
    if (!sw) {
      record("1 manifest loads", "FAIL", "no extension target appeared; loaded by " + loadedBy);
      record("2 service worker starts", "FAIL", "no service_worker target ending in background.js");
      return;
    }
    const extId = new URL(sw.url).host;
    record("1 manifest loads", "PASS", `loaded by ${loadedBy}; extension id ${extId}; manifest accepted (MV3, service worker present)`);
    record("2 service worker starts", "PASS", sw.url);

    const attach = async (targetId) => (await pipe.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    const swSession = await attach(sw.targetId);
    await pipe.send("Runtime.enable", {}, swSession);
    const manifestSeen = await evalIn(pipe, swSession, "JSON.stringify({name: chrome.runtime.getManifest().name, v: chrome.runtime.getManifest().manifest_version})");
    console.log("manifest as seen by Chrome: " + manifestSeen);

    // Step 3: host manifest in the temp HOME, launcher script, then a real connectNative round trip.
    const launcher = path.join(tmp, "host-launcher.sh");
    fs.writeFileSync(launcher, `#!/bin/sh\nexec node '${hostScript.replace(/'/g, "'\\''")}'\n`, { mode: 0o755 });
    const hostManifest = { name: HOST_NAME, description: "Osseo browser bridge (check)", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] };
    const nmDir = path.join(home, ".config", "google-chrome", "NativeMessagingHosts");
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, HOST_NAME + ".json"), JSON.stringify(hostManifest));
    const altDir = path.join(profile, "NativeMessagingHosts");
    fs.mkdirSync(altDir, { recursive: true });
    fs.writeFileSync(path.join(altDir, HOST_NAME + ".json"), JSON.stringify(hostManifest));
    const allowedFile = path.join(home, ".osseo", "browser-extension", "allowed-hosts.json");
    fs.mkdirSync(path.dirname(allowedFile), { recursive: true });
    fs.writeFileSync(allowedFile, JSON.stringify([]));
    const sock = path.join(home, ".osseo", "run", "browser-extension.sock");

    // The background script's own connect() ran at start-up, before the manifest existed. Run it again.
    const portBefore = await evalIn(pipe, swSession, "typeof port === 'undefined' ? 'no port variable' : String(port !== null)");
    await evalIn(pipe, swSession, "(() => { connect(); return true; })()");
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { up = fs.existsSync(sock); if (!up) await sleep(300); }
    if (!up) {
      record("3 native host", "FAIL", `host socket never appeared at ${sock} (port was connected before: ${portBefore})`);
      return;
    }
    const tabsReply = await socketRequest(sock, { id: "t1", type: "tabs" }).catch((e) => ({ error: e.message }));
    const refusal = await socketRequest(sock, { id: "u1", type: "frobnicate" }).catch((e) => ({ error: e.message }));
    const tabsOk = tabsReply && tabsReply.id === "t1" && tabsReply.ok === true && Array.isArray(tabsReply.tabs) && tabsReply.tabs.length === 0;
    const refused = refusal && refusal.ok === false && typeof refusal.reason === "string";
    if (tabsOk && refused) record("3 native host", "PASS", `socket -> host -> real connectNative -> service worker -> back: tabs reply ${JSON.stringify(tabsReply)}; unknown type refused with ${JSON.stringify(refusal)}`);
    else record("3 native host", "FAIL", `tabs reply ${JSON.stringify(tabsReply)}; refusal ${JSON.stringify(refusal)}`);

    // Step 6 (storage, tabs.query) and the tab setup.
    const host = "127.0.0.1";
    const url = `http://${host}:${port}/index.html`;
    const created = await pipe.send("Target.createTarget", { url });
    await sleep(1000);
    const tabsQuery = await evalIn(pipe, swSession, `chrome.tabs.query({}).then((t) => JSON.stringify(t.map((x) => ({ id: x.id, url: x.url, title: x.title }))))`);
    const tabList = JSON.parse(tabsQuery);
    const pageTab = tabList.find((t) => t.url === url);

    // Step 4: optional host permission, from the popup page, with a user gesture.
    const popup = await pipe.send("Target.createTarget", { url: `chrome-extension://${extId}/popup.html` });
    const popupSession = await attach(popup.targetId);
    await pipe.send("Runtime.enable", {}, popupSession);
    const origins = [`http://${host}/*`, `https://${host}/*`];
    let granted = null; let grantNote = "";
    try {
      const out = await withTimeout(evalIn(pipe, popupSession, `chrome.permissions.request({ origins: ${JSON.stringify(origins)} })`, true), 10000, "permissions.request");
      granted = out === true;
      grantNote = "permissions.request returned " + out;
    } catch (e) { grantNote = "permissions.request: " + e.message; }
    const contains = await evalIn(pipe, swSession, `chrome.permissions.contains({ origins: ${JSON.stringify(origins)} })`).catch((e) => "error " + e.message);
    if (granted && contains === true) record("4 host permission", "PASS", `${grantNote}; permissions.contains true for ${origins.join(", ")}`);
    else record("4 host permission", "NOT POSSIBLE", `${grantNote}; permissions.contains ${contains}. The request did not resolve in headless Chrome (no way to accept the prompt here); the grant was not faked`);

    // Step 6: storage + allow list behaviour.
    let s6 = [];
    await evalIn(pipe, swSession, `chrome.storage.local.set({ allowedHosts: ["${host}"] })`);
    const stored = await evalIn(pipe, swSession, `chrome.storage.local.get("allowedHosts").then((s) => JSON.stringify(s.allowedHosts))`);
    fs.writeFileSync(allowedFile, JSON.stringify([host]));
    const tabsAllowed = await socketRequest(sock, { id: "t2", type: "tabs" }).catch((e) => ({ error: e.message }));
    const listed = tabsAllowed.ok && Array.isArray(tabsAllowed.tabs) && tabsAllowed.tabs.length === 1 && tabsAllowed.tabs[0].host === host && tabsAllowed.tabs[0].title === "Check page" && !("url" in tabsAllowed.tabs[0]);
    await evalIn(pipe, swSession, `chrome.storage.local.set({ allowedHosts: [] })`);
    const tabsNone = await socketRequest(sock, { id: "t3", type: "tabs" }).catch((e) => ({ error: e.message }));
    fs.writeFileSync(allowedFile, JSON.stringify([host]));
    const notAllowedSnap = await socketRequest(sock, { id: "n1", type: "snapshot", tabId: pageTab ? pageTab.id : 0, host }).catch((e) => ({ error: e.message }));
    await evalIn(pipe, swSession, `chrome.storage.local.set({ allowedHosts: ["${host}"] })`);
    const storageOk = stored === JSON.stringify([host]);
    const emptiesOk = tabsNone.ok === true && tabsNone.tabs.length === 0;
    const refusedOk = notAllowedSnap.ok === false && notAllowedSnap.reason === "host_not_allowed";
    const queryOk = !!pageTab;
    if (storageOk && listed && emptiesOk && refusedOk && queryOk) record("6 tabs.query and allow list", "PASS", `tabs.query saw the page tab ${pageTab.id}; storage round trip ${stored}; allowed -> tabs reply ${JSON.stringify(tabsAllowed.tabs)} (hostname and 80-char title only); storage emptied -> tabs [] and snapshot refused ${notAllowedSnap.reason}`);
    else record("6 tabs.query and allow list", "FAIL", `queryOk ${queryOk}, storage ${stored}, allowed reply ${JSON.stringify(tabsAllowed)}, emptied reply ${JSON.stringify(tabsNone)}, snapshot after emptying ${JSON.stringify(notAllowedSnap)}`);

    // Step 5: content script.
    if (!(granted && contains === true)) {
      record("5 content script refusal", "NOT POSSIBLE", "step 4 grant was not possible, so chrome.scripting.executeScript has no host access; the background would answer page_unavailable. Not faked");
    } else {
      const snap = await socketRequest(sock, { id: "s1", type: "snapshot", tabId: pageTab.id, host });
      const els = Array.isArray(snap.elements) ? snap.elements : [];
      const pw = els.find((e) => e.refused === "password_field");
      const user = els.find((e) => e.role === "textbox" && !e.refused);
      if (!snap.ok || !pw || !user) record("5 content script refusal", "FAIL", "snapshot " + JSON.stringify(snap));
      else {
        const typedPw = await socketRequest(sock, { id: "s2", type: "type", tabId: pageTab.id, host, ref: pw.ref, text: "x" });
        const typedUser = await socketRequest(sock, { id: "s3", type: "type", tabId: pageTab.id, host, ref: user.ref, text: "hello" });
        const pageTarget = (await pipe.send("Target.getTargets")).targetInfos.find((t) => t.url === url);
        const pSession = await attach(pageTarget.targetId);
        const values = await evalIn(pipe, pSession, `JSON.stringify({ user: document.getElementById("user").value, pw: document.getElementById("pw").value })`);
        const good = typedPw.ok === false && typedPw.reason === "password_field" && typedUser.ok === true && JSON.parse(values).user === "hello" && JSON.parse(values).pw === "";
        record("5 content script refusal", good ? "PASS" : "FAIL", `password type -> ${JSON.stringify(typedPw)}; text type -> ${JSON.stringify(typedUser)}; page values ${values}; snapshot marked the password field refused: ${JSON.stringify(pw)}`);
      }
    }

    // Independent probe: sendNativeMessage with a tabs request (separate host process).
    let probe;
    try {
      probe = await evalIn(pipe, swSession, `new Promise((res) => { const t = setTimeout(() => res("no reply in 4s"), 4000); try { chrome.runtime.sendNativeMessage("${HOST_NAME}", { id: "p1", type: "tabs" }, (r) => { clearTimeout(t); res(chrome.runtime.lastError ? "error: " + chrome.runtime.lastError.message : "reply: " + JSON.stringify(r)); }); } catch (e) { clearTimeout(t); res("throw: " + e.message); } })`);
    } catch (e) { probe = "evaluate failed: " + e.message; }
    const socketAfter = fs.existsSync(sock);
    record("3b sendNativeMessage (extra)", "INFO", `a one-shot host started by Chrome got a tabs request as if from the extension and answered: ${probe}; the first host's socket afterwards ${socketAfter ? "still exists" : "was removed (the second host unlinked it at start and again at exit)"}`);

  } catch (error) {
    record("harness", "FAIL", error.message);
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    if (server) { try { server.kill("SIGKILL"); } catch { /* gone */ } }
    await sleep(500);
    // Chrome helper processes (zygote, gpu, renderers) carry our temp profile in their command line.
    try { execFileSync("pkill", ["-KILL", "-f", "--", `--user-data-dir=${profile}`]); } catch { /* none left */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    const after = fingerprint();
    console.log(before === after ? "~/.osseo unchanged" : "WARNING: ~/.osseo changed during the run (other processes may use it)");
  }
}

await main();
console.log("Firefox: not run, not tested here.");
const ok = ["1 manifest loads", "2 service worker starts", "3 native host"].every((s) => results.find((r) => r.step === s && r.status === "PASS"));
process.exit(ok ? 0 : 1);
