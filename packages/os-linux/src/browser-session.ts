import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { CdpConnection } from "./cdp.js";
import { killProcessTree } from "./process-tree.js";

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
  /** Inside a same-origin iframe (one level deep). */
  inFrame?: boolean;
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
export interface BrowserActionResult { ok: boolean; reason?: string; url?: string; title?: string; navigated?: boolean; domChanged?: boolean }

export interface BrowserSelectResult extends BrowserActionResult { selected?: string; options?: string[] }
export interface BrowserWaitResult { matched: boolean; elapsedMs: number; url: string; title: string }
export interface BrowserImage { data: string; mimeType: "image/jpeg"; width?: number; height?: number }

export interface BrowserAutomation {
  open(input: { url?: string; headless?: boolean }): Promise<BrowserOpenResult>;
  /** Current page URL and title, or undefined when no browser is running. */
  state(): Promise<{ url: string; title: string } | undefined>;
  snapshot(input: { maxElements: number }): Promise<BrowserSnapshot>;
  describe(input: { ref: string }): Promise<BrowserElementInfo | undefined>;
  click(input: { ref: string }): Promise<BrowserActionResult>;
  type(input: { ref: string; text: string; clear?: boolean; submit?: boolean }): Promise<BrowserActionResult>;
  navigate(input: { action: "goto" | "back" | "forward" | "reload"; url?: string }): Promise<BrowserActionResult>;
  upload(input: { ref: string; files: string[] }): Promise<BrowserActionResult>;
  select(input: { ref: string; value?: string; label?: string }): Promise<BrowserSelectResult>;
  waitFor(input: { text?: string; urlContains?: string; timeoutMs: number }): Promise<BrowserWaitResult>;
  readValue(input: { ref: string }): Promise<string | undefined>;
  screenshot(input: { ref?: string }): Promise<{ ok: boolean; reason?: string; image?: BrowserImage }>;
  close(): Promise<void>;
}

const CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium"] as const;

export interface ChromeSearch {
  /** Defaults to the host platform. Tests pass "win32" to check the Windows locations. */
  platform?: NodeJS.Platform;
  /** Test seam: whether a candidate exists. Defaults to the file system. */
  exists?: (candidate: string) => boolean;
}

function isExecutableFile(candidate: string): boolean {
  try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
}

function isExistingFile(candidate: string): boolean {
  try { accessSync(candidate, constants.F_OK); return true; } catch { return false; }
}

/** Windows environment variables are case-insensitive; injected environments may not be. */
function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted && value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * The browser the browser.* tools drive: Chrome or Chromium on POSIX systems; on Windows, Chrome
 * or Edge (both speak the same DevTools protocol), in their install folders or on PATH.
 */
export function findChromeExecutable(env: NodeJS.ProcessEnv = process.env, search: ChromeSearch = {}): string | undefined {
  const platform = search.platform ?? process.platform;
  if (platform === "win32") {
    const win = path.win32;
    const exists = search.exists ?? isExistingFile;
    const programFiles = windowsEnv(env, "ProgramFiles") ?? "C:\\Program Files";
    const programFilesX86 = windowsEnv(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)";
    const localAppData = windowsEnv(env, "LOCALAPPDATA");
    const installed = [
      win.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      win.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      ...(localAppData === undefined ? [] : [win.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")]),
      win.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
      win.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
    ];
    for (const candidate of installed) {
      if (exists(candidate)) return candidate;
    }
    for (const directory of (windowsEnv(env, "PATH") ?? "").split(";")) {
      const folder = directory.trim();
      if (folder === "") continue;
      for (const name of ["chrome.exe", "msedge.exe"]) {
        const candidate = win.join(folder, name);
        if (exists(candidate)) return candidate;
      }
    }
    return undefined;
  }
  const exists = search.exists ?? isExecutableFile;
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    for (const name of CHROME_CANDIDATES) {
      const candidate = path.join(directory, name);
      if (exists(candidate)) return candidate;
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
  const collect = (doc) => {
    for (const el of doc.querySelectorAll(selector)) {
      if (seen.has(el)) continue; seen.add(el);
      const rect = el.getBoundingClientRect(); const style = (doc.defaultView || window).getComputedStyle(el);
      if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none') continue;
      if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
      found.push(el);
    }
  };
  collect(document);
  // One level of same-origin iframes. Nested frames and cross-origin frames are not walked.
  for (const frameEl of document.querySelectorAll('iframe')) {
    let frameDoc = null;
    try { frameDoc = frameEl.contentDocument; } catch (e) { frameDoc = null; }
    if (frameDoc) collect(frameDoc);
  }
  const snap = (window.__ahSnap || 0) + 1; window.__ahSnap = snap; window.__ahRefs = found;
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const elements = found.slice(0, max).map((el, i) => {
    const tag = el.tagName.toLowerCase(); const type = el.getAttribute('type') || undefined;
    const name = clean(el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (type === 'submit' || type === 'button' ? el.value : '') || el.getAttribute('name'));
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag === 'input' ? (type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' || type === 'button' ? 'button' : 'textbox') : tag);
    const item = { ref: 's' + snap + '-e' + i, role, name, tag };
    if (el.ownerDocument !== document) item.inFrame = true;
    if (type) item.type = type;
    if (tag === 'input' && type !== 'password' && type !== 'checkbox' && type !== 'radio' && el.value && el.autocomplete !== 'one-time-code' && !/^cc-/.test(el.autocomplete || '')) item.value = clean(el.value).slice(0, 40);
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) item.checked = !!el.checked;
    if (el.disabled) item.disabled = true;
    return item;
  });
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { url: location.href, title: document.title, elements, text: text.slice(0, 3000), truncated: found.length > max || text.length > 3000 };
}`;

// A cheap page fingerprint: URL, top-level size, and element count. Changes when the page does something.
const PAGE_FINGERPRINT = `(() => { const b = document.body; if (!b) return ''; return [location.href, b.childElementCount, b.innerText.length, document.querySelectorAll('*').length].join('|'); })()`;

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
    ], { stdio: "ignore", env: this.#env, windowsHide: true });
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
    await connection.send("DOM.enable", {}, this.#sessionId);
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
      const timer = setTimeout(() => { killProcessTree(child, "SIGKILL"); resolve(); }, 3_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      killProcessTree(child, "SIGTERM");
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

  /** The page's URL and title, or undefined when the page cannot be read right now. */
  async #pageStateIfKnown(): Promise<{ url: string; title: string } | undefined> {
    return await this.#pageState().catch(() => undefined);
  }

  async #fingerprintIfKnown(): Promise<string | undefined> {
    return await this.#evaluate<string>(PAGE_FINGERPRINT).catch(() => undefined);
  }

  async #pageState(): Promise<{ url: string; title: string }> {
    return (await this.#evaluate<{ url: string; title: string }>("({ url: location.href, title: document.title })")) ?? { url: "", title: "" };
  }

  /** A click can open a new tab; follow it so the next snapshot sees what the person sees. */
  async #followNewTab(knownTargets: Set<string>): Promise<void> {
    await sleep(350);
    const targets = (await this.#connection!.send("Target.getTargets")).targetInfos as Array<{ targetId: string; type: string; url: string }>;
    // Only a tab this page opened (window.open, target=_blank) is the one the click produced. Chrome
    // can create blank pages of its own; following those put the session on the wrong page.
    const opener = this.#targetId;
    const fresh = opener === undefined
      ? undefined
      : targets.find((target) => target.type === "page" && !knownTargets.has(target.targetId) && (target as { openerId?: string }).openerId === opener);
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
      if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return { error: 'element_disabled' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const doc = el.ownerDocument; const view = doc.defaultView;
      const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
      const hit = doc.elementFromPoint(cx, cy);
      if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el))) return { error: 'element_obscured' };
      // Mouse events go to the top page: add the iframe's offset when the element lives in one.
      const frame = view && view.frameElement ? view.frameElement : null;
      if (!frame) return { x: cx, y: cy };
      const fr = frame.getBoundingClientRect();
      return { x: fr.left + frame.clientLeft + cx, y: fr.top + frame.clientTop + cy };
    })()`);
    if (point === undefined || "error" in point) return { ok: false, reason: point === undefined ? "click_failed" : point.error };
    const before = await this.#pageStateIfKnown();
    const beforeFingerprint = await this.#fingerprintIfKnown();
    const known = await this.#pageTargets();
    const navigation = this.#watchNavigation();
    const send = (type: string, extra: Record<string, unknown> = {}) => this.#connection!.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1, ...extra }, this.#sessionId);
    await send("mouseMoved", { button: "none", clickCount: 0 });
    await send("mousePressed");
    await send("mouseReleased");
    await this.#followNewTab(known).catch(() => undefined);
    await navigation.settle(250, 8_000);
    const after = await this.#pageStateIfKnown();
    const afterFingerprint = await this.#fingerprintIfKnown();
    return {
      ok: true,
      url: after?.url ?? "",
      title: after?.title ?? "",
      // Reported only when both readings worked: an unreadable page is "unknown", not "changed".
      ...(before === undefined || after === undefined ? {} : { navigated: after.url !== before.url }),
      ...(beforeFingerprint === undefined || afterFingerprint === undefined ? {} : { domChanged: afterFingerprint !== beforeFingerprint })
    };
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

  async upload(input: { ref: string; files: string[] }): Promise<BrowserActionResult> {
    if (this.#connection === undefined || this.#sessionId === undefined) return { ok: false, reason: "browser_not_open" };
    try {
      const found = await this.#connection.send("Runtime.evaluate", { expression: `(${RESOLVE})(${JSON.stringify(input.ref)})`, returnByValue: false }, this.#sessionId);
      const objectId = (found.result as { objectId?: string } | undefined)?.objectId;
      if (objectId === undefined) return { ok: false, reason: "stale_ref" };
      const check = await this.#connection.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { return this.tagName === 'INPUT' && this.type === 'file'; }", returnByValue: true }, this.#sessionId);
      if ((check.result as { value?: unknown } | undefined)?.value !== true) return { ok: false, reason: "not_a_file_input" };
      await this.#connection.send("DOM.setFileInputFiles", { files: input.files, objectId }, this.#sessionId);
      await this.#connection.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function () { this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); }", returnByValue: true }, this.#sessionId);
      return { ok: true, ...(await this.#pageState().catch(() => ({ url: "", title: "" }))) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : "upload_failed" };
    }
  }

  async select(input: { ref: string; value?: string; label?: string }): Promise<BrowserSelectResult> {
    if (this.#connection === undefined || this.#sessionId === undefined) return { ok: false, reason: "browser_not_open" };
    const outcome = await this.#evaluate<{ selected?: string; error?: string; options?: string[] }>(`(() => {
      const el = (${RESOLVE})(${JSON.stringify(input.ref)});
      if (!el) return { error: 'stale_ref' };
      if (el.tagName !== 'SELECT') return { error: 'not_a_select' };
      const options = [...el.options];
      const wanted = ${JSON.stringify(input.value ?? null)};
      const label = ${JSON.stringify(input.label ?? null)};
      const match = options.find((o) => wanted !== null && o.value === wanted) ?? options.find((o) => label !== null && o.text.trim() === label);
      if (!match) return { error: 'option_not_found', options: options.slice(0, 30).map((o) => o.text.trim()) };
      el.value = match.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { selected: match.text.trim() };
    })()`);
    if (outcome === undefined) return { ok: false, reason: "select_failed" };
    if (outcome.error !== undefined) return { ok: false, reason: outcome.error, ...(outcome.options === undefined ? {} : { options: outcome.options }) };
    return { ok: true, ...(outcome.selected === undefined ? {} : { selected: outcome.selected }), ...(await this.#pageState().catch(() => ({ url: "", title: "" }))) };
  }

  /** Polls the page until the text appears and/or the URL contains the string, or the timeout passes. */
  async waitFor(input: { text?: string; urlContains?: string; timeoutMs: number }): Promise<BrowserWaitResult> {
    const started = Date.now();
    const deadline = started + Math.max(0, input.timeoutMs);
    let state = { url: "", title: "", text: "" };
    for (;;) {
      try {
        state = (await this.#evaluate<{ url: string; title: string; text: string }>("({ url: location.href, title: document.title, text: document.body ? document.body.innerText : '' })")) ?? state;
        const textOk = input.text === undefined || state.text.includes(input.text);
        const urlOk = input.urlContains === undefined || state.url.includes(input.urlContains);
        if (textOk && urlOk) return { matched: true, elapsedMs: Date.now() - started, url: state.url, title: state.title };
      } catch {
        /* The page is navigating; keep polling until the deadline. */
      }
      if (Date.now() >= deadline) return { matched: false, elapsedMs: Date.now() - started, url: state.url, title: state.title };
      await sleep(250);
    }
  }

  /** The current value of an input, or undefined when the element has none. Sensitive fields are never read. */
  async readValue(input: { ref: string }): Promise<string | undefined> {
    if (this.#connection === undefined || this.#sessionId === undefined) return undefined;
    const value = await this.#evaluate<string | null>(`(() => { const el = (${RESOLVE})(${JSON.stringify(input.ref)}); return el && 'value' in el ? String(el.value) : null; })()`);
    return value ?? undefined;
  }

  async screenshot(input: { ref?: string }): Promise<{ ok: boolean; reason?: string; image?: BrowserImage }> {
    if (this.#connection === undefined || this.#sessionId === undefined) return { ok: false, reason: "browser_not_open" };
    try {
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
      if (input.ref !== undefined) {
        const rect = await this.#evaluate<{ x: number; y: number; width: number; height: number } | { error: string }>(`(() => { const el = (${RESOLVE})(${JSON.stringify(input.ref)}); if (!el) return { error: 'stale_ref' }; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
        if (rect === undefined) return { ok: false, reason: "snapshot_failed" };
        if ("error" in rect) return { ok: false, reason: rect.error };
        clip = { ...rect, scale: 1 };
      }
      const shot = await this.#connection.send("Page.captureScreenshot", { format: "jpeg", quality: 70, ...(clip === undefined ? {} : { clip }) }, this.#sessionId);
      const data = String(shot.data ?? "");
      if (data.length === 0) return { ok: false, reason: "screenshot_empty" };
      return { ok: true, image: { data, mimeType: "image/jpeg", ...(clip === undefined ? {} : { width: Math.round(clip.width), height: Math.round(clip.height) }) } };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : "screenshot_failed" };
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
