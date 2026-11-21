import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { readRunState, toolFailure, toolSuccess, type OverlayTargetBinding, type RunStateSnapshot, type ToolResult } from "@osseo/core";
import { z } from "zod";
import type { OsseoMcpContext } from "../context.js";
import { inputGuardPath } from "../input-guard.js";
import { resolveLabelTarget } from "../label-target.js";
import { imagePointToScreen, recallScreen } from "../screenshot-registry.js";
import type { OsseoToolDefinition, AnyOsseoToolDefinition } from "../tool-runner.js";

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
  ttlSeconds: z.number().int().min(30).max(1800).optional(),
  waitForClick: z.boolean().optional(),
  waitSeconds: z.number().int().min(5).max(240).optional()
}).strict();

const clearInput = z.object({}).strict();

type ShowInput = z.infer<typeof showInput>;
type Step = ShowInput["steps"][number];

/** The overlay manager keeps a primitive for at most this long, whatever ttl is asked for. */
const OVERLAY_MAX_TTL_MS = 300_000;
const DEFAULT_TTL_SECONDS = 600;

type GuideState = { ids: string[]; until: number; stopWatch?: ReturnType<typeof setInterval> };
type GuideWait = { controller: AbortController; reason?: "cleared" | "stopped" };

const shown = new WeakMap<OsseoMcpContext, GuideState>();
const waits = new WeakMap<OsseoMcpContext, GuideWait>();

const STOP_POLL_MS = 1000;
const INJECTED_PRESS_WINDOW_MS = 1000;
const DEFAULT_WAIT_SECONDS = 120;

/** Test seam: how the stop flag is read. */
export const guideHooks: { readRunState: (osseoDir: string) => Promise<RunStateSnapshot> } = { readRunState };

async function stopRequested(context: OsseoMcpContext): Promise<boolean> {
  const dir = context.config?.osseoDir;
  if (dir === undefined) return false;
  try {
    return (await guideHooks.readRunState(dir)).stop.requested;
  } catch {
    return false;
  }
}

/** True while a guide is on screen and not expired. Marks over a window corrupt window-only captures. */
export function guideActive(context: OsseoMcpContext, now = Date.now()): boolean {
  const state = shown.get(context);
  return state !== undefined && state.ids.length > 0 && now < state.until;
}

/** Whether a window-only capture may skip card suppression: no Osseo mark may sit over the work area. */
export function windowCaptureClean(context: OsseoMcpContext): boolean {
  return (context.workWindowCaptureClean === true || context.captureCleanNow?.() === true) && !guideActive(context);
}

async function clearGuide(context: OsseoMcpContext, reason: "cleared" | "stopped" = "cleared"): Promise<number> {
  const state = shown.get(context);
  shown.delete(context);
  if (state?.stopWatch !== undefined) clearInterval(state.stopWatch);
  const wait = waits.get(context);
  if (wait !== undefined) {
    waits.delete(context);
    wait.reason = reason;
    wait.controller.abort();
  }
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

/** Whether an injected input marker was touched recently, so a press now is Osseo's own. */
async function recentInjectedInput(context: OsseoMcpContext): Promise<boolean> {
  const dir = context.config?.osseoDir;
  if (dir === undefined) return false;
  try {
    return Date.now() - (await stat(inputGuardPath(dir))).mtimeMs < INJECTED_PRESS_WINDOW_MS;
  } catch {
    return false;
  }
}

type Placed = { ok: true; bounds: Bounds; source: "bounds" | "screenshot" | "label" } | { ok: false; code: string; message: string };

async function placeStep(context: OsseoMcpContext, step: Step, windowId: string, activeWindow: { windowId?: string; title?: string; appName?: string; pid?: number }, index: number): Promise<Placed> {
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

type PressOutcome =
  | { kind: "clicked"; index: number; x: number; y: number }
  | { kind: "timeout" | "unavailable" | "cleared" | "stopped" };

async function waitForPress(context: OsseoMcpContext, regions: Bounds[], timeoutMs: number, wait: GuideWait): Promise<PressOutcome> {
  const watch = context.linux.waitForPointerPress;
  if (watch === undefined) return { kind: "unavailable" };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: "timeout" };
    const result = await watch({ regions, timeoutMs: remaining, signal: wait.controller.signal }).catch(() => ({ pressed: false as const, reason: "unavailable" as const }));
    if (result.pressed) {
      if (await recentInjectedInput(context)) continue;
      return { kind: "clicked", index: result.index, x: result.x, y: result.y };
    }
    if (result.reason === "aborted") return { kind: wait.reason === "stopped" ? "stopped" : "cleared" };
    return { kind: result.reason === "timeout" ? "timeout" : "unavailable" };
  }
}

type TeachOutcome = PressOutcome | { kind: "done"; index: number };

const TEACH_POLL_MS = 80;

type TeachDraw = {
  state: GuideState;
  total: number;
  boxes: Bounds[];
  showBox: (index: number) => Promise<boolean>;
  showCard: (index: number) => Promise<boolean>;
  cardId: (index: number) => string;
  boxId: (index: number) => string;
};

/**
 * Teach loop: one card (Back, Next or Done) beside the current step's box. Presses reach this process as
 * overlay events from the card's own poll (the renderer accepts them only from a real pointer, never within
 * 1 s of an agent input). A press inside a box also moves on. The loop ends at Done, at the last box press,
 * on timeout, on guide.clear and on Stop.
 */
async function teachLoop(context: OsseoMcpContext, draw: TeachDraw, wait: GuideWait, timeoutMs: number): Promise<TeachOutcome> {
  const overlay = context.overlay!;
  const deadline = Date.now() + timeoutMs;
  let current = 0;
  const forget = async (id: string) => {
    const at = draw.state.ids.indexOf(id);
    if (at >= 0) draw.state.ids.splice(at, 1);
    await overlay.dismiss(id).catch(() => undefined);
  };
  const goTo = async (next: number) => {
    await forget(draw.cardId(current));
    current = next;
    // Re-draw the new step's box, then its card.
    await forget(draw.boxId(current));
    await draw.showBox(current);
    await draw.showCard(current);
    // guide.clear or Stop may have landed while redrawing: take the new marks down again.
    if (wait.controller.signal.aborted) for (const id of [draw.boxId(current), draw.cardId(current)]) await forget(id);
  };
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: "timeout" };
    const inner: GuideWait = { controller: new AbortController() };
    const onAbort = () => { if (wait.reason !== undefined) inner.reason = wait.reason; inner.controller.abort(); };
    if (wait.controller.signal.aborted) onAbort(); else wait.controller.signal.addEventListener("abort", onAbort, { once: true });
    let nav: "next" | "back" | undefined;
    let busy = false;
    const watchedCard = draw.cardId(current);
    const poll = setInterval(() => {
      if (busy || nav !== undefined || inner.controller.signal.aborted) return;
      busy = true;
      // Only this card's events: pollEvents(overlayId) leaves every other overlay's events alone.
      void overlay.pollEvents(watchedCard).then((events) => {
        const hit = events.find((event) => event.overlayId === watchedCard && (event.event === "next" || event.event === "back"));
        if (hit !== undefined && nav === undefined) {
          nav = hit.event as "next" | "back";
          inner.controller.abort();
        }
      }).catch(() => undefined).finally(() => { busy = false; });
    }, TEACH_POLL_MS);
    let outcome: PressOutcome;
    try {
      outcome = await waitForPress(context, draw.boxes, remaining, inner);
      if (outcome.kind === "unavailable" && nav === undefined) {
        // No pointer watcher: the card buttons still work. Wait for one of them, the clock or an abort.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
          timer.unref();
          const finish = () => { clearTimeout(timer); resolve(); };
          if (inner.controller.signal.aborted) finish(); else inner.controller.signal.addEventListener("abort", finish, { once: true });
        });
        outcome = { kind: "timeout" };
      }
    } finally {
      clearInterval(poll);
      wait.controller.signal.removeEventListener("abort", onAbort);
    }
    if (wait.controller.signal.aborted) return { kind: wait.reason === "stopped" ? "stopped" : "cleared" };
    if (nav === "next") {
      if (current >= draw.total - 1) return { kind: "done", index: current };
      await goTo(current + 1);
      continue;
    }
    if (nav === "back") {
      if (current > 0) await goTo(current - 1);
      continue;
    }
    if (outcome.kind === "clicked") {
      if (outcome.index >= draw.total - 1) return outcome;
      await goTo(outcome.index + 1);
      continue;
    }
    return outcome;
  }
}

export function createGuideTools(): AnyOsseoToolDefinition<OsseoMcpContext>[] {
  const show: OsseoToolDefinition<ShowInput, unknown, OsseoMcpContext> = {
    name: "guide.show",
    description: "Guide mode: draws a highlight box and a text label on each place the person should click. It never clicks; the person does. Use it when the person asks to be shown how, or when the app is sensitive or blocked for automation. Place each step by screen bounds, by a rectangle in a desktop.screenshot picture (screenshotId + imageX/imageY/imageWidth/imageHeight), or by the visible name of a control (label, optional role). Replaces any guide already shown. Screenshots taken by desktop.screenshot do not show the guide marks. For a step-by-step guide, show one step at a time with waitForClick: true. The call then waits until the person clicks inside the box and returns which step was clicked, so you stay in the same turn: wait about a second, take a new desktop.screenshot, and call guide.show again for the next place. Do not end your turn between steps. With several steps and waitForClick the person gets a Teach card (Step n of m, Back, Next/Done) beside the box and the call runs the whole walkthrough, ending at Done, at a click in the last box, on timeout, or on guide.clear; the result then has finished: true. If the wait times out, ask the person. Call guide.clear when done.",
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
        ttlSeconds: { type: "integer", minimum: 30, maximum: 1800, description: "How long the marks stay. Default 600; the overlay keeps marks at most 300 seconds." },
        waitForClick: { type: "boolean", description: "Block until the person clicks inside any box, then clear the marks and return which step was clicked. Default false." },
        waitSeconds: { type: "integer", minimum: 5, maximum: 240, description: "With waitForClick: how long to wait. Default 120." }
      },
      required: ["steps"],
      additionalProperties: false
    },
    inputSummary: "Show a click guide",
    safety: { actionType: "inspect", getInput: () => ({}) },
    async handler(input: ShowInput, context): Promise<ToolResult<unknown>> {
      const fail = (code: string, message: string, observations: string[] = ["Nothing was shown."]) =>
        toolFailure({ tool: "guide.show", riskLevel: "low", strategy: "gui_control", error: { code, message }, observations });

      if (await stopRequested(context)) return fail("emergency_stop_requested", "The person pressed Stop, so no guide is shown.", ["Nothing was shown. Do not act until the person says so."]);

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
      // Teach mode: with waitForClick and a renderer that can draw widgets, one card with Back/Next/Done
      // replaces the tooltips. Without waitForClick the guide is exactly the plain one.
      let teach = input.waitForClick === true && typeof overlay.showWidget === "function" && typeof overlay.pollEvents === "function";
      const targetFor = (index: number): OverlayTargetBinding => ({ kind: "window_region", windowId, bounds: placed[index]!.bounds, expiresAt });
      const boxId = (index: number) => `guide-${run}-${index}-box`;
      const cardId = (index: number) => `guide-${run}-${index}-card`;
      const showBox = async (index: number) => {
        const result = await overlay.showPrimitive({ overlayId: boxId(index), type: "highlight", target: targetFor(index), style: { semantic: "info" }, sensitivity: "public", ttlMs }, resolver).catch(() => ({ ok: false, errors: ["threw"] }));
        if (result.ok && !ids.includes(boxId(index))) ids.push(boxId(index));
        return result.ok;
      };
      const showCard = async (index: number) => {
        const events: Array<"back" | "next"> = index > 0 ? ["back", "next"] : ["next"];
        const result = await overlay.showWidget!({
          widgetId: cardId(index),
          title: `Step ${index + 1} of ${total}`,
          components: [
            { type: "text", text: input.steps[index]!.text },
            ...(index > 0 ? [{ type: "button" as const, label: "Back", event: "back" as const }] : []),
            // Done is the same pointer-only "next" event on the last step; the loop knows it is the last.
            { type: "button" as const, label: index === total - 1 ? "Done" : "Next", event: "next" as const }
          ],
          target: targetFor(index),
          placement: "top_right",
          style: { semantic: "info" },
          interaction: { interactive: true, focus: "never", dismissible: false, allowedEvents: events },
          sensitivity: "public",
          ttlMs
        }, resolver).catch(() => ({ ok: false, errors: ["threw"] }));
        if (result.ok && !ids.includes(cardId(index))) ids.push(cardId(index));
        return result.ok;
      };
      for (const index of placed.keys()) {
        if (!(await showBox(index))) failures += 1;
        if (teach) continue;
        const target = targetFor(index);
        const tipId = `guide-${run}-${index}-tip`;
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
      if (teach && !(await showCard(0))) {
        // No card could be drawn: fall back to the plain guide with tooltips.
        teach = false;
        for (const index of placed.keys()) {
          const tipId = `guide-${run}-${index}-tip`;
          const tip = await overlay.showPrimitive({ overlayId: tipId, type: "tooltip", target: targetFor(index), label: total === 1 ? "Tip" : `Step ${index + 1} of ${total}`, text: input.steps[index]!.text, style: { semantic: "info" }, sensitivity: "public", ttlMs }, resolver).catch(() => ({ ok: false, errors: ["threw"] }));
          if (tip.ok) ids.push(tipId); else failures += 1;
        }
      }
      if (ids.length === 0) return fail("overlay_unavailable", "The overlay refused every mark.", ["Tell the person the steps in text instead."]);

      const state: GuideState = { ids, until: Date.now() + ttlMs };
      // Stop removes the marks even while no tool call is running.
      state.stopWatch = setInterval(() => {
        void stopRequested(context).then((stopped) => { if (stopped && shown.get(context) === state) return clearGuide(context, "stopped"); return undefined; });
      }, STOP_POLL_MS);
      state.stopWatch.unref();
      shown.set(context, state);

      const base = {
        shown: total,
        steps: placed.map((item, index) => ({ index: index + 1, bounds: item.bounds, source: item.source })),
        expiresAt,
        ...(failures === 0 ? {} : { markFailures: failures })
      };
      if (input.waitForClick === true) {
        const wait: GuideWait = { controller: new AbortController() };
        waits.set(context, wait);
        const timeoutMs = (input.waitSeconds ?? DEFAULT_WAIT_SECONDS) * 1000;
        const boxes = placed.map((item) => item.bounds);
        const outcome: TeachOutcome = teach
          ? await teachLoop(context, { state, total, boxes, showBox, showCard, cardId, boxId }, wait, timeoutMs)
          : await waitForPress(context, boxes, timeoutMs, wait);
        if (waits.get(context) === wait) waits.delete(context);
        const done = (data: Record<string, unknown>, observations: string[]) => toolSuccess({ tool: "guide.show", riskLevel: "low", strategy: "gui_control", data: { ...base, ...data }, observations });
        if (outcome.kind === "done") {
          await clearGuide(context);
          return done({ clicked: { index: outcome.index + 1, via: "done" }, finished: true }, [
            "The person pressed Done on the last step. The marks are cleared.",
            "Tell the person in one line that the walkthrough is finished."
          ]);
        }
        if (outcome.kind === "clicked") {
          await clearGuide(context);
          return done({ clicked: { index: outcome.index + 1, x: outcome.x, y: outcome.y }, ...(teach && outcome.index === total - 1 ? { finished: true } : {}) }, [
            `The person clicked step ${outcome.index + 1}. The marks are cleared.`,
            "Wait about a second for the app to react, take a new desktop.screenshot, then call guide.show with waitForClick: true for the next place.",
            "Do not end the turn between steps.",
            "When the task is finished, call guide.clear and tell the person in one line."
          ]);
        }
        if (outcome.kind === "stopped") return done({ clicked: null, stopped: true }, ["The person pressed Stop and the marks were removed. Do not show another guide and do not act until they say so."]);
        if (outcome.kind === "cleared") return done({ clicked: null, cleared: true }, ["The guide was cleared before the person clicked."]);
        if (outcome.kind === "unavailable") return done({ clicked: null, waitUnavailable: true }, ["Click detection is not available here. The marks stay up. Ask the person to say when they have clicked."]);
        return done({ clicked: null, waitTimedOut: true }, ["The person has not clicked yet. The marks stay up. Ask them whether to continue."]);
      }
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

  const clear: OsseoToolDefinition<z.infer<typeof clearInput>, unknown, OsseoMcpContext> = {
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
