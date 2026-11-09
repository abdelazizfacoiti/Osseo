import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  evaluateSafety,
  normalizePathForPolicy,
  toolFailure,
  toolSuccess,
  type DesktopCapabilitiesResult,
  type DesktopClickResult,
  type DesktopPointerResult,
  type DesktopGetActiveWindowResult,
  type DesktopHotkeyResult,
  type DesktopScreenshotResult,
  type DesktopTypeTextResult,
  type DesktopWindowContext,
  type ToolResult
} from "@agenthost/core";
import { z } from "zod";
import { resolveLabelTarget, type LabelResolution, type LabelTarget } from "../label-target.js";
import { readFile as readEffectBytes, rm as removeEffectFile } from "node:fs/promises";
import { randomUUID as effectId } from "node:crypto";
import { join as joinEffectPath } from "node:path";
import { downscaleToJpeg, measureEffect, type EffectResult } from "@agenthost/os-linux";
import type { AgentHostMcpContext } from "../context.js";
import type { AgentHostToolDefinition, AnyAgentHostToolDefinition } from "../tool-runner.js";
import { createSafetyEvaluationContext } from "../grants.js";

const nonEmptyString = z.string().trim().min(1).max(1000);
const confirmationTokenSchema = z.string().trim().min(8).max(120).optional();
const executionMcpProperties = {
  dryRun: { type: "boolean" },
  confirmationToken: { type: "string", minLength: 8, maxLength: 120 }
};

const activeWindowSchema = z
  .object({
    windowId: z.string().trim().min(1).max(200).optional(),
    appName: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(500).optional(),
    pid: z.number().int().min(1).optional()
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.windowId === undefined && input.appName === undefined && input.title === undefined && input.pid === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Active-window context must include at least one of windowId, appName, title, or pid."
      });
    }
  });

const targetWindowSchema = activeWindowSchema;
type WindowSelector = z.infer<typeof activeWindowSchema>;
type GuiContextInput = { activeWindow?: WindowSelector | undefined; target?: WindowSelector | undefined };
const guiContextRefine = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => schema.superRefine((input, ctx) => {
  const value = input as { activeWindow?: unknown; target?: unknown };
  if (value.activeWindow === undefined && value.target === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide activeWindow for compatibility or target to focus and verify in one call." });
  }
});

const screenshotInputSchema = z
  .object({
    outputDir: nonEmptyString.optional(),
    inline: z.boolean().optional(),
    filename: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._-]+\.(?:png|jpg|jpeg)$/i).optional(),
    includeActiveWindowOnly: z.boolean().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().int().min(1).max(100).optional(),
    scale: z.number().min(0.1).max(1).optional(),
    region: z.object({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      width: z.number().int().min(1).max(10000),
      height: z.number().int().min(1).max(10000)
    }).strict().optional(),
    dryRun: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.region !== undefined && input.includeActiveWindowOnly === true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "region cannot be combined with includeActiveWindowOnly." });
    }
    const resolved = input.format ?? (/\.jpe?g$/i.test(input.filename ?? "") ? "jpeg" : "png");
    if (input.filename !== undefined) {
      const pngName = /\.png$/i.test(input.filename);
      if ((resolved === "png" && !pngName) || (resolved === "jpeg" && pngName)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "filename extension must match format." });
      }
    }
    if (input.quality !== undefined && resolved !== "jpeg") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "quality is only supported for jpeg." });
    }
  });

const hotkeyInputSchema = guiContextRefine(z
  .object({
    keys: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
    repeat: z.number().int().min(1).max(50).optional(),
    verify: z.boolean().optional(),
    activeWindow: activeWindowSchema.optional(),
    target: targetWindowSchema.optional(),
    dryRun: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema
  }).strict());

const typeTextInputSchema = guiContextRefine(z
  .object({
    text: z.string().min(1).max(10_000),
    verify: z.boolean().optional(),
    activeWindow: activeWindowSchema.optional(),
    target: targetWindowSchema.optional(),
    dataSensitivity: z.enum(["none", "low", "sensitive", "secret"]).optional(),
    dryRun: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema
  }).strict());

const clickInputSchema = guiContextRefine(z
  .object({
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    label: z.string().trim().min(1).max(200).optional(),
    role: z.string().trim().min(1).max(80).optional(),
    button: z.enum(["left", "middle", "right"]).optional(),
    verify: z.boolean().optional(),
    activeWindow: activeWindowSchema.optional(),
    target: targetWindowSchema.optional(),
    dryRun: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema
  }).strict()).superRefine((input, ctx) => {
    const hasPoint = input.x !== undefined || input.y !== undefined;
    if (hasPoint && (input.x === undefined || input.y === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass both x and y." });
    }
    if (hasPoint === (input.label !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass either x and y, or label." });
    }
    if (input.role !== undefined && input.label === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "role only narrows a label; pass label too." });
    }
  });

type ClickPoint = { x: number; y: number };
/** Where a label-addressed action will land, resolved after the active window is validated. */
type PointLocator = (activeWindow: DesktopWindowContext) => Promise<
  | { ok: true; point: ClickPoint; data: Record<string, unknown> }
  | { ok: false; code: string; message: string; data: Record<string, unknown> }
>;

const POINTER_ACTIONS = ["move_mouse", "scroll", "double_click", "right_click", "drag"] as const;

const pointerInputSchema = guiContextRefine(z.object({
  action: z.enum(POINTER_ACTIONS).optional(),
  x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(), amount: z.number().int().min(1).max(20).optional(),
  startX: z.number().int().min(0).optional(), startY: z.number().int().min(0).optional(), endX: z.number().int().min(0).optional(), endY: z.number().int().min(0).optional(), durationMs: z.number().int().min(0).max(2000).optional(),
  activeWindow: activeWindowSchema.optional(), target: targetWindowSchema.optional(), dryRun: z.boolean().optional(), confirmationToken: confirmationTokenSchema
}).strict());

type ScreenshotInput = z.infer<typeof screenshotInputSchema>;
type HotkeyInput = z.infer<typeof hotkeyInputSchema>;
type TypeTextInput = z.infer<typeof typeTextInputSchema>;
type ClickInput = z.infer<typeof clickInputSchema>;
type PointerInput = z.infer<typeof pointerInputSchema>;

// Explicit action wins; otherwise drag endpoints imply drag, a direction implies
// scroll (at x,y when given), and bare coordinates move the pointer.
function pointerActionFor(input: PointerInput): (typeof POINTER_ACTIONS)[number] {
  if (input.action !== undefined) return input.action;
  if (input.startX !== undefined || input.endX !== undefined) return "drag";
  if (input.direction !== undefined) return "scroll";
  return "move_mouse";
}

const activeWindowMcpSchema = {
  type: "object",
  properties: {
    windowId: { type: "string", minLength: 1, maxLength: 200 },
    appName: { type: "string", minLength: 1, maxLength: 200 },
    title: { type: "string", minLength: 1, maxLength: 500 },
    pid: { type: "integer", minimum: 1 }
  },
  additionalProperties: false
};

function screenshotFormat(input: ScreenshotInput): "png" | "jpeg" {
  if (input.format !== undefined) return input.format;
  return /\.jpe?g$/i.test(input.filename ?? "") ? "jpeg" : "png";
}

function screenshotPath(input: ScreenshotInput, context: AgentHostMcpContext): string {
  const outputDir =
    input.outputDir === undefined
      ? path.join(context.config.agentHostDir, "screenshots")
      : normalizePathForPolicy(input.outputDir, { agentHostDir: context.config.agentHostDir });
  const scope = input.includeActiveWindowOnly === true ? "window" : "screen";
  const extension = screenshotFormat(input) === "jpeg" ? "jpg" : "png";
  const filename = input.filename ?? `screenshot-${context.sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}-${scope}.${extension}`;
  return normalizePathForPolicy(path.join(outputDir, filename), { agentHostDir: context.config.agentHostDir });
}

async function imageSize(filePath: string): Promise<{ width: number; height: number } | undefined> {
  try {
    const raw = await readFile(filePath);
    if (raw.length >= 24 && raw.toString("ascii", 12, 16) === "IHDR") {
      return { width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) };
    }
    if (raw.length >= 4 && raw[0] === 0xff && raw[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < raw.length) {
        if (raw[offset] !== 0xff) return undefined;
        const marker = raw[offset + 1];
        const length = raw.readUInt16BE(offset + 2);
        if (marker !== undefined && marker >= 0xc0 && marker <= 0xc3) {
          return { height: raw.readUInt16BE(offset + 5), width: raw.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function activeWindowAppName(activeWindow: DesktopWindowContext): string | undefined {
  return activeWindow.appName;
}

function inputWindow(input: GuiContextInput): WindowSelector {
  return input.target ?? input.activeWindow!;
}

function plainWindowSelector(value: WindowSelector): { windowId?: string; appName?: string; title?: string; pid?: number } {
  return {
    ...(value.windowId === undefined ? {} : { windowId: value.windowId }),
    ...(value.appName === undefined ? {} : { appName: value.appName }),
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.pid === undefined ? {} : { pid: value.pid })
  };
}

function toActiveWindowContext(input: {
  windowId?: string | undefined;
  appName?: string | undefined;
  title?: string | undefined;
  pid?: number | undefined;
}): DesktopWindowContext {
  const activeWindow: DesktopWindowContext = {};

  if (input.windowId !== undefined) {
    activeWindow.windowId = /^0x[0-9a-fA-F]+$/.test(input.windowId.trim())
      ? String(parseInt(input.windowId.trim(), 16))
      : input.windowId;
  }

  if (input.appName !== undefined) {
    activeWindow.appName = input.appName;
  }

  if (input.title !== undefined) {
    activeWindow.title = input.title;
  }

  if (input.pid !== undefined) {
    activeWindow.pid = input.pid;
  }

  return activeWindow;
}

function matchesActiveWindow(expected: DesktopWindowContext, actual: DesktopWindowContext): boolean {
  if (expected.windowId !== undefined && expected.windowId !== actual.windowId) {
    return false;
  }

  if (expected.pid !== undefined && expected.pid !== actual.pid) {
    return false;
  }

  if (expected.appName !== undefined && expected.appName.toLowerCase() !== actual.appName?.toLowerCase()) {
    return false;
  }

  if (expected.title !== undefined && expected.title.toLowerCase() !== actual.title?.toLowerCase()) {
    return false;
  }

  return true;
}

function initialGuiSafety(
  tool: string,
  context: AgentHostMcpContext,
  actionType: "gui_click" | "gui_type",
  activeWindow: DesktopWindowContext,
  dataSensitivity?: "none" | "low" | "sensitive" | "secret"
) {
  return evaluateSafety(
    {
      tool,
      actionType,
      strategy: "gui_control",
      ...(dataSensitivity === undefined ? {} : { dataSensitivity }),
      ...(activeWindow.appName === undefined ? {} : { appName: activeWindow.appName })
    },
    context.policy,
    createSafetyEvaluationContext(context)
  );
}

async function validateActiveWindow(context: AgentHostMcpContext, expected: DesktopWindowContext): Promise<{
  supported: boolean;
  backend?: string;
  reason?: string;
  activeWindow?: DesktopWindowContext;
  matched?: boolean;
}> {
  const current = await context.linux.getActiveWindow();
  if (!current.supported || current.activeWindow === undefined) {
    return { supported: false, reason: "active_window_unavailable", backend: current.backend };
  }
  if (!matchesActiveWindow(expected, current.activeWindow)) {
    return { supported: true, backend: current.backend, reason: "active_window_mismatch", activeWindow: current.activeWindow, matched: false };
  }
  return { supported: true, backend: current.backend, activeWindow: current.activeWindow, matched: true };
}

async function resolveGuiWindow(context: AgentHostMcpContext, input: GuiContextInput): Promise<Awaited<ReturnType<typeof validateActiveWindow>>> {
  const requested = input.target ?? input.activeWindow!;
  if (input.target !== undefined) {
    const focused = await context.linux.focusWindow(plainWindowSelector(requested));
    if (focused.supported !== true || focused.focused !== true) {
      return { supported: focused.supported, backend: focused.backend, reason: "focus_failed", matched: false };
    }
  }
  return validateActiveWindow(context, toActiveWindowContext(plainWindowSelector(requested)));
}

function safetyFailure(tool: string, safety: ReturnType<typeof evaluateSafety>): ToolResult<never> {
  return toolFailure({
    tool,
    riskLevel: safety.riskLevel,
    approval: safety.approval,
    error: {
      code: safety.blocked ? "safety_blocked" : "approval_required",
      message: safety.blocked
        ? "Tool execution was blocked by the safety engine."
        : "Tool execution requires approval before it can run.",
      details: safety
    },
    observations: safety.reasons
  });
}

function failedDesktopAction<T>(
  tool: string,
  code: string,
  data: { supported: boolean; backend: string; reason: string }
): ToolResult<T> {
  const message = data.reason.trim().length > 0 ? data.reason : `${tool} did not complete.`;
  return toolFailure<T>({
    tool,
    riskLevel: "medium",
    strategy: "gui_control",
    error: {
      code,
      message,
      details: { backend: data.backend, supported: data.supported }
    },
    observations: [message]
  });
}

async function desktopPreview(
  tool: string,
  actionType: "gui_click" | "gui_type",
  input: GuiContextInput,
  context: AgentHostMcpContext,
  summary: (window: string, point?: ClickPoint) => string,
  target: (window: string, point?: ClickPoint) => string,
  data: Record<string, unknown>,
  dataSensitivity?: "none" | "low" | "sensitive" | "secret",
  locate?: PointLocator
) {
  const activeWindow = toActiveWindowContext(inputWindow(input));
  const validation = await resolveGuiWindow(context, input);
  const windowLabel = activeWindow.windowId ?? activeWindow.appName ?? activeWindow.title ?? String(activeWindow.pid ?? "unknown");
  if (!validation.supported || !validation.matched) {
    return {
      summary: summary(windowLabel),
      targetFingerprint: target(windowLabel),
      riskLevel: "medium" as const,
      approval: { required: false, status: "not_required" as const },
      blocked: true,
      reasons: [validation.reason ?? "active_window_mismatch"],
      data: { activeWindow: validation.activeWindow ?? null, requestedWindow: activeWindow, ...data }
    };
  }
  const located = locate === undefined ? undefined : await locate(validation.activeWindow!);
  if (located !== undefined && !located.ok) {
    return {
      summary: `Not clicked: ${located.message}`,
      targetFingerprint: `unresolved:${tool}:${windowLabel}`,
      riskLevel: "medium" as const,
      approval: { required: false, status: "not_required" as const },
      blocked: true,
      reasons: [located.message],
      blockedCode: located.code,
      data: { activeWindow: validation.activeWindow, ...data, ...located.data }
    };
  }
  const safety = initialGuiSafety(tool, context, actionType, validation.activeWindow!, dataSensitivity);
  return {
    summary: summary(windowLabel, located?.point),
    targetFingerprint: target(windowLabel, located?.point),
    riskLevel: safety.riskLevel,
    approval: safety.approval,
    blocked: safety.blocked,
    reasons: safety.reasons,
    requiresConfirmation: safety.grantDecision.requiresConfirmationToken
      || safety.riskLevel === "high"
      || safety.appSensitivity === "communication"
      || safety.appSensitivity === "financial",
    data: { activeWindow: validation.activeWindow, ...data, ...(located?.ok === true ? located.data : {}) }
  };
}

/** The active window as PNG bytes, with AgentHost's own cards hidden so they never count as a change. */
async function captureActiveWindow(context: AgentHostMcpContext): Promise<Buffer | undefined> {
  const file = joinEffectPath(context.config.agentHostDir, "screenshots", `settle-${effectId()}.png`);
  const run = async (): Promise<Buffer | undefined> => {
    try {
      const shot = await context.linux.screenshot({ path: file, includeActiveWindowOnly: true });
      return shot.supported === true ? await readEffectBytes(file) : undefined;
    } catch {
      return undefined;
    } finally {
      await removeEffectFile(file, { force: true }).catch(() => undefined);
    }
  };
  return context.overlayScreenshotSuppression === undefined ? run() : context.overlayScreenshotSuppression(run);
}

/** Runs an action and reports whether the window changed. Disabled callers get the action alone. */
async function verifiedAction<T>(context: AgentHostMcpContext, enabled: boolean, act: () => Promise<T>, options: { prepare?: () => Promise<unknown> } = {}): Promise<{ value: T; effect?: EffectResult }> {
  if (!enabled) return { value: await act() };
  const { value, effect } = await measureEffect({
    capture: () => captureActiveWindow(context),
    ...(options.prepare === undefined ? {} : { prepare: options.prepare })
  }, act);
  return { value, effect };
}

/** The observation for an action, saying plainly what the window did. */
function effectNote(base: string, effect: EffectResult | undefined): string {
  if (effect === undefined) return base;
  if (effect.screenChanged === true) return `${base} The window changed.`;
  if (effect.screenChanged === false) return `${base} No visible change in the window: the click may have missed, the control may be disabled, or the input was not accepted. Check before repeating.`;
  return `${base} The result could not be verified: the window was not captured.`;
}

/** Stops a label click before any input is sent; the carried result goes back to the caller. */
class LabelRefusal extends Error {
  readonly result: ToolResult<unknown>;
  constructor(result: ToolResult<unknown>) {
    super(String(result.error?.code ?? "label_refused"));
    this.result = result;
  }
}

function labelRefusal<T>(tool: string, resolution: Extract<LabelResolution, { ok: false }>): ToolResult<T> {
  return toolFailure<T>({
    tool,
    riskLevel: "medium",
    strategy: "gui_control",
    error: { code: resolution.code, message: resolution.message, details: { candidates: resolution.candidates } },
    observations: [resolution.message, "No click was performed."]
  });
}

async function locateClick(
  context: AgentHostMcpContext,
  input: { x?: number | undefined; y?: number | undefined; label?: string | undefined; role?: string | undefined },
  activeWindow: DesktopWindowContext
): Promise<{ ok: true; point: ClickPoint; resolved?: LabelTarget } | { ok: false; result: ToolResult<DesktopClickResult> }> {
  if (input.label !== undefined) {
    const resolution = await resolveLabelTarget(context, activeWindow, { label: input.label, ...(input.role === undefined ? {} : { role: input.role }) });
    if (!resolution.ok) return { ok: false, result: labelRefusal<DesktopClickResult>("desktop.click", resolution) };
    return { ok: true, point: resolution.target.point, resolved: resolution.target };
  }
  if (input.x !== undefined && input.y !== undefined) return { ok: true, point: { x: input.x, y: input.y } };
  return {
    ok: false,
    result: toolFailure<DesktopClickResult>({
      tool: "desktop.click",
      riskLevel: "medium",
      strategy: "gui_control",
      error: { code: "missing_target", message: "Pass x and y, or label." },
      observations: ["No click was performed."]
    })
  };
}

export function createDesktopTools(): AnyAgentHostToolDefinition<AgentHostMcpContext>[] {
  const screenshot: AgentHostToolDefinition<ScreenshotInput, DesktopScreenshotResult, AgentHostMcpContext> = {
    name: "desktop.screenshot",
    description: "Captures a PNG/JPEG screenshot to an approved local folder with optional region, scale, and JPEG quality. Use includeActiveWindowOnly or a region for faster OCR.",
    riskLevel: "medium",
    inputSchema: screenshotInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        inline: { type: "boolean", description: "Also return a downscaled JPEG in the reply, so no second call is needed to read the file. Default true when ffmpeg is installed." },
        outputDir: { type: "string" },
        filename: { type: "string", pattern: "^[A-Za-z0-9._-]+\\.(png|jpg|jpeg)$" },
        includeActiveWindowOnly: { type: "boolean" },
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "integer", minimum: 1, maximum: 100 },
        scale: { type: "number", minimum: 0.1, maximum: 1 },
        region: {
          type: "object",
          properties: {
            x: { type: "integer", minimum: 0 },
            y: { type: "integer", minimum: 0 },
            width: { type: "integer", minimum: 1, maximum: 10000 },
            height: { type: "integer", minimum: 1, maximum: 10000 }
          },
          required: ["x", "y", "width", "height"],
          additionalProperties: false
        },
        ...executionMcpProperties
      },
      additionalProperties: false
    },
    inputSummary: "Capture screenshot",
    safety: { actionType: "file_write" },
    preview: {
      isDryRun: (input) => input.dryRun === true,
      resolveEffect: (input, context) => {
        const outputPath = screenshotPath(input, context);
        const safety = evaluateSafety(
          { tool: "desktop.screenshot", actionType: "file_write", strategy: "gui_control", filePath: outputPath },
          context.policy,
          createSafetyEvaluationContext(context)
        );
        return {
          summary: `Capture screenshot to ${outputPath}`,
          targetFingerprint: outputPath,
          riskLevel: safety.riskLevel,
          approval: safety.approval,
          blocked: safety.blocked,
          reasons: safety.reasons,
          data: {
            path: outputPath,
            includeActiveWindowOnly: input.includeActiveWindowOnly ?? false,
            format: screenshotFormat(input),
            ...(input.region === undefined ? {} : { region: input.region }),
            ...(input.scale === undefined ? {} : { scale: input.scale }),
            ...(input.quality === undefined ? {} : { quality: input.quality })
          }
        };
      }
    },
    async handler(input, context): Promise<ToolResult<DesktopScreenshotResult>> {
      const outputPath = screenshotPath(input, context);
      const postResolutionSafety = evaluateSafety(
        {
          tool: "desktop.screenshot",
          actionType: "file_write",
          strategy: "gui_control",
          filePath: outputPath
        },
        context.policy,
        createSafetyEvaluationContext(context)
      );

      if (!postResolutionSafety.allowed) {
        return safetyFailure("desktop.screenshot", postResolutionSafety);
      }

      // Read the window origin before capturing so image pixels can be mapped back to screen coordinates.
      const windowOrigin = input.includeActiveWindowOnly === true
        ? (await context.linux.getActiveWindowBounds?.().catch(() => undefined))?.bounds
        : { x: 0, y: 0 };
      const capture = () => context.linux.screenshot({
        path: outputPath,
        ...(input.includeActiveWindowOnly === undefined ? {} : { includeActiveWindowOnly: input.includeActiveWindowOnly }),
        format: input.format ?? screenshotFormat(input),
        ...(input.quality === undefined ? {} : { quality: input.quality }),
        ...(input.scale === undefined ? {} : { scale: input.scale }),
        ...(input.region === undefined ? {} : { region: input.region })
      });
      const data = context.overlayScreenshotSuppression === undefined
        ? await capture()
        : await context.overlayScreenshotSuppression(capture);

      if (data.supported !== true || data.path === undefined || data.bytesWritten === undefined || data.bytesWritten <= 0) {
        return failedDesktopAction("desktop.screenshot", "screenshot_failed", data);
      }

      const size = await imageSize(outputPath);
      if (size !== undefined) {
        data.screenshotMetadata = {
          screenshotId: path.basename(outputPath),
          capturedAt: new Date().toISOString(),
          captureKind: input.includeActiveWindowOnly === true ? "active_window" : "full_screen",
          imageWidth: size.width,
          imageHeight: size.height,
          geometryAvailable: true,
          format: screenshotFormat(input),
          ...(input.scale === undefined ? {} : { scale: input.scale }),
          ...(input.region === undefined ? {} : { region: input.region }),
          ...(windowOrigin === undefined ? {} : {
            screenOrigin: { x: windowOrigin.x + (input.region?.x ?? 0), y: windowOrigin.y + (input.region?.y ?? 0) }
          })
        };
      }
      // Inline JPEG: the picture comes back in the reply, so no second call is needed to read the file.
      let inlineScale: number | undefined;
      if (input.inline !== false && size !== undefined) {
        const scratch = joinEffectPath(context.config.agentHostDir, "screenshots", `inline-${effectId()}.jpg`);
        try {
          if (await downscaleToJpeg(outputPath, scratch, 1280, { agentHostDir: context.config.agentHostDir })) {
            const small = await imageSize(scratch);
            if (small !== undefined) {
              inlineScale = small.width / size.width;
              const reply = data as DesktopScreenshotResult & { inlineImage?: { data: string; mimeType: string }; inline?: { width: number; height: number; scale: number } };
              reply.inlineImage = { data: (await readEffectBytes(scratch)).toString("base64"), mimeType: "image/jpeg" };
              reply.inline = { width: small.width, height: small.height, scale: inlineScale };
            }
          }
        } finally {
          await removeEffectFile(scratch, { force: true }).catch(() => undefined);
        }
      }
      const origin = data.screenshotMetadata?.screenOrigin;
      return toolSuccess({
        tool: "desktop.screenshot",
        riskLevel: "medium",
        strategy: "gui_control",
        data,
        observations: [
          "Saved a screenshot locally under an approved AgentHost folder.",
          ...(inlineScale === undefined ? [] : ["The picture is attached inline (JPEG). The coordinates below apply to that picture."]),
          ...(origin === undefined ? [] : [`To click a pixel in this image use screen x = ${origin.x} + imageX / ${inlineScale ?? input.scale ?? 1}, y = ${origin.y} + imageY / ${inlineScale ?? input.scale ?? 1}.`])
        ]
      });
    }
  };

  const hotkey: AgentHostToolDefinition<HotkeyInput, DesktopHotkeyResult, AgentHostMcpContext> = {
    name: "desktop.hotkey",
    description: "Sends a desktop hotkey when policy and active-window context allow it.",
    riskLevel: "medium",
    inputSchema: hotkeyInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        repeat: { type: "integer", minimum: 1, maximum: 50, description: "Times to send the chord, 20 ms apart." },
        verify: { type: "boolean", description: "Compare the window before and after the action and report effect.screenChanged. Default true; set false only for speed-critical repeats." },
        keys: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 100 },
          minItems: 1,
          maxItems: 10
        },
        activeWindow: activeWindowMcpSchema,
        target: activeWindowMcpSchema,
        ...executionMcpProperties
      },
        required: ["keys"],
      additionalProperties: false
    },
    inputSummary: "Send hotkey",
    auditInputSummary: (i) => `Send hotkey ${i.keys.join("+")} to ${activeWindowAppName(toActiveWindowContext(inputWindow(i))) ?? "active window"}.`,
    preview: {
      isDryRun: (i) => i.dryRun === true,
      resolveEffect: (i, context) => desktopPreview("desktop.hotkey", "gui_click", i, context, (window) => `Send hotkey ${i.keys.join("+")} to ${window}.`, (window) => `hotkey:${window}:${i.keys.join("+")}`, { keys: i.keys })
    },
    safety: {
      actionType: "inspect",
      getInput: (input) => {
        const appName = activeWindowAppName(toActiveWindowContext(inputWindow(input)));
        return appName === undefined ? {} : { appName };
      }
    },
    async handler(input, context): Promise<ToolResult<DesktopHotkeyResult>> {
      const validation = await resolveGuiWindow(context, input);

      if (!validation.supported || !validation.matched) {
        return toolFailure({
          tool: "desktop.hotkey",
          riskLevel: "medium",
          strategy: "gui_control",
          error: {
            code: "active_window_mismatch",
            message: validation.reason ?? "Active window validation failed."
          },
          observations: [validation.reason ?? "Active window validation failed."]
        });
      }

      const postResolutionSafety = evaluateSafety(
        {
          tool: "desktop.hotkey",
          actionType: "gui_click",
          strategy: "gui_control",
          ...(validation.activeWindow!.appName === undefined ? {} : { appName: validation.activeWindow!.appName })
        },
        context.policy,
        createSafetyEvaluationContext(context)
      );

      if (!postResolutionSafety.allowed) {
        return safetyFailure("desktop.hotkey", postResolutionSafety);
      }

      const { value: data, effect } = await verifiedAction(context, input.verify !== false, () => context.linux.hotkey({
        keys: input.keys,
        ...(input.repeat === undefined ? {} : { repeat: input.repeat }),
        activeWindow: validation.activeWindow!
      }));

      if (data.supported !== true || data.sent !== true) {
        return failedDesktopAction("desktop.hotkey", "hotkey_failed", data);
      }

      return toolSuccess({
        tool: "desktop.hotkey",
        riskLevel: "medium",
        strategy: "gui_control",
        data: { ...data, ...(effect === undefined ? {} : { effect }) },
        observations: [effectNote("Sent hotkey to active window.", effect)]
      });
    }
  };

  const typeText: AgentHostToolDefinition<TypeTextInput, DesktopTypeTextResult, AgentHostMcpContext> = {
    name: "desktop.type_text",
    description: "Types text into the active window when policy and active-window context allow it.",
    riskLevel: "medium",
    inputSchema: typeTextInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        verify: { type: "boolean", description: "Compare the window before and after the action and report effect.screenChanged. Default true; set false only for speed-critical repeats." },
        text: { type: "string", minLength: 1, maxLength: 10000 },
        activeWindow: activeWindowMcpSchema,
        target: activeWindowMcpSchema,
        dataSensitivity: { type: "string", enum: ["none", "low", "sensitive", "secret"] },
        ...executionMcpProperties
      },
        required: ["text"],
      additionalProperties: false
    },
    inputSummary: "Type text",
    auditInputSummary: (i) => `Type ${i.text.length} characters into ${activeWindowAppName(toActiveWindowContext(inputWindow(i))) ?? "active window"}.`,
    preview: {
      isDryRun: (i) => i.dryRun === true,
      resolveEffect: (i, context) => desktopPreview("desktop.type_text", "gui_type", i, context, (window) => `Type ${i.text.length} characters into ${window}.`, (window) => `type:${window}:${i.text.length}`, { textLength: i.text.length, dataSensitivity: i.dataSensitivity ?? "none" }, i.dataSensitivity)
    },
    safety: {
      actionType: "inspect",
      getInput: (input) => {
        const appName = activeWindowAppName(toActiveWindowContext(inputWindow(input)));
        return appName === undefined ? {} : { appName };
      }
    },
    async handler(input, context): Promise<ToolResult<DesktopTypeTextResult>> {
      const validation = await resolveGuiWindow(context, input);

      if (!validation.supported || !validation.matched) {
        return toolFailure({
          tool: "desktop.type_text",
          riskLevel: "medium",
          strategy: "gui_control",
          error: {
            code: "active_window_mismatch",
            message: validation.reason ?? "Active window validation failed."
          },
          observations: [validation.reason ?? "Active window validation failed."]
        });
      }

      const postResolutionSafety = evaluateSafety(
        {
          tool: "desktop.type_text",
          actionType: "gui_type",
          strategy: "gui_control",
          ...(input.dataSensitivity === undefined ? {} : { dataSensitivity: input.dataSensitivity }),
          ...(validation.activeWindow!.appName === undefined ? {} : { appName: validation.activeWindow!.appName })
        },
        context.policy,
        createSafetyEvaluationContext(context)
      );

      if (!postResolutionSafety.allowed) {
        return safetyFailure("desktop.type_text", postResolutionSafety);
      }

      const { value: data, effect } = await verifiedAction(context, input.verify !== false, () => context.linux.typeText({ text: input.text, activeWindow: validation.activeWindow! }));

      if (data.supported !== true || data.typed !== true) {
        return failedDesktopAction("desktop.type_text", "type_failed", data);
      }

      return toolSuccess({
        tool: "desktop.type_text",
        riskLevel: "medium",
        strategy: "gui_control",
        data: { ...data, ...(effect === undefined ? {} : { effect }) },
        observations: [effectNote("Typed text into active window.", effect)]
      });
    }
  };

  const click: AgentHostToolDefinition<ClickInput, DesktopClickResult, AgentHostMcpContext> = {
    name: "desktop.click",
    description: "Clicks at absolute screen coordinates (x, y), or on a visible control named by label inside the active window. A label is resolved through AT-SPI, then OCR, and the preview shows the resolved point; a confirmed click is refused if that point moved. Disabled and ambiguous controls are refused, never clicked.",
    riskLevel: "medium",
    inputSchema: clickInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        verify: { type: "boolean", description: "Compare the window before and after the action and report effect.screenChanged. Default true; set false only for speed-critical repeats." },
        x: { type: "integer", minimum: 0, description: "Use with y, instead of label." },
        y: { type: "integer", minimum: 0, description: "Use with x, instead of label." },
        label: { type: "string", minLength: 1, maxLength: 200, description: "Exact visible name of the control, such as 'Send' or 'Change label'. Instead of x and y." },
        role: { type: "string", minLength: 1, maxLength: 80, description: "Optional with label to pick one kind of control, such as 'push button', 'link' or 'entry'." },
        button: { type: "string", enum: ["left", "middle", "right"] },
        activeWindow: activeWindowMcpSchema,
        target: activeWindowMcpSchema,
        ...executionMcpProperties
      },
      additionalProperties: false
    },
    inputSummary: "Click at coordinates or on a label",
    auditInputSummary: (i) => `Click ${i.button ?? "left"} ${i.label === undefined ? `at (${i.x}, ${i.y})` : `on "${i.label}"`} in ${activeWindowAppName(toActiveWindowContext(inputWindow(i))) ?? "active window"}.`,
    preview: {
      isDryRun: (i) => i.dryRun === true,
      resolveEffect: (i, context) => {
        const button = i.button ?? "left";
        const locate: PointLocator | undefined = i.label === undefined ? undefined : async (activeWindow) => {
          const resolved = await resolveLabelTarget(context, activeWindow, { label: i.label!, ...(i.role === undefined ? {} : { role: i.role }) });
          return resolved.ok
            ? { ok: true, point: resolved.target.point, data: { resolved: { label: i.label, ...resolved.target } } }
            : { ok: false, code: resolved.code, message: resolved.message, data: { resolved: { label: i.label, code: resolved.code, candidates: resolved.candidates } } };
        };
        return desktopPreview(
          "desktop.click",
          "gui_click",
          i,
          context,
          (window, point) => {
            const at = point ?? (i.x === undefined || i.y === undefined ? undefined : { x: i.x, y: i.y });
            return at === undefined ? `Click ${button} on "${i.label}" in ${window}.` : `Click ${button} ${i.label === undefined ? "" : `on "${i.label}" `}at (${at.x}, ${at.y}) in ${window}.`;
          },
          (window, point) => `click:${window}:${point?.x ?? i.x}:${point?.y ?? i.y}:${button}`,
          i.label === undefined ? { x: i.x, y: i.y, button } : { label: i.label, button },
          undefined,
          locate
        );
      }
    },
    safety: {
      actionType: "inspect",
      getInput: (input) => {
        const appName = activeWindowAppName(toActiveWindowContext(inputWindow(input)));
        return appName === undefined ? {} : { appName };
      }
    },
    async handler(input, context): Promise<ToolResult<DesktopClickResult>> {
      const validation = await resolveGuiWindow(context, input);

      if (!validation.supported || !validation.matched) {
        return toolFailure({
          tool: "desktop.click",
          riskLevel: "medium",
          strategy: "gui_control",
          error: {
            code: "active_window_mismatch",
            message: validation.reason ?? "Active window validation failed."
          },
          observations: [validation.reason ?? "Active window validation failed."]
        });
      }

      const postResolutionSafety = evaluateSafety(
        {
          tool: "desktop.click",
          actionType: "gui_click",
          strategy: "gui_control",
          ...(validation.activeWindow!.appName === undefined ? {} : { appName: validation.activeWindow!.appName })
        },
        context.policy,
        createSafetyEvaluationContext(context)
      );

      if (!postResolutionSafety.allowed) {
        return safetyFailure("desktop.click", postResolutionSafety);
      }

      const located = await locateClick(context, input, validation.activeWindow!);
      if (!located.ok) return located.result;
      const { point, resolved } = located;

      // Hover first, so hover styling is in the baseline and a button that does
      // nothing reports no change instead of a false positive.
      let measured: Awaited<ReturnType<typeof verifiedAction<DesktopClickResult>>>;
      try {
        measured = await verifiedAction(context, input.verify !== false, async () => {
          let at = point;
          if (resolved !== undefined && input.label !== undefined) {
            // Re-resolve right before the click: the control may have moved while the baseline was taken.
            const again = await resolveLabelTarget(context, validation.activeWindow!, { label: input.label, ...(input.role === undefined ? {} : { role: input.role }) });
            if (!again.ok) throw new LabelRefusal(labelRefusal("desktop.click", again));
            if (again.target.point.x !== point.x || again.target.point.y !== point.y) {
              // An approved click must land where it was previewed; otherwise ask for a new preview.
              if (context.confirmationSatisfied === true) {
                throw new LabelRefusal(toolFailure({
                  tool: "desktop.click",
                  riskLevel: "medium",
                  strategy: "gui_control",
                  error: { code: "target_moved", message: `"${input.label}" moved after it was previewed, so the approved click was not performed. Preview again.` },
                  observations: ["No click was performed. The approved point no longer matches the control."]
                }));
              }
              at = again.target.point;
            }
          }
          return context.linux.click({
            x: at.x,
            y: at.y,
            button: input.button ?? "left",
            activeWindow: validation.activeWindow!
          });
        }, { prepare: async () => { await context.linux.pointer?.({ action: "move_mouse", x: point.x, y: point.y, activeWindow: validation.activeWindow! }); } });
      } catch (error) {
        if (error instanceof LabelRefusal) return error.result as ToolResult<DesktopClickResult>;
        throw error;
      }
      const { value: data, effect } = measured;

      if (data.supported !== true || data.clicked !== true) {
        return failedDesktopAction("desktop.click", "click_failed", data);
      }

      return toolSuccess({
        tool: "desktop.click",
        riskLevel: "medium",
        strategy: "gui_control",
        data: { ...data, ...(resolved === undefined ? {} : { resolved: { label: input.label, ...resolved } }), ...(effect === undefined ? {} : { effect }) },
        observations: [effectNote(resolved === undefined ? "Clicked at coordinates." : `Clicked "${resolved.name}" (${resolved.source === "accessibility" ? "accessibility name" : "OCR text"}).`, effect)]
      });
    }
  };

  const pointer: AgentHostToolDefinition<PointerInput, DesktopPointerResult, AgentHostMcpContext> = {
    name: "desktop.pointer",
    description: "Performs pointer actions when policy and active-window context allow it: move_mouse, scroll (direction + amount, at x,y when given), double_click and right_click (at x,y), drag (startX/startY to endX/endY). The action is inferred when omitted.",
    riskLevel: "medium",
    inputSchema: pointerInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...POINTER_ACTIONS] },
        x: { type: "integer", minimum: 0 },
        y: { type: "integer", minimum: 0 },
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 1, maximum: 20 },
        startX: { type: "integer", minimum: 0 },
        startY: { type: "integer", minimum: 0 },
        endX: { type: "integer", minimum: 0 },
        endY: { type: "integer", minimum: 0 },
        durationMs: { type: "integer", minimum: 0, maximum: 2000 },
        activeWindow: activeWindowMcpSchema,
        target: activeWindowMcpSchema,
        ...executionMcpProperties
      },
      required: [],
      additionalProperties: false
    },
    inputSummary: "Pointer action",
    auditInputSummary: (i) => `Pointer ${pointerActionFor(i)}${i.direction === undefined ? "" : ` ${i.direction}`} in ${activeWindowAppName(toActiveWindowContext(inputWindow(i))) ?? "active window"}.`,
    preview: {
      isDryRun: (i) => i.dryRun === true,
      resolveEffect: (i, context) => desktopPreview("desktop.pointer", "gui_click", i, context, (window) => `Pointer action in ${window}.`, (window) => `pointer:${window}:${pointerActionFor(i)}:${i.x ?? ""}:${i.y ?? ""}:${i.direction ?? ""}:${i.startX ?? ""}:${i.startY ?? ""}:${i.endX ?? ""}:${i.endY ?? ""}`, { action: pointerActionFor(i), x: i.x, y: i.y, direction: i.direction, amount: i.amount, startX: i.startX, startY: i.startY, endX: i.endX, endY: i.endY })
    },
    safety: {
      actionType: "inspect",
      getInput: (input) => {
        const appName = activeWindowAppName(toActiveWindowContext(inputWindow(input)));
        return appName === undefined ? {} : { appName };
      }
    },
    async handler(input, context): Promise<ToolResult<DesktopPointerResult>> {
      const validation = await resolveGuiWindow(context, input);

      if (!validation.supported || !validation.matched) {
        return toolFailure({
          tool: "desktop.pointer",
          riskLevel: "medium",
          strategy: "gui_control",
          error: {
            code: "active_window_mismatch",
            message: validation.reason ?? "Active window validation failed."
          },
          observations: [validation.reason ?? "Active window validation failed."]
        });
      }

      const postResolutionSafety = evaluateSafety(
        {
          tool: "desktop.pointer",
          actionType: "gui_click",
          strategy: "gui_control",
          ...(validation.activeWindow!.appName === undefined ? {} : { appName: validation.activeWindow!.appName })
        },
        context.policy,
        createSafetyEvaluationContext(context)
      );

      if (!postResolutionSafety.allowed) {
        return safetyFailure("desktop.pointer", postResolutionSafety);
      }

      const data = await context.linux.pointer!({
        action: pointerActionFor(input),
        activeWindow: validation.activeWindow!,
        ...(input.x === undefined ? {} : { x: input.x }),
        ...(input.y === undefined ? {} : { y: input.y }),
        ...(input.direction === undefined ? {} : { direction: input.direction }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.startX === undefined ? {} : { startX: input.startX }),
        ...(input.startY === undefined ? {} : { startY: input.startY }),
        ...(input.endX === undefined ? {} : { endX: input.endX }),
        ...(input.endY === undefined ? {} : { endY: input.endY }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
      });

      if (data.supported !== true || data.performed !== true) {
        return failedDesktopAction("desktop.pointer", "pointer_failed", data);
      }

      return toolSuccess({
        tool: "desktop.pointer",
        riskLevel: "medium",
        strategy: "gui_control",
        data,
        observations: ["Performed pointer action."]
      });
    }
  };

  return [screenshot, hotkey, typeText, click, pointer];
}
