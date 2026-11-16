import { triggerReplay } from "./replay-trigger.js";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { ensurePrivateDirectory } from "@agenthost/core";
import { createScreenTools } from "./tools/screen.js";
import { createGuideTools } from "./tools/guide.js";
import { createSeeTool } from "./tools/see.js";
import { createNumberedTools } from "./tools/numbered.js";
import { hiddenToolHint, isDefaultTool, listedTools } from "./tool-profile.js";
import { renderResultText, type OutputVerbosity, type StateHolder } from "./lean-output.js";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/** run/background-display.json holds {"display": ":N"} while a background display is up; removed when it is not. */
async function writeBackgroundDisplayInfo(agentHostDir: string, display: string | undefined): Promise<void> {
  const file = path.join(agentHostDir, "run", "background-display.json");
  if (display === undefined) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ display })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}
import os from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ACTION_CARD_PAUSE_PREFIX,
  createBaseCapabilityRegistry,
  createSessionId,
  JsonlAuditLogger,
  JsonlFailureLog,
  failureLogPath,
  JsonlTraceLogger,
  loadAgentHostConfig,
  ensurePolicyFile,
  describeDesktopPlatform,
  setUserBlockedApps,
  summarizeForLog,
  readRunState,
  readAttention,
  requestPause,
  clearPause,
  requestStop,
  clearActiveTaskApproval,
  writeActivityStatus,
  AGENTHOST_VERSION,
  type ActivityStatusOutcome,
  type AgentHostConfig,
  type AuditLogger,
  type CapabilityRegistry,
  type RuntimePolicy,
  type ToolResult
} from "@agenthost/core";
import {
  checkLinuxDependency,
  captureLinuxScreenshot,
  clickLinuxDesktop,
  copyLinuxFile,
  deleteLinuxPath,
  performLinuxPointerAction,
  moveLinuxFile,
  detectLinuxApp,
  detectLinuxAccessibilitySupport,
  ensureLinuxDir,
  findLinuxAccessibilityElements,
  readLinuxTextAtPoint,
  focusLinuxAccessibilityElement,
  focusLinuxWindow,
  getLinuxActiveWindow,
  getLinuxScreenGeometry,
  waitForPointerPress,
  getLinuxActiveWindowBounds,
  getLinuxAccessibilityTree,
  getLinuxAppStrategy,
  getLinuxDesktopCapabilities,
  getLinuxSystemInfo,
  inspectLinuxAccessibilityElement,
  invokeLinuxAccessibilityAction,
  linuxFileExists,
  listLinuxWindows,
  listInstalledLinuxApps,
  listLinuxDirectory,
  openLinuxApp,
  openLinuxUrl,
  clearWindowListCache,
  getLinuxClipboard,
  setLinuxClipboard,
  readLinuxFile,
  probeLinuxSandboxSupport,
  runSafeLinuxCommand,
  sendLinuxHotkey,
  setLinuxAccessibilityValue,
  typeLinuxText,
  writeLinuxFile,
  analyzeLinuxImage,
  readUserIdleMs,
  getBrowserSession,
  startBackgroundDisplay,
  PortalSession,
  createPortalDesktop,
  shouldUseWaylandPortal
} from "@agenthost/os-linux";
import { WindowsHelperProcess, createWindowsDesktop } from "@agenthost/os-windows";
import { createOverlayRenderer, sweepOrphanedOverlayRenderers, VisualSurfaceCoordinator, WindowsOverlayRenderer, windowsOverlayEnabled, type OverlayRenderer } from "@agenthost/app-overlay";
import type { AgentHostMcpContext, LinuxAutomation } from "./context.js";
import { createDesktopTools } from "./tools/desktop.js";
import { createAppTools } from "./tools/app.js";
import { createUiTools } from "./tools/ui.js";
import { createClipboardTools } from "./tools/clipboard.js";
import { createBrowserTools } from "./tools/browser.js";
import { createOwnBrowserTools } from "./tools/own-browser.js";
import { createWorkflowTools } from "./tools/workflow.js";
import { createMemoryTools } from "./tools/memory.js";
import { createPushNotifier } from "./push-notify.js";
import { createComputerTools } from "./tools/computer.js";
import { createFileTools } from "./tools/file.js";
import { createShellTools } from "./tools/shell.js";
import { createSystemTools } from "./tools/system.js";
import { createWindowTools } from "./tools/window.js";
import { createVisionTools } from "./tools/vision.js";
import { createTaskTools } from "./tools/tasks.js";
import { createAgentTools } from "./tools/agent.js";
import { applyProductionExecutionMetadata, materializeToolDefinitions, toolCapabilities } from "./tool-metadata.js";
import { listResourceEntries, readResource } from "./resources.js";
import { runTool, type AnyAgentHostToolDefinition } from "./tool-runner.js";
import { ToolActionOverlay } from "./action-overlay.js";
import { HostAttention } from "./host-attention.js";
import { inputGuardPath } from "./input-guard.js";
import { bootstrapRequirements } from "./requirements-bootstrap.js";
import { ActionTimeline } from "./action-timeline.js";
import { HandoffOverlay } from "./handoff-overlay.js";
import { ApprovalOverlay } from "./approval-overlay.js";
import { askInChatDetailed, type ElicitFn } from "./chat-approval.js";
import { TaskActivityOverlay } from "./task-overlay.js";
import { shouldShowActionCard, shouldShowActivityCard } from "./activity.js";

const SERVER_VERSION = AGENTHOST_VERSION;
const ACTION_PAUSE_REASON = ACTION_CARD_PAUSE_PREFIX;

const SERVER_INSTRUCTIONS =
  "AgentHost is a universal local automation host. It provides desktop automation, file operations, shell commands, vision/OCR, and window management. Use GUI click/type as fallback when policy allows. Routine local actions execute directly. Consequential actions such as external sends/uploads, deletes, private-data reads, and financial effects require an exact dry-run preview and single-use confirmation token. Stop, takeover, and pause flags halt new state-changing calls. For fast decisions, inspect once, act, then verify; avoid repeating unchanged discovery.";

const DESKTOP_INSTRUCTIONS =
  "AgentHost gives an agent a permissioned body on a real computer. Loop: see (numbered list of what is on screen), act by number with click, type, key, scroll or drag, then see again. For web tasks open a url in the agent's own browser. Use guide.show for sensitive apps and ask for logins. Sends, uploads, deletes and payments return confirmation_required: repeat the same call with the confirmationToken after the person approves. Stop, takeover and pause flags halt actions.";

let lastApprovalSignalAt = 0;
let lastOverlaySignalAt = 0;

function activitySummary(tool: AnyAgentHostToolDefinition, input: unknown): string {
  try {
    const summary = typeof tool.inputSummary === "function" ? tool.inputSummary(input) : tool.inputSummary;
    return summarizeForLog(summary) || "Computer action";
  } catch {
    return "Computer action";
  }
}

function activityOutcome(result: ToolResult): ActivityStatusOutcome {
  if (result.ok) return "ok";
  if (result.error?.code === "confirmation_required") return "approval_required";
  if (["emergency_stop_requested", "human_takeover_active", "pause_requested", "safety_blocked"].includes(result.error?.code ?? "")) return "halted";
  return "error";
}

function recordActivity(
  agentHostDir: string,
  sessionId: string,
  mode: "always" | "on_change" | "off",
  tool: string,
  phase: "started" | "finished",
  actionOverlay: ToolActionOverlay,
  outcome?: ActivityStatusOutcome
): void {
  try {
    const snapshot = actionOverlay.snapshot();
    const rawError = snapshot.lastRenderError
      ?? (snapshot.showTimedOut ? "overlay_show_timeout" : undefined)
      ?? (snapshot.hidden ? "overlay_hidden_by_operator" : undefined)
      ?? (snapshot.started && !snapshot.visible ? "overlay_not_visible" : undefined);
    const error = rawError === undefined ? undefined : rawError.replace(/\s+/g, " ").trim().slice(0, 200) || "overlay_render_failed";
    void writeActivityStatus(agentHostDir, {
      schemaVersion: 1,
      sessionId: sessionId.slice(0, 200) || "session_unknown",
      mode,
      tool: tool.slice(0, 200) || "unknown_tool",
      phase,
      ...(outcome === undefined ? {} : { outcome }),
      overlay: {
        started: snapshot.started,
        visible: snapshot.visible,
        ...(error === undefined ? {} : { error }),
        ...(snapshot.showTimedOut ? { timedOut: true } : {})
      },
      updatedAt: new Date().toISOString()
    }).catch(() => undefined);
  } catch {
    /* Activity status is diagnostics only. */
  }
}

function signalApprovalRequired(): void {
  const now = Date.now();
  if (now - lastApprovalSignalAt < 5_000) return;
  lastApprovalSignalAt = now;
  try {
    const child = spawn("notify-send", [
      "-a", "AgentHost",
      "-u", "normal",
      "AgentHost approval required",
      "Open the AgentHost card or run: agenthost confirmations"
    ], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* Desktop notifications are best effort. */
  }
}

function signalOverlayUnavailable(): void {
  const now = Date.now();
  if (now - lastOverlaySignalAt < 5_000) return;
  lastOverlaySignalAt = now;
  try {
    const child = spawn("notify-send", [
      "-a", "AgentHost",
      "-u", "low",
      "AgentHost overlay unavailable",
      "The action continued. Run: agenthost overlay status"
    ], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
  }
}

/** A guard paused the agent: one persistent desktop notification carrying the exact command that resumes it. */
function signalSelfPause(reason: string): void {
  try {
    const child = spawn("notify-send", ["-a", "AgentHost", "-u", "critical", "-t", "0", "AgentHost paused itself", `${reason.slice(0, 180)} Resume: agenthost agent resume`], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* Desktop notifications are best effort. */
  }
}

export interface AgentHostServerOptions {
  config?: AgentHostConfig;
  policy?: RuntimePolicy;
  registry?: CapabilityRegistry;
  logger?: AuditLogger;
  trace?: import("@agenthost/core").ToolTraceLogger;
  sessionId?: string;
  linux?: LinuxAutomation;
  /** Host service only: a renderer owned by the host and shared by its sessions. Never closed from here (closing a proxy is a no-op). */
  overlayRenderer?: OverlayRenderer;
}

/** A tool may attach an image under data.inlineImage. It goes to the client as image content, never into the JSON text. */
function toMcpToolResult(result: ToolResult, verbosity: OutputVerbosity, stateHolder: StateHolder): {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError: boolean;
} {
  const inline = (result.data as { inlineImage?: { data: string; mimeType: string } } | null | undefined)?.inlineImage;
  const shown: ToolResult = inline === undefined
    ? result
    : { ...result, data: { ...(result.data as object), inlineImage: { mimeType: inline.mimeType, bytes: inline.data.length } } as ToolResult["data"] };
  return {
    content: [
      { type: "text", text: renderResultText(shown, verbosity, stateHolder) },
      ...(inline === undefined ? [] : [{ type: "image" as const, data: inline.data, mimeType: inline.mimeType }])
    ],
    isError: !result.ok
  };
}

export async function createAgentHostMcpServer(options: AgentHostServerOptions = {}): Promise<{
  server: Server;
  context: AgentHostMcpContext;
  closeResources: () => Promise<void>;
}> {
  const config = options.config ?? (await loadAgentHostConfig());
  // The last state fingerprint this session reported, so an unchanged state is not repeated.
  const resultState: StateHolder = {};
  setUserBlockedApps(config.blockedApps ?? []);
  // Desktop commands run with this as their working directory; on a fresh install it may not exist yet.
  // Owner-only: mode 0700 on POSIX, an access list (icacls) on Windows where file modes do nothing.
  await ensurePrivateDirectory(config.agentHostDir).catch(() => undefined);
  // The commented default policy.toml, written once and never over an existing file.
  await ensurePolicyFile(config.agentHostDir).catch(() => undefined);
  // Background placement: all desktop work happens on a nested display. If it
  // cannot start, fail loudly: quietly acting on the person's screen is what
  // they asked to avoid.
  let backgroundDisplay: Extract<Awaited<ReturnType<typeof startBackgroundDisplay>>, { ok: true }> | undefined;
  if (config.execution?.placement === "background" && options.linux === undefined) {
    const started = await startBackgroundDisplay();
    if (!started.ok) throw new Error(`background_display_unavailable: ${started.reason}`);
    backgroundDisplay = started;
    // The viewer reads this to find the display; it holds only the display name.
    await writeBackgroundDisplayInfo(config.agentHostDir, started.display).catch(() => undefined);
  }
  const desktopContext = { agentHostDir: config.agentHostDir, ...(backgroundDisplay === undefined ? {} : { env: backgroundDisplay.env }) };
  const sessionId = options.sessionId ?? createSessionId();
  const registry = options.registry ?? createBaseCapabilityRegistry();
  const logger = options.logger ?? new JsonlAuditLogger(config.logFile);
  const failureLog = new JsonlFailureLog(failureLogPath(config.logFile));
  const trace = options.trace ?? (process.env.AGENTHOST_TRACE === "1"
    ? new JsonlTraceLogger(path.join(
        config.agentHostDir,
        "logs",
        "traces",
        `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.jsonl`
      ))
    : undefined);
  const policy = options.policy ?? config.policy;
  const activityMode = config.overlay?.mode ?? "always";
  // The rail is a dock-style layout: it holds the same strut and the same timeline and bottom cards.
  const dockLayout = (config.overlay?.layout ?? "dock") === "dock" || config.overlay?.layout === "rail";
  const actionPill = config.overlay?.actionPill ?? !dockLayout;
  const pillAutoHideMs = config.overlay?.pillAutoHideMs ?? 30_000;
  const requestedRenderer = config.overlay?.rendererMode ?? config.overlayRendererMode ?? "auto";
  // Opt-in Windows overlay (WPF, AGENTHOST_WINDOWS_OVERLAY=1). Every other platform and mode keeps the renderer factory.
  const windowsOverlay = describeDesktopPlatform().os === "windows" && windowsOverlayEnabled(process.env) && (requestedRenderer === "auto" || requestedRenderer === "gtk3-native");
  const overlay = new VisualSurfaceCoordinator(options.overlayRenderer ?? (windowsOverlay ? new WindowsOverlayRenderer({ agentHostDir: config.agentHostDir, sessionId }) : createOverlayRenderer(requestedRenderer, {
    sessionId,
    inputGuardPath: inputGuardPath(config.agentHostDir),
    visual: {
      layout: config.overlay?.layout ?? "dock",
      dockSide: config.overlay?.dockSide ?? "right",
      dockWidthPercent: config.overlay?.dockWidthPercent ?? 18,
      dockReserveSpace: config.overlay?.dockReserveSpace ?? true,
      allowSyntheticControl: config.overlay?.allowSyntheticControl ?? false,
      maxWidth: config.overlay?.maxWidth ?? 520
    }
  })), { sessionId }, { reducedMotion: config.overlay?.reducedMotion ?? false });
  let taskActivity: TaskActivityOverlay | undefined;
  // Injected Linux automation means a test or embedded host; never drive the real desktop then.
  const hostAttention = options.linux === undefined ? new HostAttention(config.agentHostDir) : undefined;
  if (options.linux === undefined && process.env.NODE_ENV !== "test") {
    void bootstrapRequirements(config.agentHostDir, config.autoInstallDependencies !== false).catch(() => undefined);
  }
  const actionOverlay = new ToolActionOverlay(overlay, {
    widgetId: `agenthost-action-${sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}`,
    // Dock layout: the action status is a bottom card inside the dock, so it never covers the work area.
    placement: actionPill ? "top_center" : dockLayout ? "bottom_right" : config.overlay?.preferredPosition ?? "top_right",
    persistent: actionPill || dockLayout ? pillAutoHideMs <= 0 : config.overlay?.persistent ?? true,
    autoHideMs: actionPill || dockLayout ? pillAutoHideMs : config.overlay?.autoHideMs ?? 15_000,
    compact: actionPill,
    frame: config.overlay?.frame ?? true,
    // Nested-display coordinates mean nothing on the real screen.
    targetRing: backgroundDisplay === undefined && (config.overlay?.targetRing ?? true),
    targetRingLeadMs: config.overlay?.targetRingLeadMs ?? 150,
    targetRingDurationMs: config.overlay?.targetRingDurationMs ?? 600,
    onPause: async () => { await requestPause(config.agentHostDir, ACTION_PAUSE_REASON); },
    onResume: async () => {
      const state = await readRunState(config.agentHostDir);
      if (state.pause.requested && state.pause.reason?.startsWith(ACTION_CARD_PAUSE_PREFIX) === true) await clearPause(config.agentHostDir);
    },
    onStop: async () => {
      await requestStop(config.agentHostDir, "Stop requested from the AgentHost action card");
      await clearActiveTaskApproval(config.agentHostDir);
      await taskActivity?.operatorStopped();
    },
    isPaused: async () => (await readRunState(config.agentHostDir)).pause.requested,
    // Keep the action card, its frame and ring up between actions while an explicit task is open.
    holdVisible: () => taskActivity?.hasOpenTask() === true
  });
  const actionTimeline = activityMode !== "off" && dockLayout && config.overlay?.timeline !== false
    ? new ActionTimeline(overlay, {
      sessionId: sessionId.replace(/[^A-Za-z0-9._-]/g, "_"),
      readAlerts: async () => {
        const [state, attention] = await Promise.all([readRunState(config.agentHostDir), readAttention(config.agentHostDir)]);
        // Only approvals hold the timeline open; "done" and "idle" just raise the terminal.
        const approval = attention !== undefined && (attention.reason === "permission" || attention.reason === "confirmation");
        return {
          stopped: state.stop.requested,
          paused: state.pause.requested,
          ...(approval ? { attention: { source: attention.source, reason: attention.reason } } : {})
        };
      }
    })
    : undefined;
  const pushNotify = createPushNotifier(config.notifications?.pushUrl);
  const approvalOverlay = activityMode !== "off" && options.linux === undefined
    ? new ApprovalOverlay(overlay, { agentHostDir: config.agentHostDir, sessionId })
    : undefined;
  const handoffOverlay = activityMode !== "off" && options.linux === undefined
    ? new HandoffOverlay(overlay, {
      agentHostDir: config.agentHostDir,
      sessionId: sessionId.replace(/[^A-Za-z0-9._-]/g, "_"),
      notify: (summary, body) => {
        void pushNotify("handoff");
        try {
          const child = spawn("notify-send", ["-a", "AgentHost", "-u", "normal", summary, body.slice(0, 200)], { stdio: "ignore", detached: true });
          child.on("error", () => undefined);
          child.unref();
        } catch { /* Desktop notifications are best effort. */ }
      }
    })
    : undefined;
  if (process.env.NODE_ENV !== "test") sweepOrphanedOverlayRenderers();
  if (activityMode !== "off") {
    taskActivity = new TaskActivityOverlay({
      manager: overlay,
      agentHostDir: config.agentHostDir,
      sessionId,
      placement: "bottom_right",
      persistent: config.overlay?.persistent ?? true,
      ...(config.overlay?.persistent === false ? { autoHideMs: config.overlay?.autoHideMs ?? 15_000 } : {}),
      // Task finished: close the action card, the dock history, and hand focus back to the assistant.
      onFinished: async (task) => {
        await actionOverlay.dismiss().catch(() => undefined);
        await actionTimeline?.reset().catch(() => undefined);
        await hostAttention?.bringHostForward().catch(() => undefined);
        // Opt-in: build the replay in a detached CLI process; never blocks or fails the task.
        triggerReplay({ enabled: config.replay?.onTaskFinish === true, taskId: task.taskId, serverDir: path.dirname(fileURLToPath(import.meta.url)) });
      }
    });
    if (process.env.NODE_ENV !== "test") await overlay.prewarm();
    await taskActivity.initialize();
  }
  const platformReport = describeDesktopPlatform();
  const baseLinux: LinuxAutomation =
    options.linux ?? {
      ...(platformReport.os !== "linux" && platformReport.os !== "windows" ? { unsupportedPlatform: platformReport.guidance[0] ?? "This operating system has no desktop adapter." } : {}),
      ...(backgroundDisplay === undefined ? {} : { backgroundDisplay: backgroundDisplay.display }),
      getSystemInfo: () => getLinuxSystemInfo(config, registry),
      checkDependency: (input) => checkLinuxDependency(input),
      detectApp: (input) => detectLinuxApp(input, policy, desktopContext),
      listInstalledApps: (input) => listInstalledLinuxApps(input),
      openApp: (input) => openLinuxApp(input, policy, desktopContext),
      openUrl: (input) => openLinuxUrl(input, desktopContext),
      getAppStrategy: (input) => getLinuxAppStrategy(input, policy),
      runSafeCommand: (input) => runSafeLinuxCommand(input),
      writeFile: (input) => writeLinuxFile(input, desktopContext),
      readFile: (input) => readLinuxFile(input, desktopContext),
      fileExists: (input) => linuxFileExists(input, desktopContext),
      listDirectory: (input) => listLinuxDirectory(input, desktopContext),
      ensureDir: (input) => ensureLinuxDir(input, desktopContext),
      copyFile: (input) => copyLinuxFile(input, desktopContext),
      moveFile: (input) => moveLinuxFile(input, desktopContext),
      deletePath: (input) => deleteLinuxPath(input, desktopContext),
      getDesktopCapabilities: () => getLinuxDesktopCapabilities(desktopContext),
      getActiveWindow: () => getLinuxActiveWindow(desktopContext),
      getScreenGeometry: () => getLinuxScreenGeometry(desktopContext),
      getActiveWindowBounds: () => getLinuxActiveWindowBounds(desktopContext),
      waitForPointerPress: (input) => waitForPointerPress({ ...input, ...(desktopContext.env === undefined ? {} : { env: desktopContext.env }) }),
      screenshot: (input) => captureLinuxScreenshot(input, desktopContext),
      listWindows: (input) => listLinuxWindows(input, desktopContext),
      invalidateWindowCache: () => clearWindowListCache(),
      setClipboard: (input) => setLinuxClipboard(input.text, desktopContext),
      getClipboard: () => getLinuxClipboard(desktopContext),
      // In a nested display nobody is competing for the cursor, so there is nothing to yield to.
      ...(config.execution?.yieldToUser === false || backgroundDisplay !== undefined ? {} : { userIdleMs: () => readUserIdleMs() }),
      browser: getBrowserSession(config.agentHostDir, backgroundDisplay?.env),
      focusWindow: (input) => focusLinuxWindow(input, desktopContext),
      hotkey: (input) => sendLinuxHotkey(input, desktopContext),
      typeText: (input, options) => typeLinuxText(input, desktopContext, options),
      click: (input) => clickLinuxDesktop(input, desktopContext),
      pointer: (input) => performLinuxPointerAction(input, desktopContext),
      checkSandboxSupport: () => probeLinuxSandboxSupport({ env: process.env }),
      analyzeImage: (input) => analyzeLinuxImage(input, { env: process.env }),
      getAccessibilityTree: (input) => getLinuxAccessibilityTree(input, desktopContext),
      findAccessibilityElement: (input) => findLinuxAccessibilityElements(input, desktopContext),
      readTextAtPoint: (input) => readLinuxTextAtPoint(input, desktopContext),
      inspectAccessibilityElement: (input) =>
        inspectLinuxAccessibilityElement(input, desktopContext),
      invokeAccessibilityAction: (input) =>
        invokeLinuxAccessibilityAction(input, desktopContext),
      setAccessibilityValue: (input) => setLinuxAccessibilityValue(input, desktopContext),
      focusAccessibilityElement: (input) =>
        focusLinuxAccessibilityElement(input, desktopContext)
    };
  // On Windows the desktop methods come from the PowerShell helper; files, shell and the browser stay as they are.
  const windowsHelper = options.linux === undefined && platformReport.os === "windows" ? new WindowsHelperProcess({ agentHostDir: config.agentHostDir }) : undefined;
  // Opt-in (AGENTHOST_WAYLAND_PORTAL=1) on a Wayland session, when no background display is in use: input and
  // screenshots go through the RemoteDesktop and ScreenCast portals after one consent. Tests that inject linux skip it.
  const waylandPortal = options.linux === undefined && windowsHelper === undefined && backgroundDisplay === undefined && shouldUseWaylandPortal(process.env)
    ? new PortalSession()
    : undefined;
  const linux: LinuxAutomation = windowsHelper !== undefined
    ? { ...baseLinux, ...createWindowsDesktop(windowsHelper) }
    : waylandPortal === undefined ? baseLinux : { ...baseLinux, ...createPortalDesktop(waylandPortal) };
  const serverModulePath = fileURLToPath(import.meta.url);
  const runtime = {
    version: SERVER_VERSION,
    entryPath: path.join(path.dirname(serverModulePath), `index${path.extname(serverModulePath)}`),
    startedAt: new Date().toISOString()
  };
  const context: AgentHostMcpContext = {
    sessionId,
    config,
    policy,
    registry,
    logger,
    failureLog,
    ...(trace === undefined ? {} : { trace }),
    overlay,
    actionOverlay,
    ...(actionTimeline === undefined ? {} : { actionTimeline }),
    notifySelfPause: (reason: string) => signalSelfPause(reason),
    overlayScreenshotSuppression: async (capture) => {
      try {
        return await overlay.withScreenshotSuppressed(capture);
      } finally {
        await actionOverlay.refresh();
      }
    },
    workWindowCaptureClean: dockLayout
      && (config.overlay?.dockReserveSpace ?? true)
      && !actionPill
      && !(config.overlay?.frame ?? !dockLayout)
      && !((config.overlay?.targetRing ?? !dockLayout) && backgroundDisplay === undefined),
    linux,
    runtime
  };
  const tools = [
    ...createSystemTools(),
    ...createVisionTools(),
    ...createShellTools(),
    ...createFileTools(),
    ...createDesktopTools(),
    ...createScreenTools(),
    ...createGuideTools(),
    createSeeTool(),
    ...createNumberedTools(),
    ...createAppTools(),
    ...createComputerTools(),
    ...createTaskTools(),
    ...createAgentTools(),
    ...createWindowTools(),
    ...createUiTools(),
    ...createClipboardTools(),
    ...createBrowserTools(),
    ...createOwnBrowserTools(),
    ...createWorkflowTools(),
    ...createMemoryTools()
  ];

  const loadedTools = materializeToolDefinitions(applyProductionExecutionMetadata(tools));
  registry.syncTools(toolCapabilities(loadedTools));
  context.tools = new Map(loadedTools.map((tool) => [tool.name, tool]));

  const toolProfile = config.tools?.profile ?? "desktop";
  const server = new Server(
    {
      name: "agenthost",
      version: SERVER_VERSION
    },
    {
      capabilities: {
        tools: {},
        resources: {}
      },
      instructions: toolProfile === "desktop" ? DESKTOP_INSTRUCTIONS : SERVER_INSTRUCTIONS
    }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: listResourceEntries()
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      const { mimeType, text } = await readResource(
        { registry: context.registry, config: context.config },
        request.params.uri
      );
      return { contents: [{ uri: request.params.uri, mimeType, text }] };
    } catch {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listedTools(loadedTools, toolProfile).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.mcpInputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = loadedTools.find((candidate) => candidate.name === request.params.name);

    if (tool === undefined) {
      const requestedName = request.params.name.slice(0, 200);
      const error = {
        code: "unknown_tool",
        message: `Unknown tool: ${summarizeForLog(requestedName)}`
      };
      const result: ToolResult = {
        ok: false,
        tool: requestedName,
        riskLevel: "observe",
        approval: {
          required: false,
          status: "not_required"
        },
        data: null,
        observations: ["The requested tool is not registered."],
        error
      };

      await logger.log({
        timestamp: new Date().toISOString(),
        sessionId: context.sessionId,
        tool: requestedName,
        riskLevel: "observe",
        ...(context.runtime === undefined ? {} : { serverVersion: context.runtime.version, serverPath: context.runtime.entryPath }),
        inputSummary: "Unknown tool call",
        approvalStatus: "not_required",
        ok: false,
        durationMs: 0,
        outputSummary: error.message,
        errorCode: error.code
      });

      return toMcpToolResult(result, config.output?.verbosity ?? "lean", resultState);
    }

    const rawInput = request.params.arguments ?? {};
    const showActionCard = shouldShowActionCard(tool.name, tool.execution?.executionClass, activityMode);
    const trackActivity = shouldShowActivityCard(tool.name, activityMode);
    if (showActionCard) recordActivity(config.agentHostDir, sessionId, activityMode, tool.name, "started", actionOverlay);
    if (trackActivity) void taskActivity?.noteActivity({ toolName: tool.name, summary: activitySummary(tool, rawInput) });
    if (hostAttention !== undefined && typeof (rawInput as Record<string, unknown>).confirmationToken === "string") {
      await hostAttention.resolveConfirmation();
    }
    const result = await runTool(tool, rawInput, context);
    // Hidden tools stay callable. Name the tool to use instead, once.
    if (toolProfile === "desktop" && !isDefaultTool(tool.name)) result.observations = [...result.observations, hiddenToolHint(tool.name)];
    if (result.error?.code === "confirmation_required") {
      signalApprovalRequired();
      void pushNotify("approval");
      void hostAttention?.requestConfirmation();
      const tokenId = result.confirmation?.tokenId;
      if (tokenId !== undefined && config.approvals?.chat !== false && server.getClientCapabilities()?.elicitation !== undefined) {
        const { outcome, policy } = await askInChatDetailed({
          agentHostDir: config.agentHostDir,
          sessionId: context.sessionId,
          tokenId,
          elicit: (params) => server.elicitInput(params as Parameters<typeof server.elicitInput>[0], { timeout: 120_000 }) as ReturnType<ElicitFn>
        });
        if (outcome === "approved") {
          await hostAttention?.resolveConfirmation();
          result.observations.push(`The person approved this in chat. Repeat the same call with confirmationToken ${tokenId}.`);
          if (policy !== undefined) result.observations.push(policy.written ? `The person chose Always allow here: this kind of action now runs without a prompt (policy.toml rule ${policy.index}).` : policy.message);
        } else if (outcome === "denied") {
          result.observations.push("The person denied this action in chat. Do not retry it.");
        }
      }
    }
    else if (result.overlay?.startsWith("unavailable:") === true) signalOverlayUnavailable();
    if (showActionCard || (result.error?.code === "confirmation_required" && activityMode !== "off")) {
      recordActivity(config.agentHostDir, sessionId, activityMode, tool.name, "finished", actionOverlay, activityOutcome(result));
    }
    if (trackActivity) {
      void taskActivity?.noteActivity({
        toolName: tool.name,
        summary: activitySummary(tool, rawInput),
        outcome: result.ok ? "done" : "failed"
      });
    }
    try { await taskActivity?.observe(tool.name, result); } catch { /* Task card updates are advisory. */ }
    return toMcpToolResult(result, config.output?.verbosity ?? "lean", resultState);
  });

  let resourceClosePromise: Promise<void> | undefined;
  const closeResources = async (): Promise<void> => {
    if (resourceClosePromise !== undefined) return await resourceClosePromise;
    resourceClosePromise = (async () => {
      await taskActivity?.close();
      await handoffOverlay?.close();
      await approvalOverlay?.close();
      await context.linux.browser?.close().catch(() => undefined);
      await waylandPortal?.close().catch(() => undefined);
      await backgroundDisplay?.stop().catch(() => undefined);
      if (backgroundDisplay !== undefined) await writeBackgroundDisplayInfo(config.agentHostDir, undefined).catch(() => undefined);
      await actionOverlay.close();
      await actionTimeline?.close();
      await overlay.close();
      if (process.env.NODE_ENV !== "test") sweepOrphanedOverlayRenderers();
    })();
    return await resourceClosePromise;
  };
  server.onclose = () => { void closeResources(); };
  return {
    server,
    context,
    closeResources
  };
}

// Upper bound on cleanup after the client is gone. Past it the process exits anyway, so a wedged
// overlay renderer cannot keep cards on screen after the session ended.
const STDIO_EXIT_DEADLINE_MS = 6_000;

export async function startStdioServer(): Promise<void> {
  const { server, closeResources } = await createAgentHostMcpServer();
  const transport = new StdioServerTransport();
  const exitOnStdinEnd = process.env.AGENTHOST_STDIO_EXIT_ON_STDIN_END === "1";
  let stopping = false;

  // The MCP stdio contract ends a session by closing the client's stdin, so exit then. An idle
  // event loop is not enough: overlay renderers hold pipes to this process, so it would never
  // drain and the cards would outlive the session.
  const shutdown = (exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    const exit = (): void => { process.exit(exitCode); };
    const deadline = setTimeout(exit, STDIO_EXIT_DEADLINE_MS);
    void (async () => {
      await transport.close().catch(() => undefined);
      await closeResources().catch(() => undefined);
    })().finally(() => {
      clearTimeout(deadline);
      exit();
    });
  };

  process.stdin.once("end", () => { shutdown(0); });
  process.stdin.once("close", () => { shutdown(0); });
  process.once("SIGHUP", () => { shutdown(129); });
  process.once("SIGINT", () => { shutdown(130); });
  process.once("SIGTERM", () => { shutdown(143); });

  await server.connect(transport);
  process.stdin.resume();

  if (exitOnStdinEnd) {
    setTimeout(() => { shutdown(0); }, 1_000);
  }
}