import { evaluateSafety, classifyAppSensitivity, toolFailure, toolSuccess, type AccessibilityTreeNode, type ToolResult } from "@agenthost/core";
import type { BrowserElement } from "@agenthost/os-linux";
import { z } from "zod";
import type { AgentHostMcpContext } from "../context.js";
import { safetyContext } from "../context.js";
import { callGoverned } from "../nested.js";
import type { AgentHostToolDefinition, AnyAgentHostToolDefinition } from "../tool-runner.js";
import { rememberView, type Box, type SeenView, type ViewTarget } from "../view-registry.js";
import { drawMarks, MAX_MARKS, type PictureMark } from "./see-marks.js";
import { findScreenTextMatches } from "./vision.js";

/**
 * `see`: one numbered list of what can be acted on in a window. Sources, in order: the agent's own
 * browser page (DOM), the accessibility tree, OCR words, nothing. Each number maps to a stored
 * target in the view registry; click, type, scroll and drag take that number.
 */

const seeInput = z.object({
  window: z.string().trim().min(1).max(200).optional(),
  filter: z.string().trim().min(1).max(200).optional(),
  max: z.number().int().min(1).max(150).optional(),
  picture: z.enum(["auto", "none", "plain", "marked"]).optional()
}).strict();

type SeeInput = z.infer<typeof seeInput>;
type Source = "dom" | "accessibility" | "ocr" | "none";

interface Element {
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  enabled: boolean;
  blocked: boolean;
  /** Present for screen elements. */
  bounds?: Box;
  ref?: string;
}

interface SeenWindow {
  id: string;
  title: string;
  app: string;
  pid?: number;
  bounds?: Box;
  active: boolean;
}

const MAX_VALUE = 40;
const MAX_NAME = 60;
const SECRET_NAME = /pass(word|code|phrase)?\b|secret|token|api[ _-]?key|private key|\botp\b|one[- ]time|verification code|security code|card number|credit card|\bcvv\b|\bcvc\b|\bssn\b|\bpin\b|[A-Za-z0-9_-]{24,}/i;

const ROLE_LABEL: Record<string, string> = {
  "push button": "button",
  "toggle button": "toggle button",
  "password text": "password field",
  textbox: "entry",
  searchbox: "entry",
  checkbox: "check box",
  radio: "radio button",
  combobox: "combo box",
  menuitem: "menu item",
  tab: "tab"
};

/** Roles worth a line: the things a person would act on. */
const ACTIONABLE = new Set([
  "push button", "toggle button", "check box", "radio button", "entry", "text", "combo box", "menu item", "check menu item", "radio menu item",
  "link", "tab", "page tab", "list item", "spin button", "slider", "switch", "menu", "tree item", "password text"
]);
/** Roles that keep a line even without a name. */
const NAMELESS_OK = new Set(["entry", "text", "combo box", "spin button", "slider", "password text"]);
/** Roles whose current text is shown (cut to 40 characters). */
const VALUE_ROLES = new Set(["entry", "text", "spin button", "combo box"]);

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** One line per element. A blocked element never shows a value, and no name that looks secret. */
export function formatLine(n: number, element: Element): string {
  const role = roleLabel(element.role);
  if (element.blocked) {
    const name = element.name.length > 0 && !SECRET_NAME.test(element.name) ? ` "${clip(element.name, MAX_NAME)}"` : "";
    return `[${n}] ${role}${name} (blocked)`;
  }
  const name = element.name.length > 0 ? ` "${clip(element.name, MAX_NAME)}"` : "";
  const value = element.value !== undefined && element.value.length > 0 ? ` = "${clip(element.value, MAX_VALUE)}"` : "";
  const flags = `${element.checked === true ? " (checked)" : ""}${element.enabled ? "" : " (disabled)"}`;
  return `[${n}] ${role}${name}${value}${flags}`;
}

function matchesFilter(element: Element, filter: string | undefined): boolean {
  if (filter === undefined) return true;
  const needle = filter.toLowerCase();
  return element.name.toLowerCase().includes(needle) || element.role.toLowerCase().includes(needle) || roleLabel(element.role).toLowerCase().includes(needle);
}

function within(bounds: Box, outer: Box | undefined): boolean {
  if (outer === undefined) return true;
  const cx = bounds.x + Math.floor(bounds.width / 2);
  const cy = bounds.y + Math.floor(bounds.height / 2);
  return cx >= outer.x && cx < outer.x + outer.width && cy >= outer.y && cy < outer.y + outer.height;
}

function flattenTree(root: AccessibilityTreeNode | undefined, outer: Box | undefined): Element[] {
  const found: Element[] = [];
  const visit = (node: AccessibilityTreeNode): void => {
    if (node.hidden === true) return;
    const role = node.role ?? "element";
    const name = (node.name ?? "").replace(/\s+/g, " ").trim();
    const bounds = node.bounds ?? undefined;
    const blocked = node.sensitive === true || role === "password text";
    const keep = ACTIONABLE.has(role) && (name.length > 0 || NAMELESS_OK.has(role));
    if (keep && bounds !== undefined && bounds.width > 0 && bounds.height > 0 && within(bounds, outer)) {
      const text = typeof node.text === "string" ? node.text : undefined;
      found.push({
        role,
        name,
        ...(!blocked && VALUE_ROLES.has(role) && text !== undefined && text.length > 0 ? { value: text } : {}),
        enabled: node.enabled !== false,
        blocked,
        bounds
      });
    }
    for (const child of node.children ?? []) visit(child);
  };
  if (root !== undefined) visit(root);
  return found;
}

async function currentActive(context: AgentHostMcpContext): Promise<{ id?: string; title: string; app: string; pid?: number } | undefined> {
  const active = (await context.linux.getActiveWindow().catch(() => undefined))?.activeWindow;
  if (active === undefined) return undefined;
  return { ...(active.windowId === undefined ? {} : { id: active.windowId }), title: active.title ?? "", app: active.appName ?? "", ...(active.pid === undefined ? {} : { pid: active.pid }) };
}

/** Bounds of a window by id, now. Used for the stale check on screen targets. */
export async function currentWindowBounds(context: AgentHostMcpContext, windowId: string): Promise<Box | undefined> {
  const listed = await context.linux.listWindows({ limit: 200 }).catch(() => undefined);
  const found = listed?.windows.find((window) => window.windowId === windowId);
  if (found?.bounds !== undefined) return found.bounds;
  const active = await currentActive(context);
  if (active?.id === windowId) return (await context.linux.getActiveWindowBounds?.().catch(() => undefined))?.bounds;
  return undefined;
}

async function resolveWindow(context: AgentHostMcpContext, windowId: string | undefined): Promise<SeenWindow | undefined> {
  const active = await currentActive(context);
  if (windowId === undefined || windowId === active?.id) {
    if (active === undefined || active.id === undefined) return undefined;
    const bounds = await currentWindowBounds(context, active.id);
    return { id: active.id, title: active.title, app: active.app, ...(active.pid === undefined ? {} : { pid: active.pid }), ...(bounds === undefined ? {} : { bounds }), active: true };
  }
  const listed = await context.linux.listWindows({ limit: 200, includeTitles: true }).catch(() => undefined);
  const found = listed?.windows.find((window) => window.windowId === windowId);
  if (found === undefined) return undefined;
  return { id: found.windowId, title: found.title ?? "", app: found.appName ?? "", ...(found.pid === undefined ? {} : { pid: found.pid }), ...(found.bounds === undefined ? {} : { bounds: found.bounds }), active: false };
}

function domRole(element: BrowserElement): string {
  if (element.type === "password") return "password text";
  return element.role;
}

async function domElements(context: AgentHostMcpContext, elements: BrowserElement[], filter: string | undefined, max: number): Promise<{ list: Array<Element & { ref: string }>; total: number }> {
  const browser = context.linux.browser;
  const base = elements.map((element): Element & { ref: string } => {
    const textual = /^(textbox|searchbox|combobox|entry|input)$/.test(element.role) || element.tag === "input" || element.tag === "textarea";
    const checkable = element.type === "checkbox" || element.type === "radio" || /^(checkbox|radio|switch)$/.test(element.role);
    const name = (element.name ?? "").replace(/\s+/g, " ").trim();
    const secretField = element.type === "password" || (textual && SECRET_NAME.test(name));
    return {
      ref: element.ref,
      role: domRole(element),
      name,
      ...(textual && !checkable && !secretField && element.value !== undefined && element.value.length > 0 ? { value: element.value } : {}),
      ...(checkable && element.checked === true ? { checked: true } : {}),
      enabled: element.disabled !== true,
      blocked: secretField
    };
  });
  const matching = base.filter((element) => matchesFilter(element, filter));
  const shown = matching.slice(0, max);
  // The page's own check for password, one-time-code and card fields, for the lines we will show.
  if (browser !== undefined) {
    await Promise.all(shown.map(async (element) => {
      if (element.blocked || !/entry|textbox|searchbox|combobox/.test(element.role)) return;
      const info = await browser.describe({ ref: element.ref }).catch(() => undefined);
      if (info?.sensitiveField === true) {
        element.blocked = true;
        delete element.value;
      }
    }));
  }
  return { list: shown, total: matching.length };
}

async function ocrElements(context: AgentHostMcpContext, outer: Box | undefined): Promise<Element[]> {
  const ocr = await findScreenTextMatches(context, { query: "", match: "contains", limit: 400 }).catch(() => undefined);
  if (ocr === undefined || !ocr.ok) return [];
  const matches = (ocr.data as { matches?: Array<{ text?: unknown; redacted?: unknown; screenBounds?: Box }> } | null)?.matches ?? [];
  return matches.flatMap((match): Element[] => {
    if (typeof match.text !== "string" || match.redacted === true || match.screenBounds === undefined) return [];
    const text = match.text.trim();
    if (text.length === 0 || !within(match.screenBounds, outer)) return [];
    return [{ role: "text", name: text, enabled: true, blocked: false, bounds: match.screenBounds }];
  });
}

interface Picture {
  data: string;
  mimeType: "image/jpeg";
  scale?: number;
  origin?: { x: number; y: number };
}

async function takePicture(context: AgentHostMcpContext, source: Source, window: SeenWindow | undefined): Promise<Picture | undefined> {
  if (source === "dom") {
    const result = await callGoverned(context, "browser.screenshot", {});
    const image = (result.data as { inlineImage?: { data: string; mimeType: string } } | null)?.inlineImage;
    return result.ok && image !== undefined ? { data: image.data, mimeType: "image/jpeg" } : undefined;
  }
  const useRegion = window !== undefined && !window.active && window.bounds !== undefined;
  const result = await callGoverned(context, "desktop.screenshot", {
    inline: true,
    ...(useRegion ? { region: window!.bounds } : { includeActiveWindowOnly: true })
  });
  const data = result.data as { inlineImage?: { data: string }; inline?: { scale?: number }; screenshotMetadata?: { screenOrigin?: { x: number; y: number } } } | null;
  if (!result.ok || data?.inlineImage === undefined) return undefined;
  return {
    data: data.inlineImage.data,
    mimeType: "image/jpeg",
    ...(data.inline?.scale === undefined ? {} : { scale: data.inline.scale }),
    ...(data.screenshotMetadata?.screenOrigin === undefined ? {} : { origin: data.screenshotMetadata.screenOrigin })
  };
}

/** Whether the agent's own browser page is what the caller means: it is open and its window is active (or there is no window system). */
export async function browserIsTarget(context: AgentHostMcpContext): Promise<boolean> {
  const page = await context.linux.browser?.state().catch(() => undefined);
  if (page === undefined) return false;
  const active = await currentActive(context);
  return active === undefined || (page.title.length > 0 && active.title.includes(page.title));
}

export function createSeeTool(): AnyAgentHostToolDefinition<AgentHostMcpContext> {
  const see: AgentHostToolDefinition<SeeInput, unknown, AgentHostMcpContext> = {
    name: "see",
    description: "Lists what can be acted on in a window as numbered lines: [1] button \"Save\", [2] entry \"Name\" = \"Ada\". Use the numbers with click, type, scroll and drag. Call see again after anything changes. Sources: the agent's own browser page, the accessibility tree, then OCR. Sensitive fields show as (blocked) with no value. picture: auto (default), none, plain, or marked (numbers drawn on the window).",
    riskLevel: "medium",
    inputSchema: seeInput,
    mcpInputSchema: {
      type: "object",
      properties: {
        window: { type: "string", description: "Window id from windows. Default: the active window." },
        filter: { type: "string", description: "Keep only elements whose name or role contains this text." },
        max: { type: "integer", minimum: 1, maximum: 150, description: "Most elements to list. Default 60." },
        picture: { type: "string", enum: ["auto", "none", "plain", "marked"], description: "auto (default) attaches a picture only when the list is thin." }
      },
      additionalProperties: false
    },
    inputSummary: "Look at a window",
    safety: { actionType: "inspect", getInput: () => ({}) },
    async handler(input, context): Promise<ToolResult<unknown>> {
      const max = input.max ?? 60;
      const observations: string[] = [];
      const browser = context.linux.browser;
      const page = await browser?.state().catch(() => undefined);
      const active = await currentActive(context);

      // The agent's own browser page: asked for by window, or the active window is that page (or no window system at all).
      let useDom = false;
      let window: SeenWindow | undefined;
      if (page !== undefined) {
        if (input.window === undefined) {
          useDom = active === undefined || (page.title.length > 0 && active.title.includes(page.title));
        } else {
          const asked = await resolveWindow(context, input.window);
          useDom = asked !== undefined && page.title.length > 0 && asked.title.includes(page.title);
          window = asked;
        }
      }
      if (!useDom) {
        window = window ?? await resolveWindow(context, input.window);
        if (window === undefined) {
          return toolFailure({
            tool: "see",
            riskLevel: "medium",
            error: { code: input.window === undefined ? "active_window_unavailable" : "window_not_found", message: input.window === undefined ? "No active window to look at." : `No open window has id ${input.window}.` },
            observations: ["Call windows to list windows, or open to start one."]
          });
        }
      }

      // Credential and security apps and pages are not read.
      if (useDom) {
        if (classifyAppSensitivity({ url: page!.url.split("?")[0] ?? "" }) === "credential_or_security") {
          return toolFailure({ tool: "see", riskLevel: "medium", error: { code: "safety_blocked", message: "Security pages are not read." }, observations: ["No action was executed.", "This looks like a login or security page. Use ask (kind login, mfa, or captcha) so the person can finish it."] });
        }
      } else {
        const safety = evaluateSafety(
          { tool: "see", actionType: "inspect", strategy: "gui_control", ...(window!.app.length === 0 ? {} : { appName: window!.app }) },
          context.policy,
          safetyContext(context)
        );
        if (!safety.allowed) {
          return toolFailure({ tool: "see", riskLevel: safety.riskLevel, error: { code: "safety_blocked", message: "Looking at this app is blocked by policy.", details: { reasons: safety.reasons } }, observations: safety.reasons });
        }
      }

      let source: Source = "none";
      let elements: Element[] = [];
      let total = 0;
      let domList: Array<Element & { ref: string }> = [];

      if (useDom) {
        try {
          const snapshot = await browser!.snapshot({ maxElements: 300 });
          const built = await domElements(context, snapshot.elements, input.filter, max);
          domList = built.list;
          total = built.total;
          elements = domList;
          source = "dom";
        } catch (error) {
          return toolFailure({ tool: "see", riskLevel: "medium", error: { code: "snapshot_failed", message: error instanceof Error ? error.message : "Could not read the page." } });
        }
      } else {
        const scope = window!.pid !== undefined ? { pid: window!.pid } : window!.app.length > 0 ? { appName: window!.app } : undefined;
        if (scope !== undefined) {
          const tree = await context.linux.getAccessibilityTree({ ...scope, maxDepth: 14, maxNodes: 600, includeText: true }).catch(() => undefined);
          if (tree?.supported === true && tree.root !== undefined) {
            const all = flattenTree(tree.root, window!.bounds);
            if (all.length > 0) {
              source = "accessibility";
              const matching = all.filter((element) => matchesFilter(element, input.filter));
              total = matching.length;
              elements = matching.slice(0, max);
            }
          }
        }
        if (source === "none") {
          const words = await ocrElements(context, window!.bounds);
          if (words.length > 0) {
            source = "ocr";
            const matching = words.filter((element) => matchesFilter(element, input.filter));
            total = matching.length;
            elements = matching.slice(0, max);
            observations.push("No accessibility tree; these are OCR words.");
          }
        }
      }

      const targets = new Map<number, ViewTarget>();
      const lines: string[] = [];
      elements.forEach((element, index) => {
        const n = index + 1;
        lines.push(formatLine(n, element));
        if (element.ref !== undefined) {
          targets.set(n, { kind: "dom", ref: element.ref, role: element.role, name: element.name, enabled: element.enabled, blocked: element.blocked });
        } else if (element.bounds !== undefined && window !== undefined) {
          targets.set(n, { kind: "screen", bounds: element.bounds, enabled: element.enabled, blocked: element.blocked, role: element.role, name: element.name, windowId: window.id });
        }
      });
      const truncated = total > elements.length;
      const windowKey = useDom ? "browser" : window!.id;
      const view: SeenView = rememberView({
        windowKey,
        ...(window?.bounds === undefined || useDom ? {} : { windowBounds: window.bounds }),
        source,
        targets
      });
      if (truncated) observations.push(`Showing ${elements.length} of ${total}. Use filter or a larger max.`);
      if (elements.length === 0) observations.push(source === "none" ? "Nothing to number in this window. Use the picture, or guide.show for the person." : "No element matches.");
      if (elements.some((element) => element.blocked)) observations.push("(blocked) fields are never read or typed into. Use ask so the person can fill them.");

      // The picture.
      const wanted = input.picture ?? "auto";
      const mode = wanted === "auto" ? ((source === "dom" || source === "accessibility") && elements.length >= 3 ? "none" : "plain") : wanted;
      let picture: Picture | undefined;
      let shown: "none" | "plain" | "marked" = "none";
      if (mode !== "none") {
        picture = await takePicture(context, source, window);
        if (picture === undefined) {
          observations.push("The picture could not be taken.");
        } else {
          shown = "plain";
          if (mode === "marked") {
            const canMark = source !== "dom" && picture.scale !== undefined && picture.origin !== undefined;
            if (!canMark) {
              observations.push(source === "dom" ? "Marks are not drawn on a browser page; showing the plain picture." : "Could not place marks; showing the plain picture.");
            } else {
              const marks: PictureMark[] = [];
              for (const [n, target] of targets) {
                if (target.kind !== "screen" || marks.length >= MAX_MARKS) continue;
                marks.push({
                  n,
                  x: (target.bounds.x - picture.origin!.x) * picture.scale!,
                  y: (target.bounds.y - picture.origin!.y) * picture.scale!,
                  width: target.bounds.width * picture.scale!,
                  height: target.bounds.height * picture.scale!
                });
              }
              const drawn = await drawMarks(context.config.agentHostDir, picture.data, marks);
              if (drawn === undefined) {
                observations.push("Could not draw the numbers (ffmpeg with drawtext is needed); showing the plain picture.");
              } else {
                picture = { ...picture, data: drawn };
                shown = "marked";
                if (targets.size > MAX_MARKS) observations.push(`Only the first ${MAX_MARKS} numbers are drawn.`);
              }
            }
          }
        }
      }

      return toolSuccess({
        tool: "see",
        riskLevel: "medium",
        strategy: useDom ? "browser_automation" : "gui_control",
        data: {
          view: view.id,
          window: useDom
            ? { id: "browser", title: page!.title, app: "Chrome" }
            : { id: window!.id, title: window!.title, app: window!.app },
          source,
          count: elements.length,
          truncated,
          picture: shown,
          list: lines.join("\n"),
          ...(picture === undefined ? {} : { inlineImage: { data: picture.data, mimeType: picture.mimeType } })
        },
        observations
      });
    }
  };
  return see as AnyAgentHostToolDefinition<AgentHostMcpContext>;
}
