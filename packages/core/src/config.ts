import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getDefaultPolicy } from "./policies.js";
import type { AgentHostConfig, ForgeRuntimeSandboxMode } from "./types.js";
import type { OverlayRendererMode, OverlayPublicConfig } from "./overlay.js";
import { stripBom } from "./text.js";

const forgeRuntimeSandboxModeSchema = z.enum(["auto", "none", "bubblewrap", "firejail", "unshare"]);
const overlayRendererModeSchema = z.enum(["headless", "auto", "gtk3-x11", "gtk3-native", "webkit-gtk-react", "disabled"]);
const overlaySchema = z.object({
  rendererMode: overlayRendererModeSchema.optional(),
  mode: z.enum(["always", "on_change", "off"]).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  density: z.enum(["compact", "normal"]).optional(),
  reducedMotion: z.boolean().optional(),
  persistent: z.boolean().optional(),
  autoHideMs: z.number().int().min(0).max(86_400_000).optional(),
  /** Deprecated: accepted for older configs, ignored. Use persistent/autoHideMs. */
  terminalAutoHideMs: z.number().int().min(0).max(300_000).optional(),
  preferredPosition: z.enum(["top_left", "top_center", "top_right", "bottom_left", "bottom_center", "bottom_right"]).optional(),
  maxWidth: z.number().int().min(240).max(1200).optional(),
  multiMonitor: z.enum(["primary", "all"]).optional(),
  layout: z.enum(["ambient", "dock", "rail"]).optional(),
  dockSide: z.enum(["left", "right"]).optional(),
  dockWidthPercent: z.number().int().min(10).max(40).optional(),
  dockReserveSpace: z.boolean().optional(),
  /** Turns the Windows cards on (WPF). The same as AGENTHOST_WINDOWS_OVERLAY=1; default off. */
  windows: z.boolean().optional(),
  allowSyntheticControl: z.boolean().optional(),
  timeline: z.boolean().optional(),
  frame: z.union([z.boolean(), z.literal("always")]).optional(),
  /** With `frame: "always"`: hide the gray frame after this long with no action (default 120000; 0 keeps it). It returns on the next action. */
  frameIdleMs: z.number().int().min(0).max(86_400_000).optional(),
  actionPill: z.boolean().optional(),
  targetRing: z.boolean().optional(),
  targetRingLeadMs: z.number().int().min(0).max(600).optional(),
  targetRingDurationMs: z.number().int().min(200).max(2_000).optional(),
  pillAutoHideMs: z.number().int().min(0).max(30_000).optional()
}).strict();
const executionSchema = z.object({ placement: z.enum(["foreground", "background"]).optional(), yieldToUser: z.boolean().optional(), maxActionsPerTask: z.number().int().min(0).max(100_000).optional() }).strict();
const speechSchema = z.object({
  enabled: z.boolean().optional(),
  providerPreference: z.array(z.enum(["espeak-ng", "piper", "speech-dispatcher"])).min(1).max(3).optional(),
  defaultProvider: z.enum(["espeak-ng", "piper", "speech-dispatcher"]).optional(),
  artifactTtlMs: z.number().int().positive().max(86_400_000).optional(),
  maxTextChars: z.number().int().positive().max(20_000).optional(),
  maxDurationMs: z.number().int().positive().max(300_000).optional(),
  maxArtifactBytes: z.number().int().positive().max(50_000_000).optional(),
  synthesisTimeoutMs: z.number().int().positive().max(60_000).optional(),
  playbackTimeoutMs: z.number().int().positive().max(300_000).optional()
}).strict();

const configFileSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    agentHostDir: z.string().min(1).optional(),
    logFile: z.string().min(1).optional(),
    forgeRuntimeSandboxMode: forgeRuntimeSandboxModeSchema.optional(),
    overlayRendererMode: overlayRendererModeSchema.optional(),
    overlay: overlaySchema.optional(),
    execution: executionSchema.optional(),
    blockedApps: z.array(z.string().trim().min(2).max(80)).max(100).optional(),
    notifications: z.object({ pushUrl: z.string().url().max(500).optional() }).strict().optional(),
    output: z.object({ verbosity: z.enum(["lean", "full"]).optional() }).strict().optional(),
    approvals: z.object({ chat: z.boolean().optional() }).strict().optional(),
    attention: z.object({ sound: z.boolean().optional(), soundIntervalMs: z.number().int().min(2_000).max(120_000).optional() }).strict().optional(),
    replay: z.object({ onTaskFinish: z.boolean().optional() }).strict().optional(),
    tools: z.object({ profile: z.enum(["desktop", "full"]).optional() }).strict().optional(),
    autoInstallDependencies: z.boolean().optional(),
    speech: speechSchema.optional(),
    // Accepted for old config files; it does nothing.
    optionalAdapters: z.unknown().optional(),
    // Accepted for old config files (removed phone approvals); it does nothing.
    phone: z.unknown().optional(),
    // Removed capability grants: only an empty array is accepted (checked in readConfigFile).
    grants: z.unknown().optional()
  })
  .strict();

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  configPath?: string;
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }

  return input;
}

function resolveLocalPath(input: string, homeDir: string): string {
  const expanded = expandHome(input, homeDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

/** Dead pre-P1 config surfaces: accepted for older files, stripped before strict parsing. */
const LEGACY_CONFIG_KEYS = ["runtimeActivityOverlay", "browserBridge", "controlRoom", "profile"] as const;

export const GRANTS_REMOVED_MESSAGE =
  "Capability grants were removed. Move the rule to policy.toml (see docs/04) or delete the grants key from config.json.";

async function readConfigFile(configPath: string): Promise<z.infer<typeof configFileSchema>> {
  try {
    const raw = stripBom(await readFile(configPath, "utf8"));
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const key of LEGACY_CONFIG_KEYS) delete (parsed as Record<string, unknown>)[key];
    }
    const file = configFileSchema.parse(parsed);
    if (file.grants !== undefined && !(Array.isArray(file.grants) && file.grants.length === 0)) {
      throw new Error(GRANTS_REMOVED_MESSAGE);
    }
    return file;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function loadAgentHostConfig(options: LoadConfigOptions = {}): Promise<AgentHostConfig> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const defaultAgentHostDir = path.join(homeDir, ".agenthost");
  const initialAgentHostDir = resolveLocalPath(env.AGENTHOST_HOME ?? defaultAgentHostDir, homeDir);
  const configPath = resolveLocalPath(options.configPath ?? env.AGENTHOST_CONFIG ?? path.join(initialAgentHostDir, "config.json"), homeDir);
  const fileConfig = await readConfigFile(configPath);

  const agentHostDir = resolveLocalPath(env.AGENTHOST_HOME ?? fileConfig.agentHostDir ?? initialAgentHostDir, homeDir);
  const forgeRuntimeSandboxMode = forgeRuntimeSandboxModeSchema.parse(
    (env.AGENTHOST_FORGE_RUNTIME_SANDBOX_MODE ?? fileConfig.forgeRuntimeSandboxMode ?? "auto") as ForgeRuntimeSandboxMode
  );
  const overlayRendererMode = overlayRendererModeSchema.parse(
    (env.AGENTHOST_OVERLAY_MODE ?? fileConfig.overlay?.rendererMode ?? fileConfig.overlayRendererMode ?? "auto") as OverlayRendererMode
  );
  // In dock layout nothing floats over the work area by default (see workWindowCaptureClean in server.ts).
  const dockLayout = (fileConfig.overlay?.layout ?? "dock") !== "ambient";
  const overlay: OverlayPublicConfig = {
    rendererMode: overlayRendererMode,
    mode: fileConfig.overlay?.mode ?? "always",
    theme: fileConfig.overlay?.theme ?? "system",
    density: fileConfig.overlay?.density ?? "normal",
    reducedMotion: fileConfig.overlay?.reducedMotion ?? false,
    persistent: fileConfig.overlay?.persistent ?? true,
    autoHideMs: fileConfig.overlay?.autoHideMs ?? (fileConfig.overlay?.persistent === false ? 15_000 : 0),
    preferredPosition: fileConfig.overlay?.preferredPosition ?? "top_right",
    maxWidth: fileConfig.overlay?.maxWidth ?? 520,
    multiMonitor: fileConfig.overlay?.multiMonitor ?? "primary",
    layout: fileConfig.overlay?.layout ?? "dock",
    dockSide: fileConfig.overlay?.dockSide ?? "right",
    dockWidthPercent: fileConfig.overlay?.dockWidthPercent ?? 18,
    dockReserveSpace: fileConfig.overlay?.dockReserveSpace ?? true,
    windows: fileConfig.overlay?.windows ?? false,
    ...(fileConfig.overlay?.allowSyntheticControl === undefined ? {} : { allowSyntheticControl: fileConfig.overlay.allowSyntheticControl }),
    timeline: fileConfig.overlay?.timeline ?? true,
    frame: fileConfig.overlay?.frame ?? !dockLayout,
    ...(fileConfig.overlay?.frameIdleMs === undefined ? {} : { frameIdleMs: fileConfig.overlay.frameIdleMs }),
    actionPill: fileConfig.overlay?.actionPill ?? !dockLayout,
    targetRing: fileConfig.overlay?.targetRing ?? !dockLayout,
    targetRingLeadMs: fileConfig.overlay?.targetRingLeadMs ?? 150,
    targetRingDurationMs: fileConfig.overlay?.targetRingDurationMs ?? 600,
    pillAutoHideMs: fileConfig.overlay?.pillAutoHideMs ?? 30_000
  };
  const placement = z.enum(["foreground", "background"]).parse(env.AGENTHOST_EXECUTION_PLACEMENT ?? fileConfig.execution?.placement ?? "foreground");
  const execution = { placement, yieldToUser: fileConfig.execution?.yieldToUser ?? true, maxActionsPerTask: fileConfig.execution?.maxActionsPerTask ?? 500 };
  const speech = {
    enabled: fileConfig.speech?.enabled ?? true,
    providerPreference: fileConfig.speech?.providerPreference ?? ["espeak-ng", "piper", "speech-dispatcher"] as Array<"espeak-ng" | "piper" | "speech-dispatcher">,
    ...(fileConfig.speech?.defaultProvider === undefined ? {} : { defaultProvider: fileConfig.speech.defaultProvider }),
    artifactTtlMs: fileConfig.speech?.artifactTtlMs ?? 900_000,
    maxTextChars: fileConfig.speech?.maxTextChars ?? 4_000,
    maxDurationMs: fileConfig.speech?.maxDurationMs ?? 120_000,
    maxArtifactBytes: fileConfig.speech?.maxArtifactBytes ?? 20_000_000,
    synthesisTimeoutMs: fileConfig.speech?.synthesisTimeoutMs ?? 30_000,
    playbackTimeoutMs: fileConfig.speech?.playbackTimeoutMs ?? 300_000
  };
  const logFile = resolveLocalPath(
    env.AGENTHOST_LOG_FILE ?? fileConfig.logFile ?? path.join(agentHostDir, "logs", "agenthost.jsonl"),
    homeDir
  );

  return {
    schemaVersion: 1,
    agentHostDir,
    configPath,
    logFile,
    forgeRuntimeSandboxMode,
    overlayRendererMode,
    overlay,
    execution,
    blockedApps: fileConfig.blockedApps ?? [],
    ...(fileConfig.notifications?.pushUrl === undefined ? {} : { notifications: { pushUrl: fileConfig.notifications.pushUrl } }),
    ...(fileConfig.output?.verbosity === undefined ? {} : { output: { verbosity: fileConfig.output.verbosity } }),
    ...(fileConfig.approvals?.chat === undefined ? {} : { approvals: { chat: fileConfig.approvals.chat } }),
    ...(fileConfig.attention === undefined ? {} : { attention: {
      ...(fileConfig.attention.sound === undefined ? {} : { sound: fileConfig.attention.sound }),
      ...(fileConfig.attention.soundIntervalMs === undefined ? {} : { soundIntervalMs: fileConfig.attention.soundIntervalMs })
    } }),
    replay: { onTaskFinish: fileConfig.replay?.onTaskFinish ?? false },
    tools: { profile: z.enum(["desktop", "full"]).parse(env.AGENTHOST_TOOLS_PROFILE ?? fileConfig.tools?.profile ?? "desktop") },
    autoInstallDependencies: fileConfig.autoInstallDependencies ?? true,
    speech,
    policy: getDefaultPolicy()
  };
}
