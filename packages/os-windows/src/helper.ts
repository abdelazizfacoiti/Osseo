import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HELPER_SCRIPT } from "./helper-script.js";

/** What the adapter needs from the helper. Tests pass a fake. */
export interface HelperTransport {
  request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): void;
}

export class HelperError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HelperError";
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface WindowsHelperOptions {
  /** Osseo home: the script is written under <home>/run. */
  osseoDir: string;
  /** Test seam: the program and arguments that run the helper. */
  command?: { program: string; args: string[] };
  startTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
export const ANTIVIRUS_BLOCKED_CODE = "helper_blocked_by_antivirus";
export const ANTIVIRUS_BLOCKED_MESSAGE = "Antivirus blocked the Windows desktop helper (windows-helper.ps1), so Osseo cannot control the desktop. The agent browser, files and shell still work. Keep your protection on; see docs/platforms.md.";
// Compiling the C# class takes a few seconds the first time.
const DEFAULT_START_TIMEOUT_MS = 40_000;

/** PowerShell wraps its error text, so the antivirus marker is matched with all whitespace removed. */
function exitError(code: number | null, stderr: string): HelperError {
  if (stderr.replace(/\s+/g, "").includes("ScriptContainedMaliciousContent")) return new HelperError(ANTIVIRUS_BLOCKED_CODE, ANTIVIRUS_BLOCKED_MESSAGE);
  return new HelperError("helper_exited", `The Windows helper exited (code ${code ?? "none"}). ${stderr.trim().slice(-300)}`.trim());
}

export type WindowsDesktopProbe = { ok: true } | { ok: false; code: string; reason: string };

/** Starts the helper once and stops it again: whether desktop control can start on this machine. */
export async function probeWindowsDesktop(options: WindowsHelperOptions): Promise<WindowsDesktopProbe> {
  const helper = new WindowsHelperProcess(options);
  try {
    await helper.request("ping");
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error instanceof HelperError ? error.code : "helper_error", reason: error instanceof Error ? error.message : "The Windows helper did not start." };
  } finally {
    helper.close();
  }
}

/**
 * One long-lived `powershell.exe -STA` process speaking JSON lines. It starts on the first request,
 * restarts after it exits, and ends with the server (closing its stdin ends its loop).
 */
export class WindowsHelperProcess implements HelperTransport {
  readonly #options: WindowsHelperOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<void> | undefined;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = "";
  #stderr = "";

  constructor(options: WindowsHelperOptions) {
    this.#options = options;
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    await this.#ensureStarted();
    return (await this.#send(method, params, timeoutMs)) as T;
  }

  close(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#starting = undefined;
    this.#rejectAll(new HelperError("helper_closed", "The Windows helper was closed."));
    if (child === undefined) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      /* Already gone. */
    }
  }

  async #ensureStarted(): Promise<void> {
    if (this.#child !== undefined && this.#starting === undefined) return;
    if (this.#starting === undefined) {
      this.#starting = this.#start().catch((error: unknown) => {
        this.close(); // Do not leave a half-started process behind.
        throw error;
      });
    }
    await this.#starting;
    this.#starting = undefined;
  }

  async #start(): Promise<void> {
    const command = this.#options.command ?? (await this.#writeScript());
    const child = spawn(command.program, command.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.#child = child;
    this.#buffer = "";
    this.#stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr.on("data", (chunk: string) => { this.#stderr = (this.#stderr + chunk).slice(-2_000); });
    child.on("error", (error) => this.#onExit(child, new HelperError("helper_unavailable", `The Windows helper could not start: ${error.message}`)));
    // "close" comes after stderr is fully read, which is where PowerShell says why it refused the script.
    child.on("close", (code) => this.#onExit(child, exitError(code, this.#stderr)));
    await this.#send("ping", {}, this.#options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  }

  async #writeScript(): Promise<{ program: string; args: string[] }> {
    const dir = path.join(this.#options.osseoDir, "run");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "windows-helper.ps1");
    await writeFile(file, HELPER_SCRIPT, { encoding: "utf8" });
    return { program: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", file] };
  }

  #send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const child = this.#child;
    if (child === undefined) return Promise.reject(new HelperError("helper_unavailable", "The Windows helper is not running."));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HelperError("helper_timeout", `The Windows helper did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(new HelperError("helper_unavailable", `Writing to the Windows helper failed: ${error.message}`));
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line !== "") this.#onLine(line);
      index = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let message: { id?: number; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // Not a protocol line (PowerShell can print warnings).
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new HelperError(message.error?.code ?? "helper_error", message.error?.message ?? "The Windows helper reported an error."));
  }

  #onExit(child: ChildProcessWithoutNullStreams, error: HelperError): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#starting = undefined;
    this.#rejectAll(error);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
