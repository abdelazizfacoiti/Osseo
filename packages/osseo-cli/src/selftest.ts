import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync, accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findChromeExecutable, findXephyr } from "@osseo/os-linux";
import { parseFlags } from "./flags.js";
import { viewerCommand } from "./viewer.js";

/*
 * `osseo selftest`: proves the installed server works end to end in a few seconds. It starts the
 * built MCP server in a temp home with no display, opens a local form in headless Chrome, and fills
 * it with see, type and click by number. Nothing touches the real screen or the real agent home.
 */

export type SelftestStep = { name: string; status: "pass" | "fail" | "skipped"; ms: number; detail: string };
export type SelftestDeps = { mcpEntry?: string; chromePath?: string; stepTimeoutMs?: number };
type Output = { ok: boolean; command: string; data?: unknown; error?: string; warnings?: string[]; exitCode?: number };

const STEP_NAMES = ["initialize", "open", "see", "type", "click", "see again"] as const;
const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Osseo selftest</title></head><body>
<label for="name">Name</label><input id="name" type="text" value="">
<button id="save" type="button" onclick="document.getElementById('out').textContent = 'Saved: ' + document.getElementById('name').value">Save</button>
<p id="out"></p>
</body></html>
`;

function isExecutable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
}
/** The same lookup the browser tools use: PATH names, and on Windows the Chrome install folders too. */
function findChrome(): string | undefined {
  return findChromeExecutable(process.env);
}

function oneLine(text: string, max = 120): string { const flat = text.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat; }

type Reply = { ok: boolean; data: any; code?: string; text: string };

function connect(server: ChildProcess, timeoutMs: number) {
  const replies = new Map<number, any>();
  let buffer = "";
  server.stdout!.setEncoding("utf8");
  server.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const message = JSON.parse(line); if (message.id !== undefined) replies.set(message.id, message); } catch { /* not a protocol message */ }
    }
  });
  let exited = false;
  server.once("exit", () => { exited = true; });
  let next = 100;
  const wait = async (id: number): Promise<any> => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (replies.has(id)) return replies.get(id);
      if (exited) throw new Error("the server exited");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no reply within ${Math.round(timeoutMs / 1000)}s`);
  };
  return {
    async initialize(): Promise<void> {
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "osseo-selftest", version: "1" } } })}\n`);
      const reply = await wait(1);
      if (reply.error) throw new Error(`initialize failed: ${oneLine(String(reply.error.message ?? "error"))}`);
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async call(name: string, args: Record<string, unknown>): Promise<Reply> {
      const id = next++;
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      const reply = await wait(id);
      if (reply.error) return { ok: false, data: undefined, code: "rpc_error", text: String(reply.error.message ?? "") };
      const text: string = (reply.result?.content ?? []).find((item: any) => item.type === "text")?.text ?? "";
      let body: any;
      try { body = JSON.parse(text); } catch { body = undefined; }
      return { ok: body?.ok === true && reply.result?.isError !== true, data: body?.data ?? body, code: body?.error?.code, text };
    }
  };
}

function numberFor(list: string, needle: string): number | undefined {
  const line = list.split("\n").find((item) => item.includes(needle));
  const match = line === undefined ? null : /^\[(\d+)\]/.exec(line.trim());
  return match === null ? undefined : Number(match[1]);
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  try { server.stdin?.end(); } catch { /* already closed */ }
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

export async function selftestCommand(args: string[], agentHome: string, deps: SelftestDeps = {}): Promise<Output> {
  const { flags } = parseFlags(args);
  if (flags.has("viewer")) return selftestViewerCommand(args, agentHome, deps);
  const json = flags.has("json");
  const mcpEntry = deps.mcpEntry;
  const steps: SelftestStep[] = STEP_NAMES.map((name) => ({ name, status: "skipped", ms: 0, detail: "skipped" }));
  const finish = (): Output => {
    const failed = steps.filter((step) => step.status !== "pass").length;
    const ok = failed === 0;
    const lines = steps.map((step) => `${step.status === "pass" ? "PASS" : step.status === "fail" ? "FAIL" : "SKIP"}  ${step.name.padEnd(10)} ${String(step.ms).padStart(5)} ms  ${step.detail}`);
    const total = steps.reduce((sum, step) => sum + step.ms, 0);
    lines.push(ok ? `Selftest passed: ${steps.length} of ${steps.length} steps in ${total} ms.` : `Selftest failed: ${steps.filter((s) => s.status === "pass").length} of ${steps.length} steps passed.`);
    const report = lines.join("\n");
    // The caller prints: a string for people (on failure it goes out as the error text), the steps for --json.
    if (json) return { ok, command: "selftest", data: { steps, summary: lines[lines.length - 1] }, ...(ok ? {} : { error: "selftest_failed" }), exitCode: ok ? 0 : 1 };
    return { ok, command: "selftest", ...(ok ? { data: report } : { error: `\n${report}` }), exitCode: ok ? 0 : 1 };
  };
  const fatal = (detail: string): Output => { steps[0] = { ...steps[0]!, status: "fail", detail }; return finish(); };

  if (mcpEntry === undefined || !existsSync(mcpEntry)) return fatal("built server not found; run npm run build");
  const chrome = deps.chromePath ?? findChrome();
  if (chrome === undefined || !isExecutable(chrome)) return fatal("Chrome or Chromium not found on PATH");

  const root = mkdtempSync(path.join(os.tmpdir(), "osseo-selftest-"));
  chmodSync(root, 0o700);
  let server: ChildProcess | undefined;
  try {
    const home = path.join(root, "home");
    const work = path.join(root, "work");
    mkdirSync(home, { mode: 0o700 }); mkdirSync(work, { mode: 0o700 });
    const config = path.join(home, "config.json");
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, overlay: { mode: "off" }, autoInstallDependencies: false }), { mode: 0o600 });
    const formFile = path.join(work, "form.html");
    writeFileSync(formFile, FORM);

    const env: NodeJS.ProcessEnv = { ...process.env, OSSEO_HOME: home, OSSEO_CONFIG: config, OSSEO_TOOLS_PROFILE: "full" };
    delete env.DISPLAY; delete env.WAYLAND_DISPLAY; delete env.OSSEO_HOST;
    if (deps.chromePath !== undefined) env.PATH = `${path.dirname(deps.chromePath)}${path.delimiter}${env.PATH ?? ""}`;
    server = spawn(process.execPath, [mcpEntry], { env, stdio: ["pipe", "pipe", "pipe"] });
    server.stderr!.resume();
    const mcp = connect(server, deps.stepTimeoutMs ?? 30_000);

    let nameN: number | undefined, saveN: number | undefined;
    const plan: Array<() => Promise<string>> = [
      async () => { await mcp.initialize(); return "server answered initialize"; },
      async () => {
        const r = await mcp.call("open", { url: pathToFileURL(formFile).href });
        if (!r.ok) throw new Error(`open failed: ${r.code ?? oneLine(r.text, 80)}`);
        return "form open in headless Chrome";
      },
      async () => {
        const r = await mcp.call("see", { picture: "none" });
        if (!r.ok) throw new Error(`see failed: ${r.code ?? oneLine(r.text, 80)}`);
        const list = String(r.data?.list ?? "");
        nameN = numberFor(list, '"Name"'); saveN = numberFor(list, '"Save"');
        if (nameN === undefined) throw new Error('the Name field is not in the list');
        if (saveN === undefined) throw new Error('the Save button is not in the list');
        return `Name is [${nameN}], Save is [${saveN}]`;
      },
      async () => {
        const r = await mcp.call("type", { n: nameN, text: "Ada" });
        if (!r.ok) throw new Error(`type failed: ${r.code ?? oneLine(r.text, 80)}`);
        return `typed into [${nameN}]`;
      },
      async () => {
        const r = await mcp.call("click", { n: saveN });
        if (!r.ok) throw new Error(`click failed: ${r.code ?? oneLine(r.text, 80)}`);
        return `clicked [${saveN}]`;
      },
      async () => {
        const r = await mcp.call("see", { picture: "none" });
        if (!r.ok) throw new Error(`see failed: ${r.code ?? oneLine(r.text, 80)}`);
        const list = String(r.data?.list ?? "");
        if (!list.includes('= "Ada"')) throw new Error("the Name field does not read Ada");
        // Static text is not in the numbered list, so the output line comes from the page snapshot.
        const page = await mcp.call("browser.snapshot", { maxElements: 50 });
        const pageText = String(page.data?.text ?? "") + "\n" + list;
        if (!page.ok && !list.includes("Saved: Ada")) throw new Error(`page text unreadable: ${page.code ?? "snapshot failed"}`);
        if (!pageText.includes("Saved: Ada")) throw new Error('the output line does not read "Saved: Ada"');
        return 'output line reads "Saved: Ada"';
      }
    ];
    for (let index = 0; index < plan.length; index += 1) {
      const started = Date.now();
      try {
        const detail = await plan[index]!();
        steps[index] = { name: STEP_NAMES[index]!, status: "pass", ms: Date.now() - started, detail };
      } catch (error) {
        steps[index] = { name: STEP_NAMES[index]!, status: "fail", ms: Date.now() - started, detail: oneLine(error instanceof Error ? error.message : "failed") };
        break;
      }
    }
    return finish();
  } finally {
    if (server !== undefined) await stop(server);
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

/*
 * `osseo selftest --viewer`: the same form check, run on the background desktop (a nested display)
 * that the viewer shows on the person's screen. It also checks that Send asks first (an approval, nothing
 * sent) and that the viewer draws frames. It needs a screen (DISPLAY), Xephyr and Chrome.
 */
const VIEWER_STEP_NAMES = ["initialize", "viewer", "open", "see", "type", "click", "see again", "approval", "viewer frames"] as const;
const VIEWER_FORM = FORM.replace('<p id="out"></p>', '<button id="send" type="button">Send</button>\n<p id="out"></p>');

export interface ViewerSelftestDeps extends SelftestDeps {
  /** Starts the viewer for the background display the server recorded. Default: osseo viewer start. */
  startViewer?: (agentHome: string) => Promise<{ ok: boolean; error?: string }>;
  /** Stops the viewer again. Default: osseo viewer stop. */
  stopViewer?: (agentHome: string) => Promise<unknown>;
  /** How long to wait for the server to record its background display. */
  displayWaitMs?: number;
}

async function waitForBackgroundDisplay(home: string, timeoutMs: number): Promise<string | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const value = JSON.parse(readFileSync(path.join(home, "run", "background-display.json"), "utf8")) as { display?: unknown };
      if (typeof value.display === "string") return value.display;
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function waitForFrame(home: string, timeoutMs: number): Promise<{ bytes: number; ageMs: number } | undefined> {
  const file = path.join(home, "run", "viewer", "frame.png");
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const info = statSync(file);
      if (info.size > 0) return { bytes: info.size, ageMs: Date.now() - info.mtimeMs };
    } catch {
      /* no frame yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return undefined;
}

/** Approval records still waiting for an answer under the home (run/confirmations/*.json with status pending). */
function pendingConfirmations(home: string): number {
  const folder = path.join(home, "run", "confirmations");
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".json"));
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of names) {
    try {
      if ((JSON.parse(readFileSync(path.join(folder, name), "utf8")) as { status?: unknown }).status === "pending") count += 1;
    } catch {
      /* unreadable record: not counted */
    }
  }
  return count;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Asks the viewer to stop, waits until its window process is gone, and ends it if it is not. Only then may the home go. */
async function stopViewerAndWait(home: string, stopViewer: (target: string) => Promise<unknown>): Promise<void> {
  let pid: number | undefined;
  try {
    const record = JSON.parse(readFileSync(path.join(home, "run", "viewer.pid"), "utf8")) as { pid?: unknown };
    if (typeof record.pid === "number") pid = record.pid;
  } catch {
    /* no PID record: nothing to wait for */
  }
  await stopViewer(home).catch(() => undefined);
  if (pid === undefined) return;
  const end = Date.now() + 5_000;
  while (Date.now() < end && processAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (processAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone meanwhile */
    }
  }
}

export async function selftestViewerCommand(args: string[], agentHome: string, deps: ViewerSelftestDeps = {}): Promise<Output> {
  const { flags } = parseFlags(args);
  const json = flags.has("json");
  const steps: SelftestStep[] = VIEWER_STEP_NAMES.map((name) => ({ name, status: "skipped", ms: 0, detail: "skipped" }));
  const report = (): Output => {
    const ok = steps.every((step) => step.status === "pass");
    const passed = steps.filter((step) => step.status === "pass").length;
    const lines = steps.map((step) => `${step.status === "pass" ? "PASS" : step.status === "fail" ? "FAIL" : "SKIP"}  ${step.name.padEnd(12)} ${String(step.ms).padStart(5)} ms  ${step.detail}`);
    lines.push(ok ? `Viewer selftest passed: ${steps.length} of ${steps.length} steps.` : `Viewer selftest failed: ${passed} of ${steps.length} steps passed.`);
    const text = lines.join("\n");
    if (json) return { ok, command: "selftest --viewer", data: { steps, summary: lines[lines.length - 1] }, ...(ok ? {} : { error: "selftest_failed" }), exitCode: ok ? 0 : 1 };
    return { ok, command: "selftest --viewer", ...(ok ? { data: text } : { error: `\n${text}` }), exitCode: ok ? 0 : 1 };
  };
  const fatal = (detail: string): Output => {
    steps[0] = { ...steps[0]!, status: "fail", detail };
    return report();
  };

  if ((process.env.DISPLAY ?? "") === "") return fatal("the viewer needs a screen: run this from your desktop session (DISPLAY is not set).");
  if (deps.mcpEntry === undefined || !existsSync(deps.mcpEntry)) return fatal("built server not found; run npm run build");
  if (findXephyr(process.env) === undefined) return fatal("Xephyr is not installed (apt package xserver-xephyr): the background desktop needs it.");
  const chrome = deps.chromePath ?? findChrome();
  if (chrome === undefined || !isExecutable(chrome)) return fatal("Chrome or Chromium not found on PATH");

  const root = mkdtempSync(path.join(os.tmpdir(), "osseo-viewer-selftest-"));
  chmodSync(root, 0o700);
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  const startViewer = deps.startViewer ?? (async (target: string) => (await viewerCommand(["start"], target)) as { ok: boolean; error?: string });
  const stopViewer = deps.stopViewer ?? ((target: string) => viewerCommand(["stop"], target));
  let server: ChildProcess | undefined;
  let viewerStarted = false;
  try {
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(work, { mode: 0o700 });
    const config = path.join(home, "config.json");
    // Background placement: the agent works on a nested display, and the viewer shows that display to the person.
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, execution: { placement: "background" }, autoInstallDependencies: false }), { mode: 0o600 });
    const formFile = path.join(work, "form.html");
    writeFileSync(formFile, VIEWER_FORM);

    const env: NodeJS.ProcessEnv = { ...process.env, OSSEO_HOME: home, OSSEO_CONFIG: config, OSSEO_TOOLS_PROFILE: "full" };
    delete env.WAYLAND_DISPLAY;
    delete env.OSSEO_HOST;
    if (deps.chromePath !== undefined) env.PATH = `${path.dirname(deps.chromePath)}${path.delimiter}${env.PATH ?? ""}`;
    server = spawn(process.execPath, [deps.mcpEntry], { env, stdio: ["pipe", "pipe", "pipe"] });
    server.stderr!.resume();
    const mcp = connect(server, deps.stepTimeoutMs ?? 30_000);

    let nameN: number | undefined;
    let saveN: number | undefined;
    let sendN: number | undefined;
    const plan: Array<() => Promise<string>> = [
      async () => {
        await mcp.initialize();
        return "server answered initialize";
      },
      async () => {
        const display = await waitForBackgroundDisplay(home, deps.displayWaitMs ?? 20_000);
        if (display === undefined) throw new Error("the server did not start its background display");
        const started = await startViewer(home);
        if (!started.ok) throw new Error(`viewer did not start: ${oneLine(started.error ?? "error", 90)}`);
        viewerStarted = true;
        return `viewer shows the background display ${display}`;
      },
      async () => {
        const r = await mcp.call("open", { url: pathToFileURL(formFile).href });
        if (!r.ok) throw new Error(`open failed: ${r.code ?? oneLine(r.text, 80)}`);
        return "form open on the background display";
      },
      async () => {
        const r = await mcp.call("see", { picture: "none" });
        if (!r.ok) throw new Error(`see failed: ${r.code ?? oneLine(r.text, 80)}`);
        const list = String(r.data?.list ?? "");
        nameN = numberFor(list, '"Name"');
        saveN = numberFor(list, '"Save"');
        sendN = numberFor(list, '"Send"');
        if (nameN === undefined) throw new Error("the Name field is not in the list");
        if (saveN === undefined) throw new Error("the Save button is not in the list");
        if (sendN === undefined) throw new Error("the Send button is not in the list");
        return `Name is [${nameN}], Save is [${saveN}], Send is [${sendN}]`;
      },
      async () => {
        const r = await mcp.call("type", { n: nameN, text: "Ada" });
        if (!r.ok) throw new Error(`type failed: ${r.code ?? oneLine(r.text, 80)}`);
        return `typed into [${nameN}]`;
      },
      async () => {
        const r = await mcp.call("click", { n: saveN });
        if (!r.ok) throw new Error(`click failed: ${r.code ?? oneLine(r.text, 80)}`);
        return `clicked [${saveN}]`;
      },
      async () => {
        const r = await mcp.call("see", { picture: "none" });
        if (!r.ok) throw new Error(`see failed: ${r.code ?? oneLine(r.text, 80)}`);
        if (!String(r.data?.list ?? "").includes('= "Ada"')) throw new Error("the Name field does not read Ada");
        return "Name reads Ada";
      },
      async () => {
        const r = await mcp.call("click", { n: sendN });
        if (r.code !== "confirmation_required") throw new Error(`Send did not ask first (${r.code ?? (r.ok ? "it ran" : "it failed")})`);
        const waiting = pendingConfirmations(home);
        if (waiting === 0) throw new Error("Send was refused, but no approval is waiting");
        return `Send asks first: ${waiting} approval waiting, nothing was sent`;
      },
      async () => {
        const frame = await waitForFrame(home, 10_000);
        if (frame === undefined) throw new Error("the viewer has not drawn a frame");
        return `viewer drew a frame (${frame.bytes} bytes, ${Math.round(frame.ageMs)} ms old)`;
      }
    ];
    for (let index = 0; index < plan.length; index += 1) {
      const started = Date.now();
      try {
        const detail = await plan[index]!();
        steps[index] = { name: VIEWER_STEP_NAMES[index]!, status: "pass", ms: Date.now() - started, detail };
      } catch (error) {
        steps[index] = { name: VIEWER_STEP_NAMES[index]!, status: "fail", ms: Date.now() - started, detail: oneLine(error instanceof Error ? error.message : "failed") };
        break;
      }
    }
    return report();
  } finally {
    // The viewer goes first, then the server (which stops its nested display and the browser it opened).
    if (viewerStarted) await stopViewerAndWait(home, stopViewer);
    if (server !== undefined) await stop(server);
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}
