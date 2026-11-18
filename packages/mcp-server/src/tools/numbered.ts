import { HANDOFF_KINDS, toolFailure, toolSuccess, type ToolResult } from "@agenthost/core";
import { z } from "zod";
import type { AgentHostMcpContext } from "../context.js";
import { callGoverned } from "../nested.js";
import type { AgentHostToolDefinition, AnyAgentHostToolDefinition } from "../tool-runner.js";
import { recordNumbered } from "../journal.js";
import { observeStructure } from "../see-diff.js";
import { lookupTarget, viewForWindow, type SeenView, type TargetLookup, type ViewTarget } from "../view-registry.js";
import { browserIsTarget, currentWindowBounds } from "./see.js";

/**
 * The numbered actions. Each resolves a number from `see` (or plain coordinates) and calls an
 * existing tool through the governed runner. dryRun and confirmationToken go straight to that
 * nested call, so a confirmation_required result comes back intact (with the tool renamed) and the
 * caller repeats the same call with the token.
 */

const token = z.string().trim().min(8).max(120);
const exec = { dryRun: z.boolean().optional(), confirmationToken: token.optional() };
const execMcp = { dryRun: { type: "boolean" }, confirmationToken: { type: "string", minLength: 8, maxLength: 120 } };
const viewMcp = { view: { type: "string", description: "View id from see. Default: the newest view." }, n: { type: "integer", minimum: 1, description: "Number from see." } };
const SEE_AGAIN = "Call see again before using numbers: the screen may have changed.";

type Args = Record<string, unknown>;

function passArgs(input: { dryRun?: boolean | undefined; confirmationToken?: string | undefined }): Args {
  return {
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(input.confirmationToken === undefined ? {} : { confirmationToken: input.confirmationToken })
  };
}

function refuse(tool: string, lookup: Extract<TargetLookup, { ok: false }>): ToolResult {
  return toolFailure({ tool, riskLevel: "medium", error: { code: lookup.code, message: lookup.message }, observations: ["No action was executed.", lookup.message] });
}

function fail(tool: string, code: string, message: string): ToolResult {
  return toolFailure({ tool, riskLevel: "medium", error: { code, message }, observations: ["No action was executed.", message] });
}

/** The nested result under the new tool's name, with the "see again" note after a real change. */
function finish(tool: string, result: ToolResult, note: boolean): ToolResult {
  const renamed: ToolResult = { ...result, tool };
  if (note && result.ok && result.preview !== true) renamed.observations = [...result.observations, SEE_AGAIN];
  return renamed;
}

/** Which view an action was taken from: the one its number came from, or the active window's. */
type Basis = { view?: SeenView | undefined; windowId?: string | undefined };

/**
 * `finish`, plus the structure check for a successful state-changing action: what changed in the
 * window's controls, in words. When the outline cannot be compared the result says why
 * (`structure: "unavailable"`) and the pixel check from the nested tool stays as it was.
 * Only counts go to the audit (see `auditOutputSummary`); sentences and values never do.
 */
async function settle(tool: string, result: ToolResult, context: AgentHostMcpContext, basis: Basis, note = true): Promise<ToolResult> {
  const done = finish(tool, result, note);
  if (!result.ok || result.preview === true) return done;
  // Inside a plan the control list is compared once, after the last step, not after every step.
  if (context.planStep !== undefined && context.planStep.index < context.planStep.total - 1) {
    const early = result.data !== null && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : {};
    done.data = { ...early, structure: "skipped" };
    return done;
  }
  const view = basis.view ?? (basis.windowId === undefined ? undefined : viewForWindow(basis.windowId));
  const seen = await observeStructure(context, view, basis.windowId);
  const data = result.data !== null && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : {};
  if (seen.structure === "used") {
    done.data = { ...data, changes: seen.changes, changeCount: seen.changeCount, structure: "used" };
    // The pixel check is a secondary signal: do not let "no visible change" contradict controls that did change.
    if (seen.changeCount > 0) done.observations = done.observations.map((line) => line.replace(/ No visible change in the window:.*$/s, ""));
  } else {
    done.data = { ...data, changes: [], changeCount: 0, structure: "unavailable", structureReason: seen.reason };
    done.observations = [...done.observations, `The window's controls could not be compared (${seen.reason}); judged by pixels.`];
  }
  return done;
}

/** Audit line: the plain completion, plus the counts only. */
function auditCounts(tool: string) {
  return (result: ToolResult<unknown>): string => {
    if (!result.ok) return `${result.error?.code ?? "tool_failed"}`;
    const data = result.data as { structure?: unknown; changeCount?: unknown } | null;
    return data?.structure === "used" || data?.structure === "unavailable"
      ? `${tool} completed. structure: ${data.structure}, changeCount: ${typeof data.changeCount === "number" ? data.changeCount : 0}`
      : `${tool} completed.`;
  };
}

async function resolve(context: AgentHostMcpContext, input: { view?: string | undefined; n: number }): Promise<TargetLookup> {
  return lookupTarget(input, async (view) => view.windowKey === "browser" ? undefined : currentWindowBounds(context, view.windowKey));
}

function center(target: Extract<ViewTarget, { kind: "screen" }>): { x: number; y: number } {
  return { x: target.bounds.x + Math.floor(target.bounds.width / 2), y: target.bounds.y + Math.floor(target.bounds.height / 2) };
}

/** The window for a bare-coordinate or no-number action: the active one. */
async function activeWindowFor(context: AgentHostMcpContext): Promise<{ windowId?: string; appName?: string; title?: string; pid?: number } | undefined> {
  const active = (await context.linux.getActiveWindow().catch(() => undefined))?.activeWindow;
  if (active === undefined) return undefined;
  if (active.windowId !== undefined) return { windowId: active.windowId };
  if (active.pid !== undefined) return { pid: active.pid };
  if (active.appName !== undefined) return { appName: active.appName };
  return active.title === undefined ? undefined : { title: active.title };
}

function define<I extends { dryRun?: boolean | undefined; confirmationToken?: string | undefined }>(spec: {
  name: string;
  description: string;
  riskLevel: "low" | "medium";
  schema: z.ZodType<I>;
  properties: Record<string, unknown>;
  required?: string[];
  summary: string;
  handler: (input: I, context: AgentHostMcpContext) => Promise<ToolResult<unknown>>;
}): AnyAgentHostToolDefinition<AgentHostMcpContext> {
  const tool: AgentHostToolDefinition<I, unknown, AgentHostMcpContext> = {
    name: spec.name,
    description: spec.description,
    riskLevel: spec.riskLevel,
    inputSchema: spec.schema,
    mcpInputSchema: { type: "object", properties: { ...spec.properties, ...execMcp }, ...(spec.required === undefined ? {} : { required: spec.required }), additionalProperties: false },
    inputSummary: spec.summary,
    auditInputSummary: () => spec.summary,
    auditOutputSummary: auditCounts(spec.name),
    safety: { actionType: "inspect" },
    delegatesExecutionArgs: true,
    handler: async (input, context) => {
      const result = await spec.handler(input, context);
      try { await recordNumbered(context, spec.name, input as Record<string, unknown>, result); } catch { /* a journal failure never changes the result */ }
      return result;
    }
  };
  return tool as AnyAgentHostToolDefinition<AgentHostMcpContext>;
}

const clickInput = z.object({
  n: z.number().int().min(1).optional(),
  view: z.string().trim().min(1).max(64).optional(),
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  button: z.enum(["left", "middle", "right"]).optional(),
  double: z.boolean().optional(),
  ...exec
}).strict().superRefine((input, ctx) => {
  const point = input.x !== undefined || input.y !== undefined;
  if (point && (input.x === undefined || input.y === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass both x and y." });
  if (input.n === undefined && !point) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass n (from see) or x and y." });
  if (input.n !== undefined && point) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass n or x and y, not both." });
});

const typeInput = z.object({
  n: z.number().int().min(1).optional(),
  view: z.string().trim().min(1).max(64).optional(),
  text: z.string().max(10_000),
  clear: z.boolean().optional(),
  submit: z.boolean().optional(),
  ...exec
}).strict().superRefine((input, ctx) => {
  if (input.n === undefined && input.text.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "text is empty." });
});

const keyInput = z.object({
  keys: z.union([z.string().trim().min(1).max(100), z.array(z.string().trim().min(1).max(100)).min(1).max(10)]).optional(),
  sequence: z.array(z.string().trim().min(1).max(100)).min(1).max(80).optional(),
  repeat: z.number().int().min(1).max(50).optional(),
  ...exec
}).strict().superRefine((input, ctx) => {
  if ((input.keys === undefined) === (input.sequence === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass keys (one key or chord) or sequence (several in order)." });
});

const scrollInput = z.object({
  n: z.number().int().min(1).optional(),
  view: z.string().trim().min(1).max(64).optional(),
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  direction: z.enum(["up", "down", "left", "right"]),
  amount: z.number().int().min(1).max(20).optional(),
  ...exec
}).strict().superRefine((input, ctx) => {
  if ((input.x === undefined) !== (input.y === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass both x and y." });
  if (input.n !== undefined && input.x !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass n or x and y, not both." });
});

const dragInput = z.object({
  view: z.string().trim().min(1).max(64).optional(),
  fromN: z.number().int().min(1).optional(),
  fromX: z.number().int().min(0).optional(),
  fromY: z.number().int().min(0).optional(),
  toN: z.number().int().min(1).optional(),
  toX: z.number().int().min(0).optional(),
  toY: z.number().int().min(0).optional(),
  ...exec
}).strict().superRefine((input, ctx) => {
  const from = input.fromN !== undefined ? input.fromX === undefined && input.fromY === undefined : input.fromX !== undefined && input.fromY !== undefined;
  const to = input.toN !== undefined ? input.toX === undefined && input.toY === undefined : input.toX !== undefined && input.toY !== undefined;
  if (!from) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass fromN, or fromX and fromY." });
  if (!to) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass toN, or toX and toY." });
});

const openInput = z.object({
  app: z.string().trim().min(1).max(200).optional(),
  url: z.string().trim().min(1).max(4000).optional(),
  in: z.enum(["agent-browser", "my-browser"]).optional(),
  ...exec
}).strict().superRefine((input, ctx) => {
  if ((input.app === undefined) === (input.url === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass app or url, not both." });
  if (input.in !== undefined && input.url === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "in only applies to url." });
});

const windowsInput = z.object({ focus: z.string().trim().min(1).max(200).optional(), ...exec }).strict();

const waitInput = z.object({
  text: z.string().trim().min(1).max(500).optional(),
  window: z.string().trim().min(1).max(500).optional(),
  gone: z.string().trim().min(1).max(500).optional(),
  timeoutMs: z.number().int().min(200).max(30_000).optional(),
  ...exec
}).strict().superRefine((input, ctx) => {
  if ([input.text, input.window, input.gone].filter((value) => value !== undefined).length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Pass exactly one of text, window, gone." });
});

const askInput = z.object({ kind: z.enum(HANDOFF_KINDS), message: z.string().trim().min(1).max(300), ...exec }).strict();
const stepsInput = z.object({
  steps: z.array(z.object({ tool: z.string(), input: z.record(z.unknown()).optional(), expect: z.record(z.unknown()).optional() }).strict()).min(1).max(20),
  stopOnError: z.boolean().optional(),
  returnScreenshot: z.enum(["none", "region", "window"]).optional(),
  ...exec
}).strict();
const statusInput = z.object({ ...exec }).strict();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether text shows up as a window title or as a named element in the active window. */
async function textPresent(context: AgentHostMcpContext, text: string): Promise<boolean> {
  const needle = text.toLowerCase();
  const listed = await context.linux.listWindows({ limit: 100, includeTitles: true }).catch(() => undefined);
  if (listed?.windows.some((window) => (window.title ?? "").toLowerCase().includes(needle)) === true) return true;
  const active = (await context.linux.getActiveWindow().catch(() => undefined))?.activeWindow;
  if (active === undefined || (active.pid === undefined && active.appName === undefined)) return false;
  const found = await context.linux.findAccessibilityElement({ ...(active.pid !== undefined ? { pid: active.pid } : { appName: active.appName! }), query: text, limit: 1 }).catch(() => undefined);
  return found?.supported === true && found.candidates.length > 0;
}

export function createNumberedTools(): AnyAgentHostToolDefinition<AgentHostMcpContext>[] {
  const click = define({
    name: "click",
    description: "Clicks element n from see (or x,y). double and button right/middle are supported. Pass dryRun or confirmationToken as for any action.",
    riskLevel: "medium",
    schema: clickInput,
    properties: { ...viewMcp, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, button: { type: "string", enum: ["left", "middle", "right"] }, double: { type: "boolean" } },
    summary: "Click",
    async handler(input, context) {
      const pass = passArgs(input);
      const wantsRight = input.button === "right";
      if (input.n === undefined) {
        const window = await activeWindowFor(context);
        if (window === undefined) return fail("click", "active_window_unavailable", "No active window to click in.");
        const basis = { windowId: window.windowId };
        if (input.double === true || wantsRight) {
          return settle("click", await callGoverned(context, "desktop.pointer", { action: input.double === true ? "double_click" : "right_click", x: input.x, y: input.y, activeWindow: window, ...pass }), context, basis);
        }
        return settle("click", await callGoverned(context, "desktop.click", { x: input.x, y: input.y, ...(input.button === undefined ? {} : { button: input.button }), activeWindow: window, ...pass }), context, basis);
      }
      const found = await resolve(context, { view: input.view, n: input.n });
      if (!found.ok) return refuse("click", found);
      const target = found.target;
      // The view line's name goes to the safety decision only (not where the click lands).
      const targetName = target.name.trim().slice(0, 200);
      const named = targetName.length === 0 ? {} : { targetName };
      if (target.kind === "dom") {
        if (input.double === true || input.button === "right" || input.button === "middle") return fail("click", "unsupported_for_browser", "Browser elements take a plain click only.");
        return settle("click", await callGoverned(context, "browser.click", { ref: target.ref, ...named, ...pass }), context, { view: found.view });
      }
      const point = center(target);
      const window = { windowId: target.windowId };
      if (input.double === true || wantsRight) {
        return settle("click", await callGoverned(context, "desktop.pointer", { action: input.double === true ? "double_click" : "right_click", ...point, target: window, ...pass }), context, { view: found.view });
      }
      return settle("click", await callGoverned(context, "desktop.click", { ...point, ...named, ...(input.button === undefined ? {} : { button: input.button }), target: window, ...pass }), context, { view: found.view });
    }
  });

  const type = define({
    name: "type",
    description: "Types text into element n from see, replacing its text (clear: false appends) and reading it back. Without n, types into the focused control. submit presses Return after. Password and card fields are refused.",
    riskLevel: "medium",
    schema: typeInput,
    properties: { ...viewMcp, text: { type: "string", maxLength: 10000 }, clear: { type: "boolean" }, submit: { type: "boolean" } },
    required: ["text"],
    summary: "Type text",
    async handler(input, context) {
      const pass = passArgs(input);
      const preview = input.dryRun === true;
      const pressReturn = async (first: ToolResult, window: Args, basis: Basis): Promise<ToolResult> => {
        if (input.submit !== true || !first.ok || preview || first.preview === true) return settle("type", first, context, basis);
        const enter = await callGoverned(context, "desktop.hotkey", { keys: ["Return"], ...window });
        const settled = await settle("type", first, context, basis);
        if (!enter.ok) return { ...settled, observations: [...settled.observations.filter((line) => line !== SEE_AGAIN), `Typed, but pressing Return failed: ${enter.error?.code ?? "failed"}.`, SEE_AGAIN] };
        return settled;
      };
      if (input.n === undefined) {
        const window = await activeWindowFor(context);
        if (window === undefined) return fail("type", "active_window_unavailable", "No active window to type into.");
        const typed = await callGoverned(context, "desktop.type_text", { text: input.text, activeWindow: window, ...pass });
        return pressReturn(typed, { activeWindow: window }, { windowId: window.windowId });
      }
      const found = await resolve(context, { view: input.view, n: input.n });
      if (!found.ok) return refuse("type", found);
      const target = found.target;
      if (target.kind === "dom") {
        // browser.fill reads the value back; browser.type is needed to append or press Enter.
        if (input.submit === true || input.clear === false) {
          return settle("type", await callGoverned(context, "browser.type", { ref: target.ref, text: input.text, clear: input.clear !== false, ...(input.submit === true ? { submit: true } : {}), ...pass }), context, { view: found.view });
        }
        return settle("type", await callGoverned(context, "browser.fill", { fields: [{ ref: target.ref, text: input.text }], ...pass }), context, { view: found.view });
      }
      const point = center(target);
      const window = { target: { windowId: target.windowId } };
      const set = await callGoverned(context, "desktop.set_field", { ...point, text: input.text, replace: input.clear !== false, ...window, ...pass });
      return pressReturn(set, window, { view: found.view });
    }
  });

  const key = define({
    name: "key",
    description: "Presses a key or chord in the active window, for example [\"ctrl\",\"l\"] or \"Return\". repeat presses it several times. sequence presses several keys or chords in order in one action, much faster than one call each: [\"s\",\"x\",\"KP_5\",\"Return\"] or [\"ctrl+a\",\"Delete\"].",
    riskLevel: "medium",
    schema: keyInput,
    properties: { keys: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 }] }, sequence: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 80 }, repeat: { type: "integer", minimum: 1, maximum: 50 } },
    required: [],
    summary: "Press keys",
    async handler(input, context) {
      const window = await activeWindowFor(context);
      if (window === undefined) return fail("key", "active_window_unavailable", "No active window to send keys to.");
      return settle("key", await callGoverned(context, "desktop.hotkey", { ...(input.sequence !== undefined ? { sequence: input.sequence } : { keys: typeof input.keys === "string" ? [input.keys] : input.keys! }), ...(input.repeat === undefined ? {} : { repeat: input.repeat }), activeWindow: window, ...passArgs(input) }), context, { windowId: window.windowId });
    }
  });

  const scroll = define({
    name: "scroll",
    description: "Scrolls up, down, left or right over element n from see, over x,y, or at the pointer.",
    riskLevel: "medium",
    schema: scrollInput,
    properties: { ...viewMcp, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 20 } },
    required: ["direction"],
    summary: "Scroll",
    async handler(input, context) {
      const base: Args = { action: "scroll", direction: input.direction, ...(input.amount === undefined ? {} : { amount: input.amount }), ...passArgs(input) };
      if (input.n !== undefined) {
        const found = await resolve(context, { view: input.view, n: input.n });
        if (!found.ok) return refuse("scroll", found);
        if (found.target.kind === "dom") return fail("scroll", "unsupported_for_browser", "Scroll a browser page with key (page_down, space).");
        return settle("scroll", await callGoverned(context, "desktop.pointer", { ...base, ...center(found.target), target: { windowId: found.target.windowId } }), context, { view: found.view }, false);
      }
      const window = await activeWindowFor(context);
      if (window === undefined) return fail("scroll", "active_window_unavailable", "No active window to scroll.");
      return settle("scroll", await callGoverned(context, "desktop.pointer", { ...base, ...(input.x === undefined ? {} : { x: input.x, y: input.y }), activeWindow: window }), context, { windowId: window.windowId }, false);
    }
  });

  const drag = define({
    name: "drag",
    description: "Drags from element fromN (or fromX,fromY) to element toN (or toX,toY).",
    riskLevel: "medium",
    schema: dragInput,
    properties: { view: viewMcp.view, fromN: { type: "integer", minimum: 1 }, fromX: { type: "integer", minimum: 0 }, fromY: { type: "integer", minimum: 0 }, toN: { type: "integer", minimum: 1 }, toX: { type: "integer", minimum: 0 }, toY: { type: "integer", minimum: 0 } },
    summary: "Drag",
    async handler(input, context) {
      let windowId: string | undefined;
      let seenView: SeenView | undefined;
      const point = async (n: number | undefined, x: number | undefined, y: number | undefined): Promise<{ x: number; y: number } | ToolResult> => {
        if (n === undefined) return { x: x!, y: y! };
        const found = await resolve(context, { view: input.view, n });
        if (!found.ok) return refuse("drag", found);
        if (found.target.kind === "dom") return fail("drag", "unsupported_for_browser", "Browser elements cannot be dragged by number.");
        if (windowId !== undefined && windowId !== found.target.windowId) return fail("drag", "windows_differ", "Both ends of a drag must be in one window.");
        windowId = found.target.windowId;
        seenView = found.view;
        return center(found.target);
      };
      const from = await point(input.fromN, input.fromX, input.fromY);
      if ("ok" in from) return from;
      const to = await point(input.toN, input.toX, input.toY);
      if ("ok" in to) return to;
      const window = windowId !== undefined ? { target: { windowId } } : { activeWindow: await activeWindowFor(context) };
      if ("activeWindow" in window && window.activeWindow === undefined) return fail("drag", "active_window_unavailable", "No active window to drag in.");
      const activeId = "activeWindow" in window ? window.activeWindow?.windowId : undefined;
      return settle("drag", await callGoverned(context, "desktop.pointer", { action: "drag", startX: from.x, startY: from.y, endX: to.x, endY: to.y, ...window, ...passArgs(input) }), context, seenView !== undefined ? { view: seenView } : { windowId: activeId });
    }
  });

  const open = define({
    name: "open",
    description: "Opens an app by name, or a url. A url opens in the agent's own browser by default (see then gives exact element refs); in: \"my-browser\" opens it in the person's default browser.",
    riskLevel: "medium",
    schema: openInput,
    properties: { app: { type: "string" }, url: { type: "string" }, in: { type: "string", enum: ["agent-browser", "my-browser"] } },
    summary: "Open an app or page",
    async handler(input, context) {
      const pass = passArgs(input);
      if (input.app !== undefined) return finish("open", await callGoverned(context, "app.open", { appName: input.app, ...pass }), false);
      if (input.in === "my-browser") return finish("open", await callGoverned(context, "app.open_url", { url: input.url, ...pass }), false);
      // With no display the agent's browser can only run headless.
      const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
      return finish("open", await callGoverned(context, "browser.open", { url: input.url, ...(headless ? { headless: true } : {}), ...pass }), false);
    }
  });

  const windows = define({
    name: "windows",
    description: "Lists open windows (id, app, title), or focuses the window whose id is given in focus.",
    riskLevel: "low",
    schema: windowsInput,
    properties: { focus: { type: "string", description: "Window id to bring to the front." } },
    summary: "List or focus windows",
    async handler(input, context) {
      if (input.focus !== undefined) return finish("windows", await callGoverned(context, "window.focus", { windowId: input.focus, ...passArgs(input) }), true);
      return finish("windows", await callGoverned(context, "window.list", { includeTitles: true, limit: 100 }), false);
    }
  });

  const wait = define({
    name: "wait",
    description: "Waits until text appears (text), a window with that title appears (window), or text/a window goes away (gone). Not a sleep. timeoutMs default 10000.",
    riskLevel: "low",
    schema: waitInput,
    properties: { text: { type: "string" }, window: { type: "string" }, gone: { type: "string" }, timeoutMs: { type: "integer", minimum: 200, maximum: 30000 } },
    summary: "Wait for a condition",
    async handler(input, context) {
      const timeoutMs = input.timeoutMs ?? 10_000;
      const browserPage = await browserIsTarget(context);
      if (input.text !== undefined && browserPage) {
        return finish("wait", await callGoverned(context, "browser.wait_for", { text: input.text, timeoutMs }), false);
      }
      if (input.window !== undefined) {
        return finish("wait", await callGoverned(context, "computer.wait_for", { windowAppears: { title: input.window }, timeoutMs }), false);
      }
      const subject = input.text ?? input.gone!;
      const wantPresent = input.text !== undefined;
      const started = Date.now();
      for (;;) {
        const present = await textPresent(context, subject);
        if (present === wantPresent) {
          return toolSuccess({ tool: "wait", riskLevel: "low", data: { matched: true, elapsedMs: Date.now() - started }, observations: [`Condition met after ${Date.now() - started} ms.`] });
        }
        if (Date.now() - started >= timeoutMs) break;
        await sleep(400);
      }
      return toolFailure({ tool: "wait", riskLevel: "low", error: { code: "wait_timeout", message: "The condition did not hold before the timeout." }, observations: [`No match after ${Date.now() - started} ms.`] });
    }
  });

  const ask = define({
    name: "ask",
    description: "Hands a step to the person: login, mfa, captcha, payment or other. A card tells them what to do; screen reading and actions stop until they press Continue. Never type credentials yourself.",
    riskLevel: "medium",
    schema: askInput,
    properties: { kind: { type: "string", enum: [...HANDOFF_KINDS] }, message: { type: "string", maxLength: 300 } },
    required: ["kind", "message"],
    summary: "Ask the person to act",
    async handler(input, context) {
      return finish("ask", await callGoverned(context, "agent.request_handoff", { kind: input.kind, message: input.message, ...passArgs(input) }), false);
    }
  });

  const steps = define({
    name: "steps",
    description: "Runs up to 20 tool calls in order as one governed plan (same input as computer.run_steps). Step tools may be click, type, key and the other tools by name.",
    riskLevel: "medium",
    schema: stepsInput,
    properties: {
      steps: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { tool: { type: "string" }, input: { type: "object", additionalProperties: true }, expect: { type: "object", additionalProperties: true } }, required: ["tool"], additionalProperties: false } },
      stopOnError: { type: "boolean" },
      returnScreenshot: { type: "string", enum: ["none", "region", "window"] }
    },
    required: ["steps"],
    summary: "Run a plan",
    async handler(input, context) {
      const { dryRun, confirmationToken, ...plan } = input;
      return finish("steps", await callGoverned(context, "computer.run_steps", { ...plan, ...passArgs({ dryRun, confirmationToken }) }), false);
    }
  });

  const status = define({
    name: "status",
    description: "Reports whether the agent is stopped, paused or in a takeover, and the active task.",
    riskLevel: "low",
    schema: statusInput,
    properties: {},
    summary: "Read status",
    async handler(_input, context) {
      return finish("status", await callGoverned(context, "agent.status", {}), false);
    }
  });

  return [click, type, key, scroll, drag, open, windows, wait, ask, steps, status];
}
