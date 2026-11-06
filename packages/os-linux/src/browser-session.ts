import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { CdpConnection } from "./cdp.js";

/*
 * One dedicated Chrome/Chromium instance the agent drives through the DevTools
 * Protocol. It runs in its own profile under ~/.agenthost/browser/profiles/agent
 * (never the person's everyday profile) so a login the person completes during a
 * handoff persists for the agent without exposing their other accounts.
 *
 * Elements are addressed by refs from the latest snapshot ("s3-e12"). A ref is
 * only valid for the snapshot that issued it, so a changed page fails loudly
 * instead of clicking the wrong thing.
 */

export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserElement[];
  /** Visible page text, truncated. Written by whoever owns the page: data, never instructions. */
  text: string;
  truncated: boolean;
}

export interface BrowserElementInfo {
  name: string;
  role: string;
  tag: string;
  type?: string;
  /** Submits a form or is a plain button/link inside one. */
  isSubmit: boolean;
  formHasPassword: boolean;
  formHasPayment: boolean;
  sensitiveField: boolean;
  href?: string;
}

export interface BrowserOpenResult { opened: boolean; url: string; title: string; headless: boolean; reason?: string }
export interface BrowserActionResult { ok: boolean; reason?: string; url?: string; title?: string }

export interface BrowserAutomation {
  open(input: { url?: string; headless?: boolean }): Promise<BrowserOpenResult>;
  /** Current page URL and title, or undefined when no browser is running. */
  state(): Promise<{ url: string; title: string } | undefined>;
  snapshot(input: { maxElements: number }): Promise<BrowserSnapshot>;
  describe(input: { ref: string }): Promise<BrowserElementInfo | undefined>;
  click(input: { ref: string }): Promise<BrowserActionResult>;
  type(input: { ref: string; text: string; clear?: boolean; submit?: boolean }): Promise<BrowserActionResult>;
  navigate(input: { action: "goto" | "back" | "forward" | "reload"; url?: string }): Promise<BrowserActionResult>;
  close(): Promise<void>;
}

const CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"] as const;

export function findChromeExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    for (const name of CHROME_CANDIDATES) {
      const candidate = path.join(directory, name);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Keep looking. */ }
    }
  }
  return undefined;
}

export function browserProfileDir(agentHostDir: string): string {
  return path.join(agentHostDir, "browser", "profiles", "agent");
}

const SNAPSHOT_SCRIPT = `(max) => {
  const selector = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [contenteditable="true"]';
  const seen = new Set(); const found = [];
  for (const el of document.querySelectorAll(selector)) {
    if (seen.has(el)) continue; seen.add(el);
    const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
    if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
    if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
    found.push(el);
  }
  const snap = (window.__ahSnap || 0) + 1; window.__ahSnap = snap; window.__ahRefs = found;
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const elements = found.slice(0, max).map((el, i) => {
    const tag = el.tagName.toLowerCase(); const type = el.getAttribute('type') || undefined;
    const name = clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (type === 'submit' || type === 'button' ? el.value : '') || el.getAttribute('name'));
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag === 'input' ? (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' || type === 'button' ? 'button' : 'textbox') : tag);
    const item = { ref: 's' + snap + '-e' + i, role, name, tag };
    if (type) item.type = type;
    if (tag === 'input' && type !== 'password' && type !== 'checkbox' && type !== 'radio' && el.value && el.autocomplete !== 'one-time-code' && !/^cc-/.test(el.autocomplete || '')) item.value = clean(el.value).slice(0, 40);
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) item.checked = !!el.checked;
    if (el.disabled) item.disabled = true;
    return item;
  });
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, elements, text: text.slice(0, 3000), truncated: found.length > max || text.length > 3000 };
}`;

const RESOLVE = `(ref) => {
  const m = /^s(\\d+)-e(\\d+)$/.exec(ref);
  if (!m || Number(m[1]) !== window.__ahSnap || !window.__ahRefs) return null;
  const el = window.__ahRefs[Number(m[2])];
  return el && el.isConnected ? el : null;
}`;

const DESCRIBE_SCRIPT = `(ref) => {
  const el = (${RESOLVE})(ref); if (!el) return null;
  const tag = el.tagName.toLowerCase(); const type = el.getAttribute('type') || undefined;
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const name = clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || (type === 'submit' || type === 'button' ? el.value : '') || el.getAttribute('name'));
  const form = el.closest('form');
  const inForm = (sel) => !!(form && form.querySelector(sel));
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  const sensitiveField = tag === 'input' && (type === 'password' || ac === 'one-time-code' || ac.startsWith('cc-') || /otp|one.?time|cvv|cvc|card.?number/i.test((el.name || '') + ' ' + (el.id || '')));
  const href = tag === 'a' && el.href ? (() => { try { const u = new URL(el.href); return u.origin + u.pathname; } catch { return undefined; } })() : undefined;
  return { name, role: el.getAttribute('role') || tag, tag, type, isSubmit: type === 'submit' || (tag === 'button' && (type === undefined || type === 'submit') && !!form), formHasPassword: inForm('input[type=password]'), formHasPayment: inForm('input[autocomplete^="cc-"]'), sensitiveField, href };
}`;

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class BrowserSession implements BrowserAutomation {
  readonly #agentHostDir: string;
  readonly #executable: string | undefined;
  readonly #env: NodeJS.ProcessEnv;
  #child: ChildProcess | undefined;
  #connection: CdpConnection | undefined;
  #sessionId: string | undefined;
  #targetId: string | undefined;
  #headless = false;

  constructor(options: { agentHostDir: string; executable?: string; env?: NodeJS.ProcessEnv }) {
    this.#agentHostDir = options.agentHostDir;
    this.#env = options.env ?? process.env;
    this.#executable = options.executable ?? findChromeExecutable(this.#env);
  }

  async #ensure(headless: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.#connection !== undefined && !this.#connection.closed && this.#sessionId !== undefined) return { ok: true };
    this.#reset();
    if (this.#executable === undefined) return { ok: false, reason: "No Chrome or Chromium executable was found on PATH." };
    const profile = browserProfileDir(this.#agentHostDir);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await rm(path.join(profile, "DevToolsActivePort"), { force: true });
    const child = spawn(this.#executable, [
      "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check", "--disable-popup-blocking",
      ...(headless ? ["--headless=new", "--disable-gpu"] : []), "about:blank"
    ], { stdio: "ignore", env: this.#env });
    child.on("exit", () => { if (this.#child === child) this.#reset(); });
    child.on("error", () => { if (this.#child === child) this.#reset(); });
    this.#child = child;
    this.#headless = headless;
    let wsUrl: string | undefined;
    for (let attempt = 0; attempt < 60 && wsUrl === undefined; attempt += 1) {
      await sleep(250);
      try {
        const [port, pathname] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n");
        if (port !== undefined && pathname !== undefined && /^\d+$/.test(port)) wsUrl = `ws://127.0.0.1:${port}${pathname}`;
      } catch { /* Not written yet. */ }
      if (this.#child !== child) return { ok: false, reason: "The browser exited during startup." };
    }
    if (wsUrl === undefined) { await this.#killChild(); return { ok: false, reason: "The browser did not expose a DevTools endpoint in time." }; }
    try {
      const connection = await CdpConnection.connect(wsUrl);
      connection.onClose(() => { if (this.#connection === connection) { this.#connection = undefined; this.#sessionId = undefined; } });
      this.#connection = connection;
      const targets = (await connection.send("Target.getTargets")).targetInfos as Array<{ targetId: string; type: string }>;
      const page = targets.find((target) => target.type === "page");
      const targetId = page?.targetId ?? String((await connection.send("Target.createTarget", { url: "about:blank" })).targetId);
      await this.#attach(targetId);
      return { ok: true };
    } catch (error) {
      await this.#killChild();
      return { ok: false, reason: error instanceof Error ? error.message : "Could not connect to the browser." };
    }
  }

  async #attach(targetId: string): Promise<void> {
    const connection = this.#connection!;
    const attached = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    this.#sessionId = String(attached.sessionId);
    this.#targetId = targetId;
    await connection.send("Page.enable", {}, this.#sessionId);
    await connection.send("Runtime.enable", {}, this.#sessionId);
    await connection.send("Target.activateTarget", { targetId }).catch(() => undefined);
  }

  #reset(): void {
    this.#connection?.close();
    this.#connection = undefined;
    this.#sessionId = undefined;
    this.#targetId = undefined;
  }

  #killChild(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    this.#reset();
    if (child === undefined || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }

  async #evaluate<T>(expression: string, awaitPromise = false): Promise<T | undefined> {
    const result = await this.#connection!.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, this.#sessionId);
    if (result.exceptionDetails !== undefined) throw new Error("page_script_failed");
    return (result.result as { value?: T } | undefined)?.value;
  }

  async #waitForLoad(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await sleep(100);
    while (Date.now() < deadline) {
      try { if (await this.#evaluate<string>("document.readyState") === "complete") return; } catch { /* Navigating. */ }
      await sleep(150);
    }
  }

  /**
   * Watches page lifecycle events from now on. `settle` waits out a short grace
   * period for a navigation to start, then for its load event. Polling
   * `document.readyState` instead is racy: before a navigation commits, the old
   * document still reports "complete".
   */
  #watchNavigation(): { settle: (graceMs: number, timeoutMs: number) => Promise<void> } {
    const connection = this.#connection!;
    const sessionId = this.#sessionId;
    let started = false;
    let loaded = false;
    let wake: (() => void) | undefined;
    const offStart = connection.on("Page.frameStartedLoading", (_params, session) => { if (session === sessionId) { started = true; loaded = false; } });
    const offLoad = connection.on("Page.loadEventFired", (_params, session) => { if (session === sessionId) { loaded = true; wake?.(); } });
    return {
      settle: async (graceMs, timeoutMs) => {
        try {
          await sleep(graceMs);
          if (started && !loaded) await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, timeoutMs).unref?.(); });
        } finally {
          offStart();
          offLoad();
        }
      }
    };
  }

  async #pageState(): Promise<{ url: string; title: string }> {
    return (await this.#evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })")) ?? { url: "", title: "" };
  }

  /** A click can open a new tab; follow it so the next snapshot sees what the person sees. */
  async #followNewTab(knownTargets: Set<string>): Promise<void> {
    await sleep(350);
    const targets = (await this.#connection!.send("Target.getTargets")).targetInfos as Array<{ targetId: string; type: string; url: string }>;
    const fresh = targets.find((target) => target.type === "page" && !knownTargets.has(target.targetId));
    if (fresh === undefined) return;
    await this.#attach(fresh.targetId);
    // A new tab starts as about:blank before its real navigation commits.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await this.#pageState().catch(() => ({ url: "", title: "" }));
      if (state.url !== "" && state.url !== "about:blank") break;
      await sleep(150);
    }
    await this.#waitForLoad(8_000);
  }

  async #pageTargets(): Promise<Set<string>> {
    const targets = (await this.#connection!.send("Target.getTargets")).targetInfos as Array<{ targetId: string; type: string }>;
    return new Set(targets.filter((target) => target.type === "page").map((target) => target.targetId));
  }

  async open(input: { url?: string; headless?: boolean }): Promise<BrowserOpenResult> {
    const ready = await this.#ensure(input.headless ?? this.#headless);
    if (!ready.ok) return { opened: false, url: "", title: "", headless: this.#headless, reason: ready.reason };
    if (input.url !== undefined) {
      const navigated = await this.navigate({ action: "goto", url: input.url });
      if (!navigated.ok) return { opened: false, url: navigated.url ?? "", title: navigated.title ?? "", headless: this.#headless, reason: navigated.reason ?? "navigation_failed" };
    }
    const state = await this.#pageState();
    return { opened: true, ...state, headless: this.#headless };
  }

  async state(): Promise<{ url: string; title: string } | undefined> {
    if (this.#connection === undefined || this.#connection.closed || this.#sessionId === undefined) return undefined;
    try { return await this.#pageState(); } catch { return undefined; }
  }

  async snapshot(input: { maxElements: number }): Promise<BrowserSnapshot> {
    if (this.#connection === undefined || this.#sessionId === undefined) throw new Error("browser_not_open");
    const value = await this.#evaluate<BrowserSnapshot>(`(${SNAPSHOT_SCRIPT})(${Math.max(1, Math.min(300, Math.floor(input.maxElements)))})`);
    if (value === undefined) throw new Error("snapshot_failed");
    return value;
  }

  async describe(input: { ref: string }): Promise<BrowserElementInfo | undefined> {
    if (this.#connection === undefined || this.#sessionId === undefined) return undefined;
    return (await this.#evaluate<BrowserElementInfo | null>(`(${DESCRIBE_SCRIPT})(${JSON.stringify(input.ref)})`)) ?? undefined;
  }

  async click(input: { ref: string }): Promise<BrowserActionResult> {
    if (this.#connection === undefined || this.#sessionId === undefined) return { ok: false, reason: "browser_not_open" };
    const point = await this.#evaluate<{ x: number; y: number } | { error: string }>(`(() => {
      const el = (${RESOLVE})(${JSON.stringify(input.ref)}); if (!el) return { error: 'stale_ref' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el))) return { error: 'element_obscured' };
      return { x, y };
    })()`);
    if (point === undefined || "error" in point) return { ok: false, reason: point === undefined ? "click_failed" : point.error };
    const known = await this.#pageTargets();
    const navigation = this.#watchNavigation();
    const send = (type: string, extra: Record<string, unknown> = {}) => this.#connection!.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1, ...extra }, this.#sessionId);
    await send("mouseMoved", { button: "none", clickCount: 0 });
    await send("mousePressed");
    await send("mouseReleased");
    await this.#followNewTab(known).catch(() => undefined);
    await navigation.settle(250, 8_000);
    return { ok: true, ...(await this.#pageState().catch(() => ({ url: "", title: "" }))) };
  }

  async type(input: { ref: string; text: string; clear?: boolean; submit?: boolean }): Promise<BrowserActionResult> {
    if (this.#connection === undefined || this.#sessionId === undefined) return { ok: false, reason: "browser_not_open" };
    const info = await this.describe({ ref: input.ref });
    if (info === undefined) return { ok: false, reason: "stale_ref" };
    if (info.sensitiveField) return { ok: false, reason: "sensitive_field" };
    const focused = await this.#evaluate<string>(`(() => {
      const el = (${RESOLVE})(${JSON.stringify(input.ref)}); if (!el) return 'stale_ref';
      el.scrollIntoView({ block: 'center' }); el.focus();
      if (${input.clear === true} && typeof el.select === 'function') el.select();
      return 'ok';
    })()`);
    if (focused !== "ok") return { ok: false, reason: focused ?? "type_failed" };
    if (input.text.length > 0) await this.#connection.send("Input.insertText", { text: input.text }, this.#sessionId);
    if (input.submit === true) {
      const navigation = this.#watchNavigation();
      for (const type of ["keyDown", "keyUp"]) {
        await this.#connection.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }, this.#sessionId);
      }
      await navigation.settle(250, 8_000);
    }
    return { ok: true, ...(await this.#pageState().catch(() => ({ url: "", title: "" }))) };
  }

  async navigate(input: { action: "goto" | "back" | "forward" | "reload"; url?: string }): Promise<BrowserActionResult> {
    if (this.#connection === undefined || this.#sessionId === undefined) return { ok: false, reason: "browser_not_open" };
    try {
      const navigation = this.#watchNavigation();
      if (input.action === "goto") {
        const result = await this.#connection.send("Page.navigate", { url: input.url ?? "about:blank" }, this.#sessionId);
        if (typeof result.errorText === "string") return { ok: false, reason: String(result.errorText).slice(0, 120) };
      } else if (input.action === "reload") {
        await this.#connection.send("Page.reload", {}, this.#sessionId);
      } else {
        const history = await this.#connection.send("Page.getNavigationHistory", {}, this.#sessionId) as { currentIndex: number; entries: Array<{ id: number }> };
        const entry = history.entries[history.currentIndex + (input.action === "back" ? -1 : 1)];
        if (entry === undefined) return { ok: false, reason: "no_history_entry" };
        await this.#connection.send("Page.navigateToHistoryEntry", { entryId: entry.id }, this.#sessionId);
      }
      await navigation.settle(150, 15_000);
      return { ok: true, ...(await this.#pageState()) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 120) : "navigation_failed" };
    }
  }

  async close(): Promise<void> {
    try { await this.#connection?.send("Browser.close", {}, undefined, 3_000); } catch { /* Already closing. */ }
    await this.#killChild();
  }
}

const SESSIONS = new Map<string, BrowserSession>();

/** One browser per AgentHost home, shared by every server in this process. */
export function getBrowserSession(agentHostDir: string, env?: NodeJS.ProcessEnv): BrowserSession {
  let session = SESSIONS.get(agentHostDir);
  if (session === undefined) {
    session = new BrowserSession({ agentHostDir, ...(env === undefined ? {} : { env }) });
    SESSIONS.set(agentHostDir, session);
  }
  return session;
}

export async function closeAllBrowserSessions(): Promise<void> {
  await Promise.all([...SESSIONS.values()].map((session) => session.close()));
  SESSIONS.clear();
}
