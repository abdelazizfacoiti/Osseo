import { randomBytes } from "node:crypto";
import { toolFailure, toolSuccess, type OverlayTargetBinding, type ToolResult } from "@agenthost/core";
import { z } from "zod";
import type { AgentHostMcpContext } from "../context.js";
import { resolveLabelTarget } from "../label-target.js";
import { imagePointToScreen, recallScreen } from "../screenshot-registry.js";
import type { AgentHostToolDefinition, AnyAgentHostToolDefinition } from "../tool-runner.js";

/**
 * Guide mode: highlight boxes with a text label, drawn where the person should click. The agent
 * never clicks. Used for apps the agent must not drive, or when the person asks to be shown.
 */

type Bounds = { x: number; y: number; width: number; height: number };

const boundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(1),
  height: z.number().int().min(1)
}).strict();

const stepSchema = z.object({
  text: z.string().trim().min(1).max(200),
  bounds: boundsSchema.optional(),
  screenshotId: z.string().trim().min(1).max(120).optional(),
  imageX: z.number().min(0).optional(),
  imageY: z.number().min(0).optional(),
  imageWidth: z.number().positive().optional(),
  imageHeight: z.number().positive().optional(),
  label: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(100).optional()
}).strict().superRefine((step, ctx) => {
  const hasBounds = step.bounds !== undefined;
  const rect = [step.screenshotId, step.imageX, step.imageY, step.imageWidth, step.imageHeight];
  const hasShot = rect.some((value) => value !== undefined);
  const hasLabel = step.label !== undefined;
  if ([hasBounds, hasShot, hasLabel].filter(Boolean).length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give exactly one of: bounds; screenshotId with imageX, imageY, imageWidth, imageHeight; or label." });
    return;
  }
  if (hasShot && rect.some((value) => value === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A screenshot step needs screenshotId, imageX, imageY, imageWidth and imageHeight." });
  }
  if (step.role !== undefined && !hasLabel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "role goes with label." });
  }
});

const showInput = z.object({
  steps: z.array(stepSchema).min(1).max(8),
  windowId: z.string().trim().min(1).max(200).optional(),
  ttlSeconds: z.number().int().min(30).max(1800).optional()
}).strict();

const clearInput = z.object({}).strict();

type ShowInput = z.infer<typeof showInput>;
type Step = ShowInput["steps"][number];

/** The overlay manager keeps a primitive for at most this long, whatever ttl is asked for. */
const OVERLAY_MAX_TTL_MS = 300_000;
const DEFAULT_TTL_SECONDS = 600;

const shown = new WeakMap<AgentHostMcpContext, { ids: string[]; until: number }>();

/** True while a guide is on screen and not expired. Marks over a window corrupt window-only captures. */
export function guideActive(context: AgentHostMcpContext, now = Date.now()): boolean {
  const state = shown.get(context);
  return state !== undefined && state.ids.length > 0 && now < state.until;
}

/** Whether a window-only capture may skip card suppression: no AgentHost mark may sit over the work area. */
export function windowCaptureClean(context: AgentHostMcpContext): boolean {
  return context.workWindowCaptureClean === true && !guideActive(context);
}

async function clearGuide(context: AgentHostMcpContext): Promise<number> {
  const state = shown.get(context);
  shown.delete(context);
  if (state === undefined) return 0;
  let cleared = 0;
  for (const id of state.ids) {
    try {
      const result = await context.overlay?.dismiss(id);
      if (result === undefined || result.ok) cleared += 1;
    } catch {
      /* Dismissal is best effort. */
    }
  }
  return cleared;
}

type Placed = { ok: true; bounds: Bounds; source: "bounds" | "screenshot" | "label" } | { ok: false; code: string; message: string };

async function placeStep(context: AgentHostMcpContext, step: Step, windowId: string, activeWindow: { windowId?: string; title?: string; appName?: string; pid?: number }, index: number): Promise<Placed> {
  const which = `Step ${index + 1}`;
  if (step.bounds !== undefined) return { ok: true, bounds: { ...step.bounds }, source: "bounds" };
  if (step.screenshotId !== undefined) {
    const screen = recallScreen(step.screenshotId);
    if (screen === undefined) return { ok: false, code: "screenshot_unknown", message: `${which}: screenshot ${step.screenshotId} is unknown or expired. Take a new desktop.screenshot.` };
    const topLeft = imagePointToScreen(screen, step.imageX!, step.imageY!);
    // The far corner is the last pixel inside the rectangle.
    const bottomRight = imagePointToScreen(screen, Math.max(step.imageX!, step.imageX! + step.imageWidth! - 1), Math.max(step.imageY!, step.imageY! + step.imageHeight! - 1));
    if ("error" in topLeft || "error" in bottomRight) return { ok: false, code: "image_point_outside", message: `${which}: the rectangle is not inside the screenshot picture.` };
    return {
      ok: true,
      source: "screenshot",
      bounds: { x: topLeft.x, y: topLeft.y, width: Math.max(1, bottomRight.x - topLeft.x), height: Math.max(1, bottomRight.y - topLeft.y) }
    };
  }
  const resolved = await resolveLabelTarget(
    context,
    { ...activeWindow, windowId },
    { label: step.label!, ...(step.role === undefined ? {} : { role: step.role }) },
    { ocr: false }
  );
  if (!resolved.ok) {
    const code = resolved.code === "label_ambiguous" ? "label_ambiguous" : "label_not_found";
    return { ok: false, code, message: `${which}: ${resolved.message}` };
  }
  if (resolved.target.bounds === undefined) return { ok: false, code: "label_not_found", message: `${which}: "${step.label}" has no known box.` };
  return { ok: true, bounds: { ...resolved.target.bounds }, source: "label" };
}

export function createGuideTools(): AnyAgentHostToolDefinition<AgentHostMcpContext>[] {
  const show: AgentHostToolDefinition<ShowInput, unknown, AgentHostMcpContext> = {
    name: "guide.show",
    description: "Guide mode: draws a highlight box and a text label on each place the person should click. It never clicks; the person does. Use it when the person asks to be shown how, or when the app is sensitive or blocked for automation. Place each step by screen bounds, by a rectangle in a desktop.screenshot picture (screenshotId + imageX/imageY/imageWidth/imageHeight), or by the visible name of a control (label, optional role). Replaces any guide already shown. Screenshots taken by desktop.screenshot do not show the guide marks. Call guide.clear when done.",
    riskLevel: "low",
    inputSchema: showInput,
    mcpInputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              text: { type: "string", minLength: 1, maxLength: 200, description: "What the person should do here." },
              bounds: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } }, required: ["x", "y", "width", "height"], additionalProperties: false, description: "Screen rectangle." },
              screenshotId: { type: "string", description: "Id from desktop.screenshot; use with imageX, imageY, imageWidth, imageHeight." },
              imageX: { type: "number", minimum: 0 },
              imageY: { type: "number", minimum: 0 },
              imageWidth: { type: "number", exclusiveMinimum: 0 },
              imageHeight: { type: "number", exclusiveMinimum: 0 },
              label: { type: "string", description: "Visible name of a control in the window (accessibility tree only)." },
              role: { type: "string", description: "Optional role with label, for example push button." }
            },
            required: ["text"],
            additionalProperties: false
          }
        },
        windowId: { type: "string", description: "Window the steps belong to. Default: the active window." },
        ttlSeconds: { type: "integer", minimum: 30, maximum: 1800, description: "How long the marks stay. Default 600; the overlay keeps marks at most 300 seconds." }
      },
      required: ["steps"],
      additionalProperties: false
    },
    inputSummary: "Show a click guide",
    safety: { actionType: "inspect", getInput: () => ({}) },
    async handler(input: ShowInput, context): Promise<ToolResult<unknown>> {
      const fail = (code: string, message: string, observations: string[] = ["Nothing was shown."]) =>
        toolFailure({ tool: "guide.show", riskLevel: "low", strategy: "gui_control", error: { code, message }, observations });

      const overlay = context.overlay;
      if (overlay === undefined) return fail("overlay_unavailable", "The overlay is not running, so a guide cannot be drawn.", ["Tell the person the steps in text instead."]);

      const current = await context.linux.getActiveWindow().catch(() => undefined);
      const active = current?.activeWindow ?? {};
      const windowId = input.windowId ?? active.windowId;
      if (windowId === undefined) return fail("active_window_unavailable", "No active window, and no windowId was given.");

      const placed: Array<{ bounds: Bounds; source: "bounds" | "screenshot" | "label" }> = [];
      for (const [index, step] of input.steps.entries()) {
        const result = await placeStep(context, step, windowId, { ...active, windowId }, index);
        if (!result.ok) return fail(result.code, result.message);
        placed.push({ bounds: result.bounds, source: result.source });
      }

      const geometry = await context.linux.getScreenGeometry?.().catch(() => undefined);
      const screen = geometry?.supported === true ? geometry.bounds : undefined;
      for (const [index, item] of placed.entries()) {
        const b = item.bounds;
        const inside = screen !== undefined
          ? b.x >= screen.x && b.y >= screen.y && b.x + b.width <= screen.x + screen.width && b.y + b.height <= screen.y + screen.height
          : b.x >= 0 && b.y >= 0 && b.width >= 4 && b.height >= 4 && b.width <= 4000 && b.height <= 4000;
        if (!inside) return fail("bounds_off_screen", `Step ${index + 1}: the box ${b.x},${b.y} ${b.width}x${b.height} is not on the screen.`);
      }

      await clearGuide(context);

      const ttlMs = Math.min(OVERLAY_MAX_TTL_MS, (input.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000);
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const resolver = (binding: OverlayTargetBinding) => {
        if (binding.kind !== "window_region") return { ok: false, reason: "guide_target_kind" };
        return {
          ok: true,
          summary: {
            kind: binding.kind,
            targetId: `guide-${binding.windowId}-${binding.bounds.x}-${binding.bounds.y}`,
            windowId: binding.windowId,
            bounds: binding.bounds,
            sensitivity: "public" as const,
            validatedAt: new Date().toISOString(),
            expiresAt: binding.expiresAt
          }
        };
      };

      const run = randomBytes(4).toString("hex");
      const ids: string[] = [];
      const total = placed.length;
      let failures = 0;
      for (const [index, item] of placed.entries()) {
        const target: OverlayTargetBinding = { kind: "window_region", windowId, bounds: item.bounds, expiresAt };
        const boxId = `guide-${run}-${index}-box`;
        const tipId = `guide-${run}-${index}-tip`;
        const box = await overlay.showPrimitive({ overlayId: boxId, type: "highlight", target, style: { semantic: "info" }, sensitivity: "public", ttlMs }, resolver).catch(() => ({ ok: false, errors: ["threw"] }));
        if (box.ok) ids.push(boxId); else failures += 1;
        const tip = await overlay.showPrimitive({
          overlayId: tipId,
          type: "tooltip",
          target,
          label: total === 1 ? "Tip" : `Step ${index + 1} of ${total}`,
          text: input.steps[index]!.text,
          style: { semantic: "info" },
          sensitivity: "public",
          ttlMs
        }, resolver).catch(() => ({ ok: false, errors: ["threw"] }));
        if (tip.ok) ids.push(tipId); else failures += 1;
      }
      if (ids.length === 0) return fail("overlay_unavailable", "The overlay refused every mark.", ["Tell the person the steps in text instead."]);

      shown.set(context, { ids, until: Date.now() + ttlMs });
      return toolSuccess({
        tool: "guide.show",
        riskLevel: "low",
        strategy: "gui_control",
        data: {
          shown: total,
          steps: placed.map((item, index) => ({ index: index + 1, bounds: item.bounds, source: item.source })),
          expiresAt,
          ...(failures === 0 ? {} : { markFailures: failures })
        },
        observations: [
          `Showing ${total} step${total === 1 ? "" : "s"}. Nothing was clicked: the person must do the clicking.`,
          "Call guide.clear when the person is done."
        ]
      });
    }
  };

  const clear: AgentHostToolDefinition<z.infer<typeof clearInput>, unknown, AgentHostMcpContext> = {
    name: "guide.clear",
    description: "Removes every mark guide.show drew in this session. Succeeds with cleared 0 when nothing is shown. It never clicks.",
    riskLevel: "low",
    inputSchema: clearInput,
    mcpInputSchema: { type: "object", properties: {}, additionalProperties: false },
    inputSummary: "Clear the click guide",
    safety: { actionType: "inspect", getInput: () => ({}) },
    async handler(_input, context): Promise<ToolResult<unknown>> {
      const cleared = await clearGuide(context);
      return toolSuccess({ tool: "guide.clear", riskLevel: "low", strategy: "gui_control", data: { cleared }, observations: [cleared === 0 ? "No guide was shown." : `Removed ${cleared} marks.`] });
    }
  };

  return [show, clear];
}
