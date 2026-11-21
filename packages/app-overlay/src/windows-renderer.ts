import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OverlayCapabilityReport, OverlayStateSnapshot, OverlayWidgetEvent } from "@osseo/core";
import {
  OVERLAY_IPC_MAX_BYTES,
  OVERLAY_IPC_MAX_IN_FLIGHT,
  OVERLAY_IPC_VERSION,
  serializeRendererMessage,
  validateRendererHandshake,
  validateRendererOperationData,
  validateRendererReply,
  type OverlayRendererCommand,
  type OverlayRendererReply,
  type OverlayRendererRequest
} from "./linux-renderer-protocol.js";
import type { OverlayOperationResult, OverlayRenderRecord, OverlayRenderer, OverlayRendererDiagnostics, OverlayRendererRestartResult } from "./renderer.js";
import { WINDOWS_OVERLAY_SCRIPT } from "./windows-overlay-script.js";
import type { OverlayVisualConfig } from "./linux-renderer.js";

/** The Windows overlay is on when OSSEO_WINDOWS_OVERLAY=1 or overlay.windows is true in config.json. Off by default. */
export function windowsOverlayEnabled(environment: NodeJS.ProcessEnv, configured?: boolean): boolean {
  return environment.OSSEO_WINDOWS_OVERLAY === "1" || configured === true;
}

export interface WindowsOverlayRendererOptions {
  /** Osseo home: the script is written under <home>/run. */
  osseoDir: string;
  sessionId?: string;
  /** Test seam: the program and arguments that run the overlay process. */
  command?: { program: string; args: string[] };
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  maxRestarts?: number;
  /** Dock layout, sent in the handshake: `layout: "dock"` reserves the strip on `dockSide` (see the script's dock section). */
  visual?: Partial<OverlayVisualConfig>;
}

type OperationCommand = "show" | "update" | "dismiss" | "clear" | "emergency_hide";
type StateCommand = "state" | "events";

interface PendingRequest {
  resolve: (reply: OverlayRendererReply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const RENDERER_NAME = "wpf-windows";
const DEFAULT_STARTUP_MS = 45_000;
const DEFAULT_COMMAND_MS = 8_000;
const DEFAULT_MAX_RESTARTS = 1;
/** How long a call waits for a cold start before it returns renderer_starting; the start goes on in the background. */
const STARTUP_WAIT_MS = 1_500;
/** Only the variables PowerShell needs; the rest of the server environment stays out of the overlay process. */
const ENVIRONMENT_NAMES = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "PSModulePath", "ComSpec", "LOCALAPPDATA", "APPDATA"];

function unsupportedReport(reason: string, rendererStatus: OverlayCapabilityReport["rendererStatus"] = "unavailable"): OverlayCapabilityReport {
  return {
    supported: false,
    available: false,
    visible: false,
    renderer: RENDERER_NAME,
    rendererStatus,
    sessionType: "unknown",
    displayAvailable: process.platform === "win32",
    clickThrough: false,
    interactiveWidgets: false,
    multipleDisplays: false,
    globalOverlayAvailable: false,
    clickThroughAvailable: false,
    multiDisplayAvailable: false,
    animationAvailable: false,
    interactiveWidgetsAvailable: false,
    reason,
    limitations: ["The Windows overlay process has not completed its handshake."]
  };
}

/** Reads the handshake's capability report. Anything missing or mistyped makes the overlay unsupported. */
function readCapabilities(value: unknown): OverlayCapabilityReport | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const supported = record.supported;
  const reason = record.reason;
  if (typeof supported !== "boolean" || typeof reason !== "string") return undefined;
  const flag = (key: string): boolean => record[key] === true;
  const rendererStatus: OverlayCapabilityReport["rendererStatus"] = supported ? "available" : "unavailable";
  const limitations = Array.isArray(record.limitations)
    ? record.limitations.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 300))
    : [];
  return {
    supported,
    available: flag("available"),
    visible: flag("visible"),
    renderer: RENDERER_NAME,
    rendererStatus,
    sessionType: "unknown",
    displayAvailable: flag("displayAvailable"),
    clickThrough: flag("clickThrough"),
    interactiveWidgets: flag("interactiveWidgets"),
    multipleDisplays: false,
    globalOverlayAvailable: flag("globalOverlayAvailable"),
    clickThroughAvailable: flag("clickThroughAvailable"),
    multiDisplayAvailable: false,
    animationAvailable: false,
    interactiveWidgetsAvailable: flag("interactiveWidgetsAvailable"),
    compositorAvailable: flag("compositorAvailable"),
    transparentWindowsAvailable: flag("transparentWindowsAvailable"),
    reason: reason.slice(0, 200),
    limitations
  };
}

function isOverlayWidgetEvent(value: unknown): value is OverlayWidgetEvent {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.eventId === "string" && record.eventId.length > 0 && record.eventId.length <= 100
    && typeof record.overlayId === "string" && record.overlayId.length > 0 && record.overlayId.length <= 200
    && typeof record.event === "string" && record.event.length > 0 && record.event.length <= 100
    && typeof record.createdAt === "string" && typeof record.ownerSessionId === "string" && record.ownerSessionId.length > 0;
}

function failed(reason: string): OverlayOperationResult {
  return { ok: false, reason, acknowledged: false };
}

/** Resolves to undefined after `ms`. The timer does not keep the process alive. */
function timeoutValue(ms: number): Promise<undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

function summarize(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(-512);
}

/**
 * The Windows overlay: one `powershell.exe -STA` process that hosts a WPF window per card, spoken to over the
 * same JSON-line protocol as the GTK renderer. It starts on the first call (or warmup), restarts once after a
 * failure, and never blocks execution: a failed call returns `ok: false` with a reason.
 *
 * Checked on Windows 11 (scripts/windows-overlay-smoke.mjs, scripts/windows-dock-smoke.mjs). Primitives such as rings
 * and pointers are refused, and buttons act only on a real mouse press. The dock layout reserves a strip with the shell.
 */
export class WindowsOverlayRenderer implements OverlayRenderer {
  readonly #options: WindowsOverlayRendererOptions;
  readonly #sessionId: string;
  readonly #visual: Partial<OverlayVisualConfig>;
  readonly #token = randomBytes(32).toString("hex");
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<boolean> | undefined;
  #buffer = "";
  #stderr = "";
  #report: OverlayCapabilityReport = unsupportedReport("overlay_not_started");
  #rendererEpoch = 0;
  #handshake: "not_attempted" | "pending" | "passed" | "failed" = "not_attempted";
  #startAttempts = 0;
  #restarts = 0;
  #lastFailure: string | undefined;
  #lastCommand: string | undefined;
  #lastAckAt: string | undefined;
  #closed = false;

  constructor(options: WindowsOverlayRendererOptions) {
    this.#options = options;
    this.#sessionId = options.sessionId ?? `overlay-session-${randomUUID()}`;
    this.#visual = options.visual ?? {};
  }

  async capabilities(): Promise<OverlayCapabilityReport> {
    await this.#settle();
    return this.#report;
  }

  async diagnostics(): Promise<OverlayRendererDiagnostics> {
    const capabilities = await this.capabilities();
    const childState: OverlayRendererDiagnostics["childState"] = this.#child !== undefined ? "running" : this.#closed ? "closed" : this.#lastFailure !== undefined ? "failed" : "stopped";
    const maxRestarts = this.#options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    return {
      requestedMode: "auto",
      effectiveBackend: RENDERER_NAME,
      rendererStatus: capabilities.rendererStatus,
      sessionType: capabilities.sessionType,
      displayPresent: process.platform === "win32",
      waylandDisplayPresent: false,
      pythonExecutable: "powershell.exe",
      rendererScriptPresent: true,
      childState,
      handshake: this.#handshake,
      rendererEpoch: this.#rendererEpoch,
      ...(this.#lastCommand === undefined ? {} : { lastCommand: this.#lastCommand }),
      ...(this.#lastAckAt === undefined ? {} : { lastAckAt: this.#lastAckAt }),
      ...(this.#stderr === "" ? {} : { lastStderrSummary: summarize(this.#stderr) }),
      capabilities,
      activeOverlayCount: 0,
      restartCount: this.#restarts,
      restartAllowed: this.#startAttempts <= maxRestarts,
      ...(this.#lastFailure === undefined ? {} : { lastFailure: this.#lastFailure }),
      recommendedAction: capabilities.supported
        ? "Windows overlay process healthy."
        : "Set OSSEO_WINDOWS_OVERLAY=1 and run node scripts/windows-overlay-smoke.mjs on Windows; the reason says what failed."
    };
  }

  async warmup(): Promise<void> {
    // The start goes on in the background: a cold PowerShell start can take tens of seconds, and server start must not wait for it.
    void this.#ensureStarted().catch(() => undefined);
  }

  async restart(): Promise<OverlayRendererRestartResult> {
    if (this.#closed) return { ok: false, reason: "overlay_renderer_closed", diagnostics: await this.diagnostics() };
    this.#stopChild("overlay_renderer_restarting");
    this.#startAttempts = 0;
    this.#restarts = 0;
    this.#lastFailure = undefined;
    this.#report = unsupportedReport("overlay_not_started");
    const started = await this.#ensureStarted();
    return { ok: started, reason: started ? "overlay_renderer_restarted" : "overlay_renderer_restart_failed", diagnostics: await this.diagnostics() };
  }

  async show(record: OverlayRenderRecord): Promise<OverlayOperationResult> {
    return await this.#operation("show", record);
  }

  async update(record: OverlayRenderRecord): Promise<OverlayOperationResult> {
    return await this.#operation("update", record);
  }

  async dismiss(overlayId: string): Promise<OverlayOperationResult> {
    return await this.#operation("dismiss", { overlayId });
  }

  async clear(): Promise<OverlayOperationResult> {
    return await this.#operation("clear", {});
  }

  async emergencyHide(): Promise<OverlayOperationResult> {
    return await this.#operation("emergency_hide", {});
  }

  async state(): Promise<OverlayStateSnapshot> {
    const data = await this.#query("state");
    const record = data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const overlays = Array.isArray(record.overlays) ? (record.overlays as OverlayStateSnapshot["overlays"]) : [];
    const pendingEvents = Array.isArray(record.pendingEvents) ? record.pendingEvents.filter(isOverlayWidgetEvent) : [];
    return { renderer: this.#report, overlays, pendingEvents, emergencyHidden: record.emergencyHidden === true };
  }

  async events(): Promise<OverlayWidgetEvent[]> {
    return (await this.state()).pendingEvents;
  }

  async drainEvents(): Promise<OverlayWidgetEvent[]> {
    const data = await this.#query("events");
    const events = data !== null && typeof data === "object" ? (data as { events?: unknown }).events : undefined;
    return Array.isArray(events) ? events.filter(isOverlayWidgetEvent) : [];
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stopChild("overlay_renderer_closed");
    this.#report = unsupportedReport("overlay_renderer_closed");
  }

  async #operation(command: OperationCommand, payload: unknown): Promise<OverlayOperationResult> {
    const ready = await this.#settle();
    if (ready === undefined) return failed("renderer_starting");
    if (!ready) return failed(this.#lastFailure ?? "overlay_renderer_unavailable");
    let reply: OverlayRendererReply;
    try {
      reply = await this.#send(command, payload, this.#options.commandTimeoutMs ?? DEFAULT_COMMAND_MS);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "renderer_protocol_error";
      this.#fail(reason);
      return failed(reason);
    }
    if (reply.ok !== true) {
      const reason = typeof reply.error === "string" ? reply.error : "overlay_render_failed";
      this.#lastFailure = reason;
      return failed(reason);
    }
    const data = reply.data;
    if (!validateRendererOperationData(data, command)) {
      this.#fail("renderer_protocol_error");
      return failed("renderer_protocol_error");
    }
    if (data.rendererEpoch !== this.#rendererEpoch) {
      this.#fail("renderer_epoch_mismatch");
      return failed("renderer_epoch_mismatch");
    }
    this.#lastAckAt = new Date().toISOString();
    if (command === "show" || command === "update") {
      if (data.visible !== true || (data.drawReadyCount ?? 0) === 0) {
        this.#lastFailure = "renderer_visibility_timeout";
        return failed("renderer_visibility_timeout");
      }
      if (data.liveSurfaceRegistered !== true) {
        this.#lastFailure = "overlay_live_registration_missing";
        return failed("overlay_live_registration_missing");
      }
    }
    return {
      ok: true,
      reason: data.reason ?? `windows_overlay_${data.acknowledgement}`,
      acknowledged: true,
      rendererEpoch: data.rendererEpoch,
      visibleWindowCount: data.visibleWindowCount,
      interactiveWindowCount: data.interactiveWindowCount,
      ...(data.transparentWindowCount === undefined ? {} : { transparentWindowCount: data.transparentWindowCount }),
      ...(data.drawReadyCount === undefined ? {} : { drawReadyCount: data.drawReadyCount }),
      ...(data.liveSurfaceRegistered === undefined ? {} : { liveSurfaceRegistered: data.liveSurfaceRegistered }),
      ...(data.visible === undefined ? {} : { visible: data.visible })
    };
  }

  async #query(command: StateCommand): Promise<unknown> {
    if ((await this.#settle()) !== true) return undefined;
    try {
      const reply = await this.#send(command, {}, this.#options.commandTimeoutMs ?? DEFAULT_COMMAND_MS);
      return reply.ok === true ? reply.data : undefined;
    } catch (error: unknown) {
      this.#fail(error instanceof Error ? error.message : "renderer_protocol_error");
      return undefined;
    }
  }

  /** Waits for the start for at most STARTUP_WAIT_MS: true when running, false when failed, undefined while still starting. */
  async #settle(): Promise<boolean | undefined> {
    return await Promise.race([this.#ensureStarted(), timeoutValue(STARTUP_WAIT_MS)]);
  }

  async #ensureStarted(): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#child !== undefined && this.#handshake === "passed") return true;
    if (this.#starting !== undefined) return await this.#starting;
    this.#starting = this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #start(): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#startAttempts > (this.#options.maxRestarts ?? DEFAULT_MAX_RESTARTS)) {
      if (this.#lastFailure === undefined) this.#lastFailure = "renderer_start_limit";
      return false;
    }
    this.#startAttempts += 1;
    let command: { program: string; args: string[] };
    try {
      command = this.#options.command ?? (await this.#writeScript());
    } catch {
      this.#fail("renderer_script_unwritable");
      return false;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.program, command.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: this.#environment() });
    } catch {
      this.#fail("renderer_process_exited");
      return false;
    }
    this.#child = child;
    this.#buffer = "";
    this.#stderr = "";
    this.#handshake = "pending";
    this.#report = unsupportedReport("overlay_starting", "degraded");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-2_000);
    });
    child.on("error", () => this.#childGone(child, "renderer_process_exited"));
    child.on("exit", () => this.#childGone(child, "renderer_process_exited"));

    const epoch = this.#rendererEpoch + 1;
    let hello: OverlayRendererReply;
    try {
      hello = await this.#send("hello", { sessionId: this.#sessionId, rendererEpoch: epoch, visual: this.#visual }, this.#options.startupTimeoutMs ?? DEFAULT_STARTUP_MS);
    } catch (error: unknown) {
      this.#fail(error instanceof Error ? error.message : "renderer_handshake_timeout");
      return false;
    }
    const data = hello.data;
    if (hello.ok !== true || !validateRendererHandshake(data)) {
      this.#fail(typeof hello.error === "string" ? hello.error : "renderer_protocol_error");
      return false;
    }
    if (data.rendererEpoch !== epoch) {
      this.#fail("renderer_epoch_mismatch");
      return false;
    }
    const capabilities = readCapabilities(data.capabilities);
    if (capabilities === undefined) {
      this.#fail("renderer_protocol_error");
      return false;
    }
    if (capabilities.supported !== true) {
      this.#fail(capabilities.reason || "overlay_input_guard_unavailable");
      return false;
    }
    if (this.#closed) {
      this.#fail("renderer_closed");
      return false;
    }
    this.#rendererEpoch = epoch;
    this.#handshake = "passed";
    this.#report = { ...capabilities, supported: true, available: true, visible: true, rendererStatus: "available" };
    return true;
  }

  async #writeScript(): Promise<{ program: string; args: string[] }> {
    const dir = path.join(this.#options.osseoDir, "run");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "windows-overlay.ps1");
    await writeFile(file, WINDOWS_OVERLAY_SCRIPT, { encoding: "utf8" });
    return { program: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", file] };
  }

  #environment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const name of ENVIRONMENT_NAMES) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    return environment;
  }

  #send(command: OverlayRendererCommand, payload: unknown, timeoutMs: number): Promise<OverlayRendererReply> {
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed) return Promise.reject(new Error("renderer_process_exited"));
    if (this.#pending.size >= OVERLAY_IPC_MAX_IN_FLIGHT) return Promise.reject(new Error("renderer_protocol_error"));
    const id = `overlay_ipc_${randomUUID()}`;
    const request: OverlayRendererRequest = { version: OVERLAY_IPC_VERSION, id, token: this.#token, command, ...(payload === undefined ? {} : { payload }) };
    const encoded = serializeRendererMessage(request);
    if (encoded === undefined) return Promise.reject(new Error("renderer_protocol_error"));
    this.#lastCommand = command;
    return new Promise<OverlayRendererReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(command === "hello" ? "renderer_handshake_timeout" : "renderer_command_timeout"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${encoded}\n`, (error) => {
        if (error === undefined || error === null) return;
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error("renderer_process_exited"));
      });
    });
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > OVERLAY_IPC_MAX_BYTES * 2) {
      this.#fail("renderer_protocol_error");
      return;
    }
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== "") this.#onLine(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // PowerShell may print other text; only JSON lines are replies.
    }
    const id = parsed !== null && typeof parsed === "object" ? (parsed as { id?: unknown }).id : undefined;
    if (typeof id !== "string") return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (!validateRendererReply(parsed)) {
      pending.reject(new Error("renderer_protocol_error"));
      this.#fail("renderer_protocol_error");
      return;
    }
    pending.resolve(parsed);
  }

  #childGone(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.#child !== child) return;
    this.#fail(reason);
  }

  #fail(reason: string): void {
    const child = this.#child;
    this.#child = undefined;
    this.#handshake = "failed";
    this.#lastFailure = reason;
    this.#report = unsupportedReport(reason);
    this.#restarts = Math.min((this.#options.maxRestarts ?? DEFAULT_MAX_RESTARTS) + 1, this.#restarts + 1);
    this.#rejectAll(new Error(reason));
    if (child !== undefined) this.#kill(child);
  }

  #stopChild(reason: string): void {
    const child = this.#child;
    this.#child = undefined;
    this.#handshake = "not_attempted";
    this.#rejectAll(new Error(reason));
    if (child !== undefined) this.#kill(child);
  }

  #kill(child: ChildProcessWithoutNullStreams): void {
    try {
      child.stdin.end();
    } catch {
      /* Already gone. */
    }
    try {
      child.kill();
    } catch {
      /* Already gone. */
    }
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}
