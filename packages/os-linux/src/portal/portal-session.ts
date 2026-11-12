import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** One screen stream the portal granted: its PipeWire node and its place in the global coordinate space. */
export interface PortalStream {
  node: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PortalOpenResult {
  devices: number;
  streams: PortalStream[];
}

export interface PortalProbeResult {
  availableDeviceTypes: number;
  remoteDesktopVersion: number;
  availableSourceTypes: number;
  screenCastVersion: number;
  sessionCreated: boolean;
}

/** A portal failure with a stable code (consent_denied, portal_timeout, portal_unavailable, not_open, ...). */
export class PortalError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "PortalError";
    this.code = code;
  }
}

export interface PortalSessionOptions {
  /** Interpreter for the helper. Default: python3. */
  python?: string;
  /** Helper script. Default: packages/os-linux/runtime/portal_helper.py. */
  helperPath?: string;
  /** Environment for the helper; it needs DBUS_SESSION_BUS_ADDRESS. Default: this process's environment. */
  env?: NodeJS.ProcessEnv;
  /** Limit for one ordinary request (probe, pointer, key, close). */
  requestTimeoutMs?: number;
  /** Limit for one screenshot, which waits for a frame. */
  captureTimeoutMs?: number;
}

/** How long the first open waits for the person's answer to the portal's dialog. */
export const DEFAULT_CONSENT_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 20_000;
const CLOSE_GRACE_MS = 3_000;
const DEFAULT_HELPER = fileURLToPath(new URL("../../runtime/portal_helper.py", import.meta.url));

interface PendingRequest {
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One portal session for this process. The helper (portal_helper.py) runs as a child process and holds the
 * DBus connection, because the portal closes a session when its caller disconnects. The first open asks the
 * person once. A refusal is kept for the rest of the process: AgentHost does not ask again.
 */
export class PortalSession {
  readonly #python: string;
  readonly #helper: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #requestTimeoutMs: number;
  readonly #captureTimeoutMs: number;
  readonly #pending = new Map<number, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #stderr = "";
  #opened: PortalOpenResult | undefined;
  #opening: Promise<PortalOpenResult> | undefined;
  #declined = false;

  constructor(options: PortalSessionOptions = {}) {
    this.#python = options.python ?? "python3";
    this.#helper = options.helperPath ?? DEFAULT_HELPER;
    this.#env = options.env ?? process.env;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#captureTimeoutMs = options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  }

  /** True once the person has allowed remote control in this process. */
  get isOpen(): boolean {
    return this.#opened !== undefined;
  }

  /** The granted screen streams; empty until open succeeds. */
  get streams(): PortalStream[] {
    return this.#opened?.streams ?? [];
  }

  /** True after the person declined. Open then refuses without asking again. */
  get declined(): boolean {
    return this.#declined;
  }

  /** Reads the portal's properties and creates and closes one session. Shows nothing on screen. */
  async probe(): Promise<PortalProbeResult> {
    const reply = await this.#request({ cmd: "probe" }, this.#requestTimeoutMs);
    return {
      availableDeviceTypes: numberField(reply, "availableDeviceTypes"),
      remoteDesktopVersion: numberField(reply, "remoteDesktopVersion"),
      availableSourceTypes: numberField(reply, "availableSourceTypes"),
      screenCastVersion: numberField(reply, "screenCastVersion"),
      sessionCreated: reply.sessionCreated === true
    };
  }

  /**
   * Asks the person once, through the portal's own dialog, and opens keyboard, pointer and screen. Later calls
   * return the same result without asking again. A refusal throws consent_denied on every later call.
   */
  async open(input: { keyboard?: boolean; pointer?: boolean; screen?: boolean; timeoutMs?: number } = {}): Promise<PortalOpenResult> {
    if (this.#opened !== undefined) return this.#opened;
    if (this.#declined) {
      throw new PortalError("consent_denied", "The person declined remote control earlier in this session. Restart AgentHost to ask again.");
    }
    if (this.#opening === undefined) {
      this.#opening = this.#openOnce(input).finally(() => {
        this.#opening = undefined;
      });
    }
    return this.#opening;
  }

  async pointerMotion(node: number, x: number, y: number): Promise<void> {
    await this.#request({ cmd: "pointer_motion", node, x, y }, this.#requestTimeoutMs);
  }

  /** button is a Linux input event code (BUTTON_CODES in portal-protocol.ts). */
  async pointerButton(button: number, pressed: boolean): Promise<void> {
    await this.#request({ cmd: "pointer_button", button, pressed }, this.#requestTimeoutMs);
  }

  /** keysym is an X11 keysym (see portal-protocol.ts). */
  async keysym(keysym: number, pressed: boolean): Promise<void> {
    await this.#request({ cmd: "keysym", keysym, pressed }, this.#requestTimeoutMs);
  }

  /** Captures one frame of the shared screen into an image file at an absolute path. */
  async screenshot(input: { path: string; format: "png" | "jpeg"; quality?: number }): Promise<{ path: string; bytesWritten: number; format: string }> {
    const reply = await this.#request({ cmd: "screenshot", path: input.path, format: input.format, quality: input.quality ?? 85 }, this.#captureTimeoutMs);
    return { path: String(reply.path ?? input.path), bytesWritten: numberField(reply, "bytesWritten"), format: String(reply.format ?? input.format) };
  }

  /** Closes the portal session and stops the helper. Safe to call more than once. */
  async close(): Promise<void> {
    const child = this.#child;
    if (child === undefined) {
      this.#opened = undefined;
      return;
    }
    try {
      await this.#request({ cmd: "close" }, this.#requestTimeoutMs);
    } catch {
      /* The helper may already be gone; the exit handler resets the state. */
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, CLOSE_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
    this.#childGone(child, new PortalError("not_open", "The portal session is closed."));
  }

  async #openOnce(input: { keyboard?: boolean; pointer?: boolean; screen?: boolean; timeoutMs?: number }): Promise<PortalOpenResult> {
    const timeoutMs = input.timeoutMs ?? DEFAULT_CONSENT_TIMEOUT_MS;
    try {
      const reply = await this.#request({
        cmd: "open",
        keyboard: input.keyboard ?? true,
        pointer: input.pointer ?? true,
        screen: input.screen ?? true,
        timeoutMs
      }, timeoutMs + this.#requestTimeoutMs);
      const result: PortalOpenResult = { devices: numberField(reply, "devices"), streams: parseStreams(reply.streams) };
      this.#opened = result;
      return result;
    } catch (error) {
      if (error instanceof PortalError && error.code === "consent_denied") this.#declined = true;
      throw error;
    }
  }

  #request(command: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const child = this.#ensureChild();
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PortalError("portal_timeout", `The portal helper did not answer ${String(command.cmd)} within ${Math.round(timeoutMs / 1000)} s.`));
        // A helper that stops answering is replaced, and its portal session goes with it. The state is reset now,
        // not when the exit event arrives, so the next call starts a new helper.
        child.kill("SIGKILL");
        this.#childGone(child, new PortalError("helper_exited", "The portal helper stopped answering and was replaced."));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.#pending.get(id);
        if (pending === undefined) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new PortalError("helper_unavailable", error.message));
      });
    });
  }

  #ensureChild(): ChildProcessWithoutNullStreams {
    if (this.#child !== undefined) return this.#child;
    const child = spawn(this.#python, ["-I", this.#helper], { env: this.#env, stdio: ["pipe", "pipe", "pipe"], shell: false });
    this.#child = child;
    this.#stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.stdin.on("error", () => {
      /* A broken pipe ends in the exit handler below. */
    });
    child.on("error", (error) => this.#childGone(child, new PortalError("helper_unavailable", `The portal helper did not start: ${error.message}`)));
    child.on("exit", (code, signal) => {
      const tail = this.#stderr.trim().slice(-300);
      this.#childGone(child, new PortalError("helper_exited", `The portal helper exited (${code ?? signal ?? "unknown"}).${tail.length > 0 ? ` ${tail}` : ""}`));
    });
    return child;
  }

  #onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.event === "fatal") {
      this.#failAll(new PortalError(String(message.code ?? "no_session_bus"), String(message.message ?? "The session bus is not available.")));
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === true) {
      pending.resolve(message);
    } else {
      pending.reject(new PortalError(String(message.code ?? "portal_error"), String(message.message ?? message.code ?? "portal_error")));
    }
  }

  /** The helper for `child` is gone: forget it, forget the open session, and fail what it still owed. */
  #childGone(child: ChildProcessWithoutNullStreams, error: PortalError): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#opened = undefined;
    this.#failAll(error);
  }

  #failAll(error: PortalError): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}

function numberField(reply: Record<string, unknown>, field: string): number {
  const value = reply[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseStreams(value: unknown): PortalStream[] {
  if (!Array.isArray(value)) return [];
  const streams: PortalStream[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (!["node", "x", "y", "width", "height"].every((field) => Number.isInteger(record[field]))) continue;
    streams.push({
      node: record.node as number,
      x: record.x as number,
      y: record.y as number,
      width: record.width as number,
      height: record.height as number
    });
  }
  return streams;
}
