import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, statSync, accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlags } from "./flags.js";

/*
 * `agenthost selftest`: proves the installed server works end to end in a few seconds. It starts the
 * built MCP server in a temp home with no display, opens a local form in headless Chrome, and fills
 * it with see, type and click by number. Nothing touches the real screen or the real agent home.
 */

export type SelftestStep = { name: string; status: "pass" | "fail" | "skipped"; ms: number; detail: string };
export type SelftestDeps = { mcpEntry?: string; chromePath?: string; stepTimeoutMs?: number };
type Output = { ok: boolean; command: string; data?: unknown; error?: string; warnings?: string[]; exitCode?: number };

const STEP_NAMES = ["initialize", "open", "see", "type", "click", "see again"] as const;
const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>AgentHost selftest</title></head><body>
<label for="name">Name</label><input id="name" type="text" value="">
<button id="save" type="button" onclick="document.getElementById('out').textContent = 'Saved: ' + document.getElementById('name').value">Save</button>
<p id="out"></p>
</body></html>
`;

function isExecutable(file: string): boolean {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
}
function findChrome(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    for (const name of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
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
      server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "agenthost-selftest", version: "1" } } })}\n`);
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

export async function selftestCommand(args: string[], _agentHome: string, deps: SelftestDeps = {}): Promise<Output> {
  const { flags } = parseFlags(args);
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

  const root = mkdtempSync(path.join(os.tmpdir(), "agenthost-selftest-"));
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

    const env: NodeJS.ProcessEnv = { ...process.env, AGENTHOST_HOME: home, AGENTHOST_CONFIG: config, AGENTHOST_TOOLS_PROFILE: "full" };
    delete env.DISPLAY; delete env.WAYLAND_DISPLAY; delete env.AGENTHOST_HOST;
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
