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
  type DesktopFileDialogSelectResult,
  type DesktopSetFieldResult,
  type DesktopWindowContext,
  type DesktopWindowSummary,
  type ToolResult
} from "@agenthost/core";
import { z } from "zod";
import { resolveLabelTarget, type LabelResolution, type LabelTarget } from "../label-target.js";
import { imagePointToScreen, recallScreen, rememberScreen, sameBounds } from "../screenshot-registry.js";
import { readFile as readEffectBytes, rm as removeEffectFile } from "node:fs/promises";
import { createHash, randomUUID as effectId } from "node:crypto";
import { join as joinEffectPath } from "node:path";
import { downscaleToJpeg, measureEffect, type EffectResult } from "@agenthost/os-linux";
import type { AgentHostMcpContext } from "../context.js";
import type { AgentHostToolDefinition, AnyAgentHostToolDefinition, ToolPreviewEffect } from "../tool-runner.js";
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
    returnScreenshot: z.enum(["none", "region", "window"]).optional(),
    activeWindow: activeWindowSchema.optional(),
    target: targetWindowSchema.optional(),
    dryRun: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema
  }).strict());

const typeTextInputSchema = guiContextRefine(z
  .object({
    text: z.string().min(1).max(10_000),
    verify: z.boolean().optional(),
    returnScreenshot: z.enum(["none", "region", "window"]).optional(),
    activeWindow: activeWindowSchema.optional(),
    target: targetWindowSchema.optional(),
    dataSensitivity: z.enum(["none", "low", "sensitive", "secret"]).optional(),
    dryRun: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema
  }).strict());

/** A click names exactly one target: x and y, a label (with an optional role), or a point in a screenshot. */
function clickTargetRules(input: {
  x?: number | undefined; y?: number | undefined; label?: string | undefined; role?: string | undefined;
  screenshotId?: string | undefined; imageX?: number | undefined; imageY?: number | undefined;
}, ctx: z.RefinementCtx): void {
  const hasPoint = input.x !== undefined || input.y !== undefined;
  const hasShot = input.screenshotId !== undefined || input.imageX !== undefined || input.imageY !== undefined;
  if (hasPoint && (input.x === undefined || input.y === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass both x and y." });
  }
  if (hasShot && (input.screenshotId === undefined || input.imageX === undefined || input.imageY === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass screenshotId, imageX and imageY together." });
  }
  const modes = [hasPoint, input.label !== undefined, hasShot].filter(Boolean).length;
  if (modes !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass exactly one target: x and y, or label, or screenshotId with imageX and imageY." });
  }
  if (input.role !== undefined && input.label === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "role only narrows a label; pass label too." });
  }
}

const clickInputSchema = guiContextRefine(z
  .object({
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    label: z.string().trim().min(1).max(200).optional(),
    role: z.string().trim().min(1).max(80).optional(),
    screenshotId: z.string().trim().min(1).max(64).optional(),
    imageX: z.number().int().min(0).optional(),
    imageY: z.number().int().min(0).optional(),
    button: z.enum(["left", "middle", "right"]).optional(),
    verify: z.boolean().optional(),
    returnScreenshot: z.enum(["none", "region", "window"]).optional(),
    activeWindow: activeWindowSchema.optional(),
    target: targetWindowSchema.optional(),
    dryRun: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema
  }).strict()).superRefine(clickTargetRules);

type ClickPoint = { x: number; y: number };
/** Where a label-addressed action will land, resolved after the active window is validated. */
type PointLocator = (activeWindow: DesktopWindowContext) => Promise<
  | { ok: true; point: ClickPoint; data: Record<string, unknown> }
  | { ok: false; code: string; message: string; data: Record<string, unknown> }
>;

/** A target is either x and y, or a label (optionally with a role). Refused otherwise, before any action. */
function pointOrLabelRules(input: { x?: number | undefined; y?: number | undefined; label?: string | undefined; role?: string | undefined }, ctx: z.RefinementCtx): void {
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
}

const setFieldInputSchema = guiContextRefine(z
  .object({
    x: z.number().int().min(0).optional(),
    y: z.number().int().min(0).optional(),
    label: z.string().trim().min(1).max(200).optional(),
    role: z.string().trim().min(1).max(80).optional(),
    text: z.string().max(10_000),
    replace: z.boolean().optional(),
    returnScreenshot: z.enum(["none", "region", "window"]).optional(),
    activeWindow: activeWindowSchema.optional(),
    target: targetWindowSchema.optional(),
    dataSensitivity: z.enum(["none", "low", "sensitive", "secret"]).optional(),
    dryRun: z.boolean().optional(),
    confirmationToken: confirmationTokenSchema
  }).strict()).superRefine(pointOrLabelRules);

type SetFieldInput = z.infer<typeof setFieldInputSchema>;

/** The app scope for the focused-field read-back: its process when known, else its name. */
function fieldScope(window: DesktopWindowContext): { pid: number } | { appName: string } | undefined {
  if (window.pid !== undefined) return { pid: window.pid };
  if (window.appName !== undefined) return { appName: window.appName };
  return undefined;
}

/** Fingerprint of the text, so an approval binds the exact content without storing it. */
function fingerprintText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Compares read-back samples with the expected text. Stops at the first exact match. */
export function readbackVerdict(
  expected: string | undefined,
  samples: Array<{ readable: boolean; text?: string | undefined }>
): { confirmed: boolean | "unknown"; observedLength?: number } {
  if (expected === undefined) return { confirmed: "unknown" };
  let confirmed: boolean | "unknown" = "unknown";
  let observedLength: number | undefined;
  for (const sample of samples) {
    if (!sample.readable || sample.text === undefined) break;
    observedLength = sample.text.length;
    confirmed = sample.text === expected;
    if (confirmed) break;
  }
  return observedLength === undefined ? { confirmed: "unknown" } : { confirmed, observedLength };
}

/** Resolves a label inside the validated window, for previews of label-addressed actions. */
function labelLocator(context: AgentHostMcpContext, input: { label?: string | undefined; role?: string | undefined }): PointLocator | undefined {
  const label = input.label;
  if (label === undefined) return undefined;
  return async (activeWindow) => {
    const resolved = await resolveLabelTarget(context, activeWindow, { label, ...(input.role === undefined ? {} : { role: input.role }) });
    return resolved.ok
      ? { ok: true, point: resolved.target.point, data: { resolved: { label, ...resolved.target } } }
      : { ok: false, code: resolved.code, message: resolved.message, data: { resolved: { label, code: resolved.code, candidates: resolved.candidates } } };
  };
}

const fileDialogSelectInputSchema = z.object({
  path: z.string().trim().min(1).max(1000),
  windowId: z.string().trim().min(1).max(200).optional(),
  dialogTitle: z.string().trim().min(1).max(200).optional(),
  waitMs: z.number().int().min(500).max(15_000).optional(),
  dryRun: z.boolean().optional(),
  confirmationToken: confirmationTokenSchema
}).strict();

type FileDialogSelectInput = z.infer<typeof fileDialogSelectInputSchema>;

// Strict on purpose: "Open Gmail - Firefox" is a browser window, not a file dialog.
const FILE_DIALOG_TITLE = /^(open|save as|save|choose|select|upload)( (file|files|image|document))?$/i;

type FileDialogFound =
  | { ok: true; window: DesktopWindowSummary }
  | { ok: false; code: string; message: string; candidates: string[] };

/** The file dialog to act on: by windowId (preferred), by title text, or the only strict match. */
async function findFileDialog(context: AgentHostMcpContext, input: { windowId?: string | undefined; dialogTitle?: string | undefined }): Promise<FileDialogFound> {
  const listed = await context.linux.listWindows({ limit: 100, includeTitles: true }).catch(() => undefined);
  const windows = (listed?.windows ?? []).filter((item) => item.title === undefined || !item.title.startsWith("AgentHost "));
  if (input.windowId !== undefined) {
    const match = windows.find((item) => item.windowId === input.windowId);
    return match === undefined
      ? { ok: false, code: "dialog_not_found", message: `No open window has id ${input.windowId}.`, candidates: [] }
      : { ok: true, window: match };
  }
  const titled = windows.filter((item) => item.title !== undefined && (
    input.dialogTitle === undefined
      ? FILE_DIALOG_TITLE.test(item.title.trim())
      : item.title.toLowerCase().includes(input.dialogTitle.toLowerCase())
  ));
  if (titled.length === 0) {
    return { ok: false, code: "dialog_not_found", message: "No open file dialog was found. Open the dialog first, then pass its windowId (from window.list) or dialogTitle.", candidates: [] };
  }
  if (titled.length > 1) {
    return { ok: false, code: "dialog_ambiguous", message: "More than one file dialog matches. Pass windowId.", candidates: titled.map((item) => `${item.windowId}: ${item.title}`) };
  }
  return { ok: true, window: titled[0]! };
}

/** Whether the dialog would write a file (a Save dialog). Selecting a path there overwrites or creates one. */
function isSaveDialog(window: DesktopWindowSummary): boolean {
  return /\bsave\b/i.test(window.title ?? "");
}

function dialogContext(window: DesktopWindowSummary): DesktopWindowContext {
  return {
    windowId: window.windowId,
    ...(window.appName === undefined ? {} : { appName: window.appName }),
    ...(window.title === undefined ? {} : { title: window.title }),
    ...(window.pid === undefined ? {} : { pid: window.pid })
  };
}

/**
 * The picture after an action, inline, with an id a click can use directly. "window" is the active
 * window; "region" is a 480x320 area around the point the action used. Never fails the action: when
 * the picture cannot be made, the action's result still stands.
 */
export async function settledPicture(
  context: AgentHostMcpContext,
  mode: "window" | "region",
  point?: ClickPoint
): Promise<{ inlineImage: { data: string; mimeType: "image/jpeg" }; inline: { width: number; height: number; scale: number; screenshotId: string } } | undefined> {
  const region = mode === "region" && point !== undefined
    ? { x: Math.max(0, point.x - 240), y: Math.max(0, point.y - 160), width: 480, height: 320 }
    : undefined;
  const png = joinEffectPath(context.config.agentHostDir, "screenshots", `settled-${effectId()}.png`);
  const scratch = joinEffectPath(context.config.agentHostDir, "screenshots", `settled-${effectId()}.jpg`);
  try {
    // A window picture starts at the window's origin; a region is absolute on the screen.
    const origin = region === undefined
      ? (await context.linux.getActiveWindowBounds?.().catch(() => undefined))?.bounds
      : { x: region.x, y: region.y };
    const capture = () => context.linux.screenshot({
      path: png,
      format: "png",
      ...(region === undefined ? { includeActiveWindowOnly: true } : { region })
    });
    const data = context.overlayScreenshotSuppression === undefined ? await capture() : await context.overlayScreenshotSuppression(capture);
    if (data.supported !== true || data.path === undefined || origin === undefined) return undefined;
    const size = await imageSize(png);
    if (size === undefined) return undefined;
    if (!(await downscaleToJpeg(png, scratch, 1280, { agentHostDir: context.config.agentHostDir }))) return undefined;
    const small = await imageSize(scratch);
    if (small === undefined) return undefined;
    const active = await context.linux.getActiveWindow().catch(() => undefined);
    const windowId = active?.activeWindow?.windowId;
    const bounds = windowId === undefined ? undefined : (await context.linux.getActiveWindowBounds?.().catch(() => undefined))?.bounds;
    const inlineScale = small.width / size.width;
    const screenshotId = rememberScreen({
      origin: { x: origin.x, y: origin.y },
      pixelsPerPoint: inlineScale,
      imageWidth: small.width,
      imageHeight: small.height,
      ...(windowId === undefined || bounds === undefined ? {} : { reference: { windowId, bounds } })
    });
    return {
      inlineImage: { data: (await readEffectBytes(scratch)).toString("base64"), mimeType: "image/jpeg" },
      inline: { width: small.width, height: small.height, scale: inlineScale, screenshotId }
    };
  } catch {
    return undefined;
  } finally {
    await removeEffectFile(png, { force: true }).catch(() => undefined);
    await removeEffectFile(scratch, { force: true }).catch(() => undefined);
  }
}

const pauseFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Maps a point in a desktop.screenshot picture to the screen. Refuses an unknown, expired, or stale picture. */
async function resolveScreenshotPoint(
  context: AgentHostMcpContext,
  input: { screenshotId: string; imageX: number; imageY: number }
): Promise<{ ok: true; point: ClickPoint } | { ok: false; code: string; message: string }> {
  const screen = recallScreen(input.screenshotId);
  if (screen === undefined) {
    return { ok: false, code: "screenshot_unknown", message: "That screenshot id is unknown or has expired. Take a new desktop.screenshot and use its id." };
  }
  const mapped = imagePointToScreen(screen, input.imageX, input.imageY);
  if ("error" in mapped) {
    return { ok: false, code: "image_point_outside", message: `The point (${input.imageX}, ${input.imageY}) is outside the ${screen.imageWidth}x${screen.imageHeight} picture.` };
  }
  if (screen.reference !== undefined) {
    // The picture is only valid while its reference window is still active and still where it was.
    const current = await context.linux.getActiveWindow().catch(() => undefined);
    const now = await context.linux.getActiveWindowBounds?.().catch(() => undefined);
    const unchanged = current?.activeWindow?.windowId === screen.reference.windowId && sameBounds(now?.bounds, screen.reference.bounds);
    if (!unchanged) {
      return { ok: false, code: "screenshot_stale", message: "The window moved, resized, or closed after that screenshot, so its points no longer match the screen. Take a new desktop.screenshot." };
    }
  }
  return { ok: true, point: mapped };
}

/** The preview's locator for a screenshot target: the same mapping and stale check the click uses. */
function screenshotLocator(context: AgentHostMcpContext, input: { screenshotId: string; imageX?: number | undefined; imageY?: number | undefined }): PointLocator {
  return async () => {
    const { screenshotId, imageX, imageY } = input;
    if (imageX === undefined || imageY === undefined) {
      return { ok: false, code: "missing_target", message: "Pass screenshotId, imageX and imageY together.", data: {} };
    }
    const resolved = await resolveScreenshotPoint(context, { screenshotId, imageX, imageY });
    return resolved.ok
      ? { ok: true, point: resolved.point, data: { screenshot: { screenshotId, imageX, imageY, point: resolved.point } } }
      : { ok: false, code: resolved.code, message: resolved.message, data: { screenshot: { screenshotId, imageX, imageY, code: resolved.code } } };
  };
}

/** Turns a target (x and y, or a label) into a point. The failure result is typed for the calling tool. */
async function locateClick<T = DesktopClickResult>(
  context: AgentHostMcpContext,
  input: {
    x?: number | undefined; y?: number | undefined; label?: string | undefined; role?: string | undefined;
    screenshotId?: string | undefined; imageX?: number | undefined; imageY?: number | undefined;
  },
  activeWindow: DesktopWindowContext,
  tool = "desktop.click"
): Promise<{ ok: true; point: ClickPoint; resolved?: LabelTarget; screenshot?: { screenshotId: string; imageX: number; imageY: number } } | { ok: false; result: ToolResult<T> }> {
  if (input.screenshotId !== undefined && input.imageX !== undefined && input.imageY !== undefined) {
    const mapped = await resolveScreenshotPoint(context, { screenshotId: input.screenshotId, imageX: input.imageX, imageY: input.imageY });
    if (!mapped.ok) {
      return { ok: false, result: toolFailure<T>({ tool, riskLevel: "medium", strategy: "gui_control", error: { code: mapped.code, message: mapped.message }, observations: [mapped.message, "No action was performed."] }) };
    }
    return { ok: true, point: mapped.point, screenshot: { screenshotId: input.screenshotId, imageX: input.imageX, imageY: input.imageY } };
  }
  if (input.label !== undefined) {
    const resolution = await resolveLabelTarget(context, activeWindow, { label: input.label, ...(input.role === undefined ? {} : { role: input.role }) });
    if (!resolution.ok) return { ok: false, result: labelRefusal<T>(tool, resolution) };
    return { ok: true, point: resolution.target.point, resolved: resolution.target };
  }
  if (input.x !== undefined && input.y !== undefined) return { ok: true, point: { x: input.x, y: input.y } };
  return {
    ok: false,
    result: toolFailure<T>({
      tool,
      riskLevel: "medium",
      strategy: "gui_control",
      error: { code: "missing_target", message: "Pass x and y, or label." },
      observations: ["No action was performed."]
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
      // Remember the picture so a later click can name it by id and a point in it. The reference
      // window is the active one: if it moves or resizes, the id stops mapping to the screen.
      const origin = data.screenshotMetadata?.screenOrigin;
      if (size !== undefined && origin !== undefined && data.screenshotMetadata !== undefined) {
        const shown = (data as DesktopScreenshotResult & { inline?: { width: number; height: number; screenshotId?: string } }).inline;
        const captureScale = input.scale ?? 1;
        const active = await context.linux.getActiveWindow().catch(() => undefined);
        const windowId = active?.activeWindow?.windowId;
        // Same source as the picture origin: the active window's bounds right now.
        const bounds = windowId === undefined ? undefined : (await context.linux.getActiveWindowBounds?.().catch(() => undefined))?.bounds;
        const screenshotId = rememberScreen({
          origin,
          pixelsPerPoint: (shown === undefined ? 1 : shown.width / size.width) * captureScale,
          imageWidth: shown?.width ?? size.width,
          imageHeight: shown?.height ?? size.height,
          ...(windowId === undefined || bounds === undefined ? {} : { reference: { windowId, bounds } })
        });
        data.screenshotMetadata.screenshotId = screenshotId;
        if (shown !== undefined) shown.screenshotId = screenshotId;
      }
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
        returnScreenshot: { type: "string", enum: ["none", "region", "window"], description: "Picture after the action, inline: none (default), region (480x320 around the point) or window (the active window). Its screenshotId can be clicked directly." },
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

      const picture = input.returnScreenshot === undefined || input.returnScreenshot === "none" ? undefined : await settledPicture(context, input.returnScreenshot);
      return toolSuccess({
        tool: "desktop.hotkey",
        riskLevel: "medium",
        strategy: "gui_control",
        data: { ...data, ...(picture ?? {}), ...(effect === undefined ? {} : { effect }) },
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
        returnScreenshot: { type: "string", enum: ["none", "region", "window"], description: "Picture after the action, inline: none (default), region (480x320 around the point) or window (the active window). Its screenshotId can be clicked directly." },
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

      const picture = input.returnScreenshot === undefined || input.returnScreenshot === "none" ? undefined : await settledPicture(context, input.returnScreenshot);
      return toolSuccess({
        tool: "desktop.type_text",
        riskLevel: "medium",
        strategy: "gui_control",
        data: { ...data, ...(picture ?? {}), ...(effect === undefined ? {} : { effect }) },
        observations: [effectNote("Typed text into active window.", effect)]
      });
    }
  };

  const setField: AgentHostToolDefinition<SetFieldInput, DesktopSetFieldResult, AgentHostMcpContext> = {
    name: "desktop.set_field",
    description: "Sets a text field: focuses it (x and y, or a label), selects its text, pastes the new text, then reads the field back through AT-SPI. replace false appends at the end; empty text clears the field. confirmed is true only when the field reads back exactly, false is an error (readback_mismatch), and unknown means AT-SPI cannot read the field here. Refuses before typing when the click focuses no editable field, or when the field is a password.",
    riskLevel: "medium",
    inputSchema: setFieldInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: 0, description: "Use with y, instead of label." },
        y: { type: "integer", minimum: 0, description: "Use with x, instead of label." },
        label: { type: "string", minLength: 1, maxLength: 200, description: "Visible name of the field's control, instead of x and y." },
        role: { type: "string", minLength: 1, maxLength: 80, description: "Optional with label, such as 'entry' or 'text'." },
        text: { type: "string", maxLength: 10000, description: "The text to put in the field. Empty clears it." },
        replace: { type: "boolean", description: "Default true: replace the field's text. false appends at the end." },
        returnScreenshot: { type: "string", enum: ["none", "region", "window"], description: "Picture after the action, inline: none (default), region (480x320 around the point) or window (the active window). Its screenshotId can be clicked directly." },
        activeWindow: activeWindowMcpSchema,
        target: activeWindowMcpSchema,
        dataSensitivity: { type: "string", enum: ["none", "low", "sensitive", "secret"] },
        ...executionMcpProperties
      },
      required: ["text"],
      additionalProperties: false
    },
    inputSummary: "Set text field",
    auditInputSummary: (i) => `Set ${i.replace === false ? "appended" : "replaced"} text (${i.text.length} characters) ${i.label === undefined ? `at (${i.x}, ${i.y})` : `in "${i.label}"`} in ${activeWindowAppName(toActiveWindowContext(inputWindow(i))) ?? "active window"}.`,
    preview: {
      isDryRun: (i) => i.dryRun === true,
      resolveEffect: (i, context) => {
        const replace = i.replace !== false;
        const verb = i.text.length === 0 ? "Clear" : replace ? "Set" : "Append";
        return desktopPreview(
          "desktop.set_field",
          "gui_type",
          i,
          context,
          (window, point) => `${verb} ${i.text.length} characters ${i.label === undefined ? "" : `in "${i.label}" `}at ${point === undefined ? (i.x === undefined ? "the field" : `(${i.x}, ${i.y})`) : `(${point.x}, ${point.y})`} in ${window}.`,
          (window, point) => `setfield:${window}:${point?.x ?? i.x}:${point?.y ?? i.y}:${replace ? "replace" : "append"}:${fingerprintText(i.text)}`,
          { textLength: i.text.length, replace, ...(i.label === undefined ? { x: i.x, y: i.y } : { label: i.label }) },
          i.dataSensitivity,
          labelLocator(context, i)
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
    async handler(input, context): Promise<ToolResult<DesktopSetFieldResult>> {
      const tool = "desktop.set_field";
      const validation = await resolveGuiWindow(context, input);
      if (!validation.supported || !validation.matched) {
        return toolFailure({
          tool,
          riskLevel: "medium",
          strategy: "gui_control",
          error: { code: "active_window_mismatch", message: validation.reason ?? "Active window validation failed." },
          observations: [validation.reason ?? "Active window validation failed."]
        });
      }
      const window = validation.activeWindow!;

      const postResolutionSafety = evaluateSafety(
        {
          tool,
          actionType: "gui_type",
          strategy: "gui_control",
          ...(input.dataSensitivity === undefined ? {} : { dataSensitivity: input.dataSensitivity }),
          ...(window.appName === undefined ? {} : { appName: window.appName })
        },
        context.policy,
        createSafetyEvaluationContext(context)
      );
      if (!postResolutionSafety.allowed) return safetyFailure(tool, postResolutionSafety);

      const located = await locateClick<DesktopSetFieldResult>(context, input, window, tool);
      if (!located.ok) return located.result;
      const { point, resolved } = located;
      const replace = input.replace !== false;
      const scope = fieldScope(window);

      // Focus the field, then check the editable field at the clicked point before any text is typed.
      // Checking the point (not whatever has focus) keeps a stale focused field from passing.
      const focus = await context.linux.click({ x: point.x, y: point.y, button: "left", activeWindow: window });
      if (focus.supported !== true || focus.clicked !== true) return failedDesktopAction<DesktopSetFieldResult>(tool, "click_failed", focus);
      const pointRead = scope === undefined || context.linux.readTextAtPoint === undefined
        ? undefined
        : { ...scope, x: point.x, y: point.y };
      if (pointRead === undefined) {
        return toolFailure<DesktopSetFieldResult>({
          tool,
          riskLevel: "medium",
          strategy: "gui_control",
          error: { code: "accessibility_unavailable", message: "set_field needs AT-SPI to confirm the field, so nothing was typed. desktop.type_text enters text without a read-back." },
          observations: ["No text was typed."]
        });
      }
      let before: Awaited<ReturnType<NonNullable<typeof context.linux.readTextAtPoint>>> | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await pauseFor(attempt === 0 ? 150 : 250);
        before = await context.linux.readTextAtPoint!(pointRead);
        if (before.supported !== true || before.found !== true || before.focused === true) break;
      }
      if (before === undefined || before.supported !== true) {
        return toolFailure<DesktopSetFieldResult>({
          tool,
          riskLevel: "medium",
          strategy: "gui_control",
          error: { code: "accessibility_unavailable", message: `AT-SPI could not check the field: ${before?.reason ?? "no answer"}. Nothing was typed.` },
          observations: ["No text was typed."]
        });
      }
      if (before.found !== true) {
        return toolFailure<DesktopSetFieldResult>({
          tool,
          riskLevel: "medium",
          strategy: "gui_control",
          error: { code: "field_not_exposed", message: "No editable text field is exposed through AT-SPI at that point, so nothing was typed. Password and some custom fields are not exposed; use desktop.type_text only if you accept an unverified entry." },
          observations: ["No text was typed.", "Check the target with desktop.screenshot, or pass a label and role."]
        });
      }
      if (before.sensitive === true) {
        return toolFailure<DesktopSetFieldResult>({
          tool,
          riskLevel: "medium",
          strategy: "gui_control",
          error: { code: "sensitive_field", message: "The field is a password or hidden field, so nothing was typed. The operator must enter secrets." },
          observations: ["No text was typed."]
        });
      }
      if (before.focused !== true) {
        return toolFailure<DesktopSetFieldResult>({
          tool,
          riskLevel: "medium",
          strategy: "gui_control",
          error: { code: "field_not_focused", message: "The click did not focus the editable field, so nothing was typed." },
          observations: ["No text was typed.", "Check the target with desktop.screenshot, or pass a label and role."]
        });
      }
      const previous = typeof before.text === "string" ? before.text : undefined;

      // Replace selects everything first; append moves to the end so the read-back can be exact.
      const positioned = await context.linux.hotkey({ keys: replace ? ["ctrl", "a"] : ["ctrl", "End"], activeWindow: window });
      if (positioned.supported !== true || positioned.sent !== true) return failedDesktopAction(tool, "select_failed", positioned);

      let backend = focus.backend;
      if (input.text.length > 0) {
        const typed = await context.linux.typeText({ text: input.text, activeWindow: window });
        if (typed.supported !== true || typed.typed !== true) return failedDesktopAction(tool, "type_failed", typed);
        backend = typed.backend;
      } else if (replace) {
        const cleared = await context.linux.hotkey({ keys: ["BackSpace"], activeWindow: window });
        if (cleared.supported !== true || cleared.sent !== true) return failedDesktopAction(tool, "clear_failed", cleared);
      }

      // Read back from the same point: the field that was checked is the one that must hold the text.
      const expected = replace ? input.text : previous === undefined ? undefined : previous + input.text;
      const samples: Array<{ readable: boolean; text?: string | undefined }> = [];
      if (expected !== undefined) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          await pauseFor(attempt === 0 ? 200 : 250);
          const after = await context.linux.readTextAtPoint!(pointRead);
          const sample = after.supported === true && after.found === true && after.sensitive !== true && typeof after.text === "string"
            ? { readable: true, text: after.text }
            : { readable: false };
          samples.push(sample);
          if (!sample.readable || sample.text === expected) break;
        }
      }
      const verdict = readbackVerdict(expected, samples);
      const target = resolved === undefined ? {} : { resolved: { label: input.label, ...resolved } };

      if (verdict.confirmed === false) {
        return toolFailure<DesktopSetFieldResult>({
          tool,
          riskLevel: "medium",
          strategy: "gui_control",
          error: {
            code: "readback_mismatch",
            message: `The field holds ${verdict.observedLength ?? "an unknown number of"} characters, not the ${input.text.length} requested. Check the screen before retrying.`,
            details: { expectedCharacters: expected?.length ?? null, observedCharacters: verdict.observedLength ?? null, ...target }
          },
          observations: ["The text was typed, but the field does not show it.", "Check the target with desktop.screenshot before retrying."]
        });
      }

      const data: DesktopSetFieldResult = {
        supported: true,
        backend,
        set: true,
        confirmed: verdict.confirmed,
        replaced: replace,
        characterCount: input.text.length,
        ...(verdict.observedLength === undefined ? {} : { observedLength: verdict.observedLength }),
        activeWindow: window,
        reason: verdict.confirmed === true ? "The field reads back as expected." : "AT-SPI could not read the field back."
      };
      const picture = input.returnScreenshot === undefined || input.returnScreenshot === "none" ? undefined : await settledPicture(context, input.returnScreenshot, point);
      return toolSuccess({
        tool,
        riskLevel: "medium",
        strategy: "gui_control",
        data: { ...data, ...(picture ?? {}), ...target },
        observations: [
          verdict.confirmed === true
            ? `Set ${input.text.length} characters and read them back.`
            : "Typed, but AT-SPI cannot read this field back, so the result is unverified. Check it with desktop.screenshot or screen.read."
        ]
      });
    }
  };

  const fileDialogSelect: AgentHostToolDefinition<FileDialogSelectInput, DesktopFileDialogSelectResult, AgentHostMcpContext> = {
    name: "desktop.file_dialog_select",
    description: "Picks a file in an open file dialog: focuses the dialog (by windowId, or by dialogTitle when it is the only match), types the path into its location bar (ctrl+L, pasted), presses Return, and checks that the dialog closed. The path must pass the file read policy. Refuses Save dialogs (they would write a file) and nothing is typed when no single dialog matches.",
    riskLevel: "medium",
    inputSchema: fileDialogSelectInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 1000, description: "Absolute path of the file to pick." },
        windowId: { type: "string", minLength: 1, maxLength: 200, description: "The dialog's window id from window.list or a state result. Preferred." },
        dialogTitle: { type: "string", minLength: 1, maxLength: 200, description: "Title text that identifies the dialog, when windowId is not known." },
        waitMs: { type: "integer", minimum: 500, maximum: 15000, description: "How long to wait for the dialog to close. Default 5000." },
        ...executionMcpProperties
      },
      required: ["path"],
      additionalProperties: false
    },
    inputSummary: "Select file in dialog",
    auditInputSummary: (i) => `Select a file in a file dialog${i.windowId === undefined ? "" : ` (window ${i.windowId})`}; path omitted.`,
    preview: {
      isDryRun: (i) => i.dryRun === true,
      resolveEffect: async (i, context): Promise<ToolPreviewEffect> => {
        const fileName = path.basename(i.path);
        const policy = evaluateSafety(
          { tool: "desktop.file_dialog_select", actionType: "file_read", filePath: normalizePathForPolicy(i.path, { agentHostDir: context.config.agentHostDir }), strategy: "cli_or_script" },
          context.policy,
          createSafetyEvaluationContext(context)
        );
        const found = await findFileDialog(context, i);
        if (!found.ok) {
          return { summary: `Not selected: ${found.message}`, targetFingerprint: `filedialog:none:${fingerprintText(i.path)}`, riskLevel: "medium", approval: { required: false, status: "not_required" }, blocked: true, reasons: [found.message], blockedCode: found.code, data: { candidates: found.candidates } };
        }
        if (isSaveDialog(found.window)) {
          const message = "This is a Save dialog. Selecting a path there would write a file, so it is refused.";
          return { summary: `Not selected: ${message}`, targetFingerprint: `filedialog:save:${found.window.windowId}`, riskLevel: "medium", approval: { required: false, status: "not_required" }, blocked: true, reasons: [message], blockedCode: "save_dialog_refused" };
        }
        if (!policy.allowed) {
          return { summary: "Not selected: the path is blocked by the file policy.", targetFingerprint: `filedialog:blocked:${found.window.windowId}`, riskLevel: policy.riskLevel, approval: policy.approval, blocked: true, reasons: policy.reasons, blockedCode: "path_blocked" };
        }
        return {
          summary: `Select ${fileName} in the file dialog "${found.window.title ?? found.window.windowId}" (window ${found.window.windowId}).`,
          targetFingerprint: `filedialog:${found.window.windowId}:${fingerprintText(i.path)}`,
          riskLevel: policy.riskLevel,
          approval: policy.approval,
          requiresConfirmation: policy.approval.required === true || policy.riskLevel === "high",
          reasons: policy.reasons,
          data: { windowId: found.window.windowId, title: found.window.title ?? null, appName: found.window.appName ?? null }
        };
      }
    },
    safety: { actionType: "inspect", getInput: () => ({}) },
    async handler(input, context): Promise<ToolResult<DesktopFileDialogSelectResult>> {
      const tool = "desktop.file_dialog_select";
      const policy = evaluateSafety(
        { tool, actionType: "file_read", filePath: normalizePathForPolicy(input.path, { agentHostDir: context.config.agentHostDir }), strategy: "cli_or_script" },
        context.policy,
        createSafetyEvaluationContext(context)
      );
      if (!policy.allowed) return safetyFailure(tool, policy);

      const found = await findFileDialog(context, input);
      if (!found.ok) {
        return toolFailure({ tool, riskLevel: "medium", strategy: "gui_control", error: { code: found.code, message: found.message, details: { candidates: found.candidates } }, observations: [found.message, "No path was typed."] });
      }
      const dialog = found.window;
      if (isSaveDialog(dialog)) {
        return toolFailure({ tool, riskLevel: "medium", strategy: "gui_control", error: { code: "save_dialog_refused", message: "This is a Save dialog. Selecting a path there would write a file, so nothing was typed." }, observations: ["No path was typed."] });
      }
      const activeWindow = dialogContext(dialog);

      const focus = await context.linux.focusWindow({ windowId: dialog.windowId });
      if (focus.supported !== true || focus.focused !== true) {
        return toolFailure({ tool, riskLevel: "medium", strategy: "gui_control", error: { code: "dialog_focus_failed", message: "The dialog could not be focused, so no path was typed." }, observations: ["No path was typed."] });
      }
      const location = await context.linux.hotkey({ keys: ["ctrl", "l"], activeWindow });
      if (location.supported !== true || location.sent !== true) return failedDesktopAction(tool, "hotkey_failed", location);
      const typed = await context.linux.typeText({ text: input.path, activeWindow });
      if (typed.supported !== true || typed.typed !== true) return failedDesktopAction(tool, "type_failed", typed);
      const submitted = await context.linux.hotkey({ keys: ["Return"], activeWindow });
      if (submitted.supported !== true || submitted.sent !== true) return failedDesktopAction(tool, "submit_failed", submitted);

      // An accepted file closes the dialog. Poll for that instead of guessing a delay.
      const deadline = Date.now() + (input.waitMs ?? 5_000);
      let closed = false;
      while (Date.now() < deadline) {
        await pauseFor(250);
        const listed = await context.linux.listWindows({ limit: 100, includeTitles: true }).catch(() => undefined);
        if (listed !== undefined && !listed.windows.some((item) => item.windowId === dialog.windowId)) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        return toolFailure({
          tool,
          riskLevel: "medium",
          strategy: "gui_control",
          error: { code: "dialog_still_open", message: "The dialog is still open: the path may not exist, or the dialog wants another confirmation. Check the screen before retrying." },
          observations: ["The path was typed and submitted.", "Check the dialog with desktop.screenshot."]
        });
      }
      return toolSuccess({
        tool,
        riskLevel: "medium",
        strategy: "gui_control",
        data: { supported: true, backend: typed.backend, selected: true, closed: true, windowId: dialog.windowId, reason: "The dialog closed after the path was submitted." },
        observations: ["Selected the file and the dialog closed."]
      });
    }
  };

  const click: AgentHostToolDefinition<ClickInput, DesktopClickResult, AgentHostMcpContext> = {
    name: "desktop.click",
    description: "Clicks at absolute screen coordinates (x, y), at a point in a desktop.screenshot picture (screenshotId, imageX, imageY), or on a visible control named by label inside the active window. A label is resolved through AT-SPI, then OCR, and the preview shows the resolved point; a confirmed click is refused if that point moved. Disabled and ambiguous controls are refused, never clicked.",
    riskLevel: "medium",
    inputSchema: clickInputSchema,
    mcpInputSchema: {
      type: "object",
      properties: {
        verify: { type: "boolean", description: "Compare the window before and after the action and report effect.screenChanged. Default true; set false only for speed-critical repeats." },
        returnScreenshot: { type: "string", enum: ["none", "region", "window"], description: "Picture after the action, inline: none (default), region (480x320 around the point) or window (the active window). Its screenshotId can be clicked directly." },
        x: { type: "integer", minimum: 0, description: "Use with y, instead of label." },
        y: { type: "integer", minimum: 0, description: "Use with x, instead of label." },
        label: { type: "string", minLength: 1, maxLength: 200, description: "Exact visible name of the control, such as 'Send' or 'Change label'. Instead of x and y." },
        role: { type: "string", minLength: 1, maxLength: 80, description: "Optional with label to pick one kind of control, such as 'push button', 'link' or 'entry'." },
        screenshotId: { type: "string", minLength: 1, maxLength: 64, description: "Id from a desktop.screenshot. Use with imageX and imageY. Refused when the reference window moved or resized after that screenshot, or when the id expired (5 minutes)." },
        imageX: { type: "integer", minimum: 0, description: "x in the screenshot picture, with screenshotId." },
        imageY: { type: "integer", minimum: 0, description: "y in the screenshot picture, with screenshotId." },
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
        const locate: PointLocator | undefined = i.screenshotId !== undefined
          ? screenshotLocator(context, { screenshotId: i.screenshotId, imageX: i.imageX, imageY: i.imageY })
          : i.label === undefined ? undefined : async (activeWindow) => {
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
            const from = i.screenshotId === undefined ? "" : ` (screenshot ${i.screenshotId}, picture point ${i.imageX}, ${i.imageY})`;
            if (at === undefined) return i.label === undefined ? `Click ${button} in ${window}${from}.` : `Click ${button} on "${i.label}" in ${window}.`;
            return `Click ${button} ${i.label === undefined ? "" : `on "${i.label}" `}at (${at.x}, ${at.y})${from} in ${window}.`;
          },
          (window, point) => `click:${window}:${point?.x ?? i.x}:${point?.y ?? i.y}:${button}`,
          i.label !== undefined ? { label: i.label, button } : i.screenshotId !== undefined ? { screenshotId: i.screenshotId, imageX: i.imageX, imageY: i.imageY, button } : { x: i.x, y: i.y, button },
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
      const { point, resolved, screenshot } = located;

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

      const picture = input.returnScreenshot === undefined || input.returnScreenshot === "none" ? undefined : await settledPicture(context, input.returnScreenshot, point);
      return toolSuccess({
        tool: "desktop.click",
        riskLevel: "medium",
        strategy: "gui_control",
        data: {
          ...data,
          ...(picture ?? {}),
          ...(resolved === undefined ? {} : { resolved: { label: input.label, ...resolved } }),
          ...(screenshot === undefined ? {} : { screenshot: { ...screenshot, point } }),
          ...(effect === undefined ? {} : { effect })
        },
        observations: [effectNote(
          resolved !== undefined
            ? `Clicked "${resolved.name}" (${resolved.source === "accessibility" ? "accessibility name" : "OCR text"}).`
            : screenshot !== undefined ? "Clicked a point in the screenshot." : "Clicked at coordinates.",
          effect
        )]
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

  return [screenshot, hotkey, typeText, setField, fileDialogSelect, click, pointer];
}
