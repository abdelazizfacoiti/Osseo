import type {
  AgentHostConfig,
  AppDetectionResult,
  AppOpenResult,
  AppStrategyResult,
  AppStrategyTaskType,
  AdapterRegistrySnapshot,
  AuditLogger,
  ToolTraceLogger,
  AccessibilityFindElementResult,
  AccessibilityFieldAtPointResult,
  AccessibilityFocusElementResult,
  AccessibilityInspectElementResult,
  AccessibilityInvokeActionResult,
  AccessibilitySetValueResult,
  AccessibilityTreeResult,
  CapabilityRegistrySnapshot,
  DesktopCapabilitiesResult,
  DesktopClickResult,
  DesktopPointerResult,
  DesktopGetActiveWindowResult,
  DesktopHotkeyResult,
  DesktopScreenshotResult,
  DesktopTypeTextResult,
  DesktopWindowContext,
  WindowFocusResult,
  WindowListResult,
  DependencyCheckResult,
  DependencyKind,
  FileEnsureDirResult,
  FileExistsResult,
  FileListResult,
  FileReadResult,
  FileWriteResult,
  InstalledAppSummary,
  RuntimePolicy,
  ShellRunResult,
  SystemInfo,
  SandboxSupportProbeResult
  ,VisionGroundingResult, VisionMode
} from "@agenthost/core";
import type { OverlayManager } from "@agenthost/app-overlay";
import type { BrowserAutomation, LinuxClipboardResult, RunSafeCommandInput, UrlOpenBrowser, UrlOpenResult } from "@agenthost/os-linux";
import type { GrantStore } from "./grants.js";
import type { AnyAgentHostToolDefinition } from "./tool-runner.js";
import type { ToolActionOverlay } from "./action-overlay.js";
import type { ActionTimeline } from "./action-timeline.js";

export interface LinuxAutomation {
  getSystemInfo(): Promise<SystemInfo> | SystemInfo;
  checkDependency(input: { name: string; kind?: DependencyKind }): Promise<DependencyCheckResult>;
  detectApp(input: { appName: string }): Promise<AppDetectionResult>;
  listInstalledApps(input: { query?: string; limit?: number }): Promise<{ apps: InstalledAppSummary[]; truncated: boolean }>;
  openApp(input: { appName: string }): Promise<AppOpenResult>;
  openUrl?(input: { url: string; browser?: UrlOpenBrowser }): Promise<UrlOpenResult>;
  getAppStrategy(input: { appName: string; taskType?: AppStrategyTaskType }): Promise<AppStrategyResult>;
  runSafeCommand(input: RunSafeCommandInput): Promise<ShellRunResult>;
  writeFile(input: {
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    createParents?: boolean;
  }): Promise<FileWriteResult>;
  readFile(input: { path: string; encoding?: "utf8" | "base64"; maxBytes?: number }): Promise<FileReadResult>;
  fileExists(input: { path: string }): Promise<FileExistsResult>;
  listDirectory(input: { path: string; limit?: number }): Promise<FileListResult>;
  ensureDir(input: { path: string }): Promise<FileEnsureDirResult>;
  copyFile?(input: { source: string; destination: string }): Promise<{ source: string; destination: string; copied: boolean }>;
  moveFile?(input: { source: string; destination: string }): Promise<{ source: string; destination: string; moved: boolean }>;
  deletePath?(input: { path: string; recursive?: boolean }): Promise<{ path: string; deleted: boolean }>;
  getDesktopCapabilities(): Promise<DesktopCapabilitiesResult>;
  getActiveWindow(): Promise<DesktopGetActiveWindowResult>;
  screenshot(input: {
    path: string;
    includeActiveWindowOnly?: boolean;
    format?: "png" | "jpeg";
    quality?: number;
    scale?: number;
    region?: { x: number; y: number; width: number; height: number };
  }): Promise<DesktopScreenshotResult>;
  listWindows(input: { limit?: number; includeTitles?: boolean }): Promise<WindowListResult>;
  /** Drops the short-lived window-list cache so the next listing reflects a just-performed action. */
  invalidateWindowCache?(): void;
  setClipboard?(input: { text: string }): Promise<LinuxClipboardResult>;
  getClipboard?(): Promise<LinuxClipboardResult>;
  /** Milliseconds since the last keyboard/pointer input, or undefined when unknown. */
  userIdleMs?(): Promise<number | undefined>;
  /** Dedicated-Chrome automation over the DevTools Protocol; absent when no browser is installed. */
  browser?: BrowserAutomation;
  /** Nested X display all desktop work runs on, when execution.placement is background. */
  backgroundDisplay?: string;
  /** Set when this OS has no desktop adapter; desktop-touching tools then fail with unsupported_platform. */
  unsupportedPlatform?: string;
  focusWindow(input: { windowId?: string; appName?: string; title?: string; pid?: number }): Promise<WindowFocusResult>;
  hotkey(input: { keys: string[]; repeat?: number; activeWindow: DesktopWindowContext }): Promise<DesktopHotkeyResult>;
  typeText(input: { text: string; activeWindow: DesktopWindowContext }, options?: { settle?: () => Promise<unknown> }): Promise<DesktopTypeTextResult>;
  click(input: {
    x: number;
    y: number;
    button?: "left" | "middle" | "right";
    activeWindow: DesktopWindowContext;
  }): Promise<DesktopClickResult>;
  pointer?(input: { action: "move_mouse" | "scroll" | "double_click" | "right_click" | "drag"; activeWindow: DesktopWindowContext; x?: number; y?: number; direction?: "up" | "down" | "left" | "right"; amount?: number; startX?: number; startY?: number; endX?: number; endY?: number; durationMs?: number }): Promise<DesktopPointerResult>;
  checkSandboxSupport?(): Promise<SandboxSupportProbeResult>;
  analyzeImage?(input: { imagePath: string; source: "agenthost_screenshot" | "agenthost_output" | "granted_path"; basename: string; mode: VisionMode; maxItems: number }): Promise<VisionGroundingResult>;
  getScreenGeometry?(): Promise<{ supported: boolean; bounds?: { x: number; y: number; width: number; height: number }; reason: string }>;
  getActiveWindowBounds?(): Promise<{ supported: boolean; bounds?: { x: number; y: number; width: number; height: number }; reason: string }>;
  getAccessibilityTree(input: {
    appName?: string;
    windowId?: string;
    pid?: number;
    maxDepth?: number;
    maxNodes?: number;
    includeText?: boolean;
  }): Promise<AccessibilityTreeResult>;
  findAccessibilityElement(input: {
    appName?: string;
    windowId?: string;
    pid?: number;
    query: string;
    role?: string;
    limit?: number;
  }): Promise<AccessibilityFindElementResult>;
  /** The editable text field at a screen point, for desktop.set_field's checks. Optional for fakes. */
  readTextAtPoint?(input: { appName?: string; pid?: number; x: number; y: number }): Promise<AccessibilityFieldAtPointResult>;
  inspectAccessibilityElement(input: {
    appName?: string;
    windowId?: string;
    pid?: number;
    elementId?: string;
    query?: string;
    role?: string;
  }): Promise<AccessibilityInspectElementResult>;
  invokeAccessibilityAction(input: {
    appName?: string;
    windowId?: string;
    pid?: number;
    elementId?: string;
    query?: string;
    role?: string;
    actionName: string;
    requireExactMatch?: boolean;
  }): Promise<AccessibilityInvokeActionResult>;
  setAccessibilityValue(input: {
    appName?: string;
    windowId?: string;
    pid?: number;
    elementId?: string;
    query?: string;
    role?: string;
    value: string;
    dataSensitivity?: "none" | "low" | "sensitive" | "secret";
  }): Promise<AccessibilitySetValueResult>;
  focusAccessibilityElement(input: {
    appName?: string;
    windowId?: string;
    pid?: number;
    elementId?: string;
    query?: string;
    role?: string;
  }): Promise<AccessibilityFocusElementResult>;
}

export interface AgentHostRuntimeInfo {
  version: string;
  entryPath: string;
  startedAt: string;
}

export interface AgentHostMcpContext {
  sessionId: string;
  runtime?: AgentHostRuntimeInfo;
  config: AgentHostConfig;
  policy: RuntimePolicy;
  /** True only while the runner executes an exact confirmed effect. */
  confirmationSatisfied?: boolean;
  /** Called when a guard pauses the agent, with the exact command that resumes it. */
  notifySelfPause?: (reason: string) => void;
  registry: CapabilityRegistrySnapshot;
  adapters: AdapterRegistrySnapshot;
  logger: AuditLogger;
  /** Optional timestamped phase trace, enabled with AGENTHOST_TRACE=1. */
  trace?: ToolTraceLogger;
  /** Internal to a confirmed computer.run_steps execution; never set by MCP input. */
  planApproval?: { planFingerprint: string; maxRisk: "low" | "medium" };
  /** One-based step position within the current computer.run_steps plan. */
  planStep?: { index: number; total: number };
  grants: GrantStore;
  overlay?: OverlayManager;
  actionOverlay?: ToolActionOverlay;
  actionTimeline?: ActionTimeline;
  /** Captures a screenshot with all visual surfaces temporarily removed. */
  overlayScreenshotSuppression?: <T>(capture: () => Promise<T>) => Promise<T>;
  /** Live tool definitions for governed nested execution (plan executor). */
  tools?: Map<string, AnyAgentHostToolDefinition<any>>;
  linux: LinuxAutomation;
}
