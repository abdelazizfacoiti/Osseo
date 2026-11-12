#!/usr/bin/env node
// Real-page check of the extension content script in headless Chrome, through a chrome.runtime SHIM.
// The shim captures the onMessage listener content.js registers. This proves the refusal logic and the actions
// run in a real DOM. It does NOT prove the extension's real permission path (optional host permission,
// chrome.scripting.executeScript, tabs.sendMessage): the extension itself is not loaded here.
// Isolation: headless=new, DISPLAY unset, HOME and profile in a temp dir, only our own processes killed.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fieldRefusal } from "../src/refusals.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const contentSrc = fs.readFileSync(path.resolve(here, "../extension/content.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout: " + label)), ms))]);
const results = [];
const record = (name, status, reason) => { results.push({ name, status }); console.log(`${status}: ${name} - ${reason}`); };

function findChrome() {
  for (const c of ["google-chrome-stable", "google-chrome"]) {
    try { return execFileSync("which", [c], { encoding: "utf8" }).trim(); } catch { /* next */ }
  }
  return null;
}
class Pipe {
  constructor(child) {
    this.id = 0; this.waiting = new Map(); this.buf = "";
    child.stdio[4].on("data", (d) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        if (!raw) continue;
        const m = JSON.parse(raw);
        if (m.id && this.waiting.has(m.id)) { const w = this.waiting.get(m.id); this.waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
      }
    });
    this.out = child.stdio[3];
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return withTimeout(new Promise((res, rej) => { this.waiting.set(id, { res, rej }); this.out.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); }), 20000, method);
  }
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const SHIM = `(() => {
  let listener = null;
  window.chrome = { runtime: { onMessage: { addListener(fn) { listener = fn; } } } };
  window.__agenthostCall = (msg) => new Promise((resolve) => {
    if (!listener) { resolve({ shim: "no listener registered" }); return; }
    const kept = listener(msg, {}, resolve);
    if (kept !== true && kept !== undefined) { /* ignore */ }
    setTimeout(() => resolve({ shim: "no reply" }), 2000);
  });
  window.__agenthostHasListener = () => listener !== null;
})();`;

const PAGE = `<!doctype html><meta charset="utf-8"><title>Page check</title>
<input id="plain" type="text" placeholder="Plain" value="">
<input id="pw" type="password" aria-label="Password field" value="hunter2-secret">
<input id="otpf" type="text" autocomplete="one-time-code" aria-label="Code field" value="123456">
<input id="ccf" type="text" autocomplete="cc-number" aria-label="Card number field" value="4111111111111111">
<input id="tok" type="text" name="token" aria-label="Token field" value="tok-abc-123">
<input id="cls" type="text" name="classname" aria-label="Class field" value="btn-primary">
<button id="go" onclick="window.__clicked=(window.__clicked||0)+1">Go</button>`;

// id -> expectation. classname matches /ssn/ in the refusal regex: a documented over-refusal.
const CASES = [
  { id: "plain", label: "plain text field", refused: null },
  { id: "pw", label: "password field", refused: "password_field", secret: "hunter2-secret" },
  { id: "otpf", label: "one-time-code field", refused: "sensitive_autocomplete", secret: "123456" },
  { id: "ccf", label: "card field (cc-number)", refused: "sensitive_autocomplete", secret: "4111111111111111" },
  { id: "tok", label: "field named token", refused: "sensitive_name", secret: "tok-abc-123" },
  { id: "cls", label: "field named classname", refused: "sensitive_name", secret: "btn-primary" }
];

async function main() {
  const chrome = findChrome();
  if (!chrome) { record("setup", "NOT POSSIBLE", "no google-chrome on PATH"); return; }
  console.log("chrome: " + execFileSync(chrome, ["--version"], { encoding: "utf8" }).trim());
  const tmp = fs.mkdtempSync(path.join("/tmp", "ahp-"));
  const home = path.join(tmp, "home"); fs.mkdirSync(home, { recursive: true });
  const profile = path.join(tmp, "profile");
  let child = null; let server = null;
  try {
    const pageDir = path.join(tmp, "www"); fs.mkdirSync(pageDir);
    fs.writeFileSync(path.join(pageDir, "index.html"), PAGE);
    const port = await freePort();
    server = spawn("python3", ["-I", "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", pageDir], { stdio: "ignore", env: { PATH: process.env.PATH, HOME: home } });
    await sleep(800);
    const env = { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", XDG_CONFIG_HOME: path.join(home, ".config") }; // no DISPLAY
    child = spawn(chrome, ["--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--no-sandbox", `--user-data-dir=${profile}`, "about:blank"], { env, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    const pipe = new Pipe(child);
    const { targetId } = await pipe.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await pipe.send("Target.attachToTarget", { targetId, flatten: true });
    await pipe.send("Page.enable", {}, sessionId);
    await pipe.send("Runtime.enable", {}, sessionId);
    await pipe.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM }, sessionId);
    await pipe.send("Page.navigate", { url: `http://127.0.0.1:${port}/index.html` }, sessionId);
    const ev = async (expression) => {
      const r = await pipe.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    for (let i = 0; i < 30; i++) { if ((await ev("document.readyState + ':' + document.title").catch(() => "")) === "complete:Page check") break; await sleep(200); }
    // Run content.js in the page (main world; the shim stands in for chrome.runtime).
    await ev(contentSrc);
    if (!(await ev("window.__agenthostHasListener()"))) { record("setup", "FAIL", "content.js did not register an onMessage listener"); return; }
    const call = (msg) => ev(`window.__agenthostCall(${JSON.stringify({ agenthost: true, ...msg })})`);

    const snap = await call({ type: "snapshot", max: 50 });
    if (!snap || !snap.ok) { record("setup", "FAIL", "snapshot " + JSON.stringify(snap)); return; }
    // Map input id -> snapshot element by position in document order.
    const order = await ev(`JSON.stringify(Array.from(document.querySelectorAll('a[href],button,input,select,textarea')).filter(e=>{const r=e.getBoundingClientRect();return r.width>=2&&r.height>=2}).map(e=>e.id))`);
    const ids = JSON.parse(order);
    const raw = JSON.stringify(snap);

    for (const c of CASES) {
      const el = snap.elements[ids.indexOf(c.id)];
      const problems = [];
      if (!el) { record(c.label, "FAIL", "element missing from snapshot"); continue; }
      // Module and content script must agree.
      const modRefusal = fieldRefusal({ tag: "input", type: "text", autocomplete: "", name: "", id: "", ...(c.id === "pw" ? { type: "password" } : {}), ...(c.id === "otpf" ? { autocomplete: "one-time-code" } : {}), ...(c.id === "ccf" ? { autocomplete: "cc-number" } : {}), ...(c.id === "tok" ? { name: "token", id: "tok" } : {}), ...(c.id === "cls" ? { name: "classname", id: "cls" } : {}) });
      if ((modRefusal || null) !== c.refused) problems.push(`refusals.mjs says ${modRefusal}`);
      const before = await ev(`document.getElementById(${JSON.stringify(c.id)}).value`);
      const typed = await call({ type: "type", ref: el.ref, text: "hello" });
      const clicked = await call({ type: "click", ref: el.ref });
      const after = await ev(`document.getElementById(${JSON.stringify(c.id)}).value`);
      if (c.refused) {
        if (el.refused !== c.refused) problems.push(`snapshot refused=${el.refused}`);
        if ("value" in el) problems.push("snapshot returned a value");
        if (typed.ok !== false || typed.reason !== c.refused) problems.push(`type reply ${JSON.stringify(typed)}`);
        if (clicked.ok !== false || clicked.reason !== c.refused) problems.push(`click reply ${JSON.stringify(clicked)}`);
        if (after !== before) problems.push("page value changed");
        if (raw.includes(c.secret) || JSON.stringify([typed, clicked]).includes(c.secret)) problems.push("secret value appeared in a reply");
        record(c.label, problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : `snapshot refused=${el.refused}, no value; type -> ${JSON.stringify(typed)}; click -> ${JSON.stringify(clicked)}; page value untouched`);
      } else {
        if (el.refused) problems.push(`snapshot refused=${el.refused}`);
        if (typed.ok !== true || typed.value !== "hello") problems.push(`type reply ${JSON.stringify(typed)}`);
        if (clicked.ok !== true) problems.push(`click reply ${JSON.stringify(clicked)}`);
        if (after !== "hello") problems.push(`page value ${after}`);
        const snap2 = await call({ type: "snapshot", max: 50 });
        const el2 = snap2.elements[ids.indexOf(c.id)];
        if (!el2 || el2.value !== "hello") problems.push(`read-back snapshot value ${el2 && el2.value}`);
        record(c.label, problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : `typed and read back "hello" (type reply ${JSON.stringify(typed)}, snapshot value ${el2.value}); click ok`);
        // A snapshot invalidates old refs: take a fresh one for later cases.
        Object.assign(snap, snap2);
      }
    }
    // Plain-case re-snapshot changed the ref numbering; refresh refs for the remaining cases is handled by Object.assign above.
    const goEl = snap.elements[ids.indexOf("go")];
    const goClick = await call({ type: "click", ref: goEl.ref });
    const n = await ev("window.__clicked || 0");
    record("plain button click", goClick.ok === true && n === 1 ? "PASS" : "FAIL", `reply ${JSON.stringify(goClick)}, onclick count ${n}`);
  } catch (error) {
    record("harness", "FAIL", error.message);
  } finally {
    if (child) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
    if (server) { try { server.kill("SIGKILL"); } catch { /* gone */ } }
    await sleep(500);
    try { execFileSync("pkill", ["-KILL", "-f", "--", `--user-data-dir=${profile}`]); } catch { /* none left */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await main();
console.log("Scope: a chrome.runtime shim, not the loaded extension. The optional host permission, chrome.scripting.executeScript and tabs.sendMessage were not exercised.");
process.exit(results.length && results.every((r) => r.status !== "FAIL") ? 0 : 1);
