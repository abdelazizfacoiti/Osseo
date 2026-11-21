import { evaluateSafety, toolFailure, toolSuccess, type ToolResult } from "@osseo/core";
import { z } from "zod";
import type { OsseoMcpContext } from "../context.js";
import { safetyContext } from "../context.js";
import type { OsseoToolDefinition, AnyOsseoToolDefinition } from "../tool-runner.js";

/**
 * Text before pixels: an outline of the active window, from the accessibility tree. It names what
 * is there (role, name, enabled, where it is) without any text content, and it is capped in bytes,
 * so one call usually answers "what is on screen" for far less than a screenshot.
 */

const readInput = z.object({
  maxBytes: z.number().int().min(512).max(8192).optional()
}).strict();

type ReadInput = z.infer<typeof readInput>;

interface OutlineNode {
  role?: string;
  name?: string;
  enabled?: boolean | null;
  hidden?: boolean;
  sensitive?: boolean;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  children?: OutlineNode[];
}

/** Roles worth a line even without a name: the things a person would act on. */
const ACTIONABLE = new Set(["push button", "toggle button", "check box", "radio button", "entry", "text", "combo box", "menu item", "link", "tab", "list item", "page tab", "spin button", "slider"]);
const MAX_DEPTH = 8;
const MAX_NAME = 60;

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_NAME ? `${flat.slice(0, MAX_NAME - 1)}…` : flat;
}

function lineFor(node: OutlineNode, depth: number): string | undefined {
  const role = node.role ?? "element";
  const name = node.name === undefined ? "" : clip(node.name);
  if (name.length === 0 && !ACTIONABLE.has(role)) return undefined;
  // The backend sends null when AT-SPI has no extents for a node.
  const bounds = node.bounds ?? undefined;
  const where = bounds !== undefined && bounds.width > 0 && bounds.height > 0
    ? ` @${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`
    : "";
  return `${"  ".repeat(Math.min(depth, MAX_DEPTH))}${role}${name.length === 0 ? "" : ` "${name}"`}${node.enabled === false ? " [disabled]" : ""}${where}`;
}

/** Depth-first outline within a byte budget. Hidden and sensitive nodes are skipped with their names. */
export function outlineOf(root: OutlineNode | undefined, maxBytes: number): { lines: string[]; elements: number; truncated: boolean } {
  const lines: string[] = [];
  let bytes = 0;
  let elements = 0;
  let truncated = false;
  const visit = (node: OutlineNode, depth: number): void => {
    if (node.hidden === true || node.sensitive === true) return;
    const line = lineFor(node, depth);
    if (line !== undefined) {
      elements += 1;
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (bytes + size > maxBytes) {
        truncated = true;
        return;
      }
      lines.push(line);
      bytes += size;
    }
    for (const child of node.children ?? []) {
      if (truncated) return;
      visit(child, line === undefined ? depth : depth + 1);
    }
  };
  if (root !== undefined) visit(root, 0);
  return { lines, elements, truncated };
}

export function createScreenTools(): AnyOsseoToolDefinition<OsseoMcpContext>[] {
  const read: OsseoToolDefinition<ReadInput, unknown, OsseoMcpContext> = {
    name: "screen.read",
    description: "Outline of the active window from the accessibility tree: roles, names, enabled state and screen bounds, no text content, capped in bytes (default 2048). Cheaper than a screenshot for \"what is on screen\" questions; falls back to a hint when the app exposes no accessibility tree.",
    riskLevel: "low",
    inputSchema: readInput,
    mcpInputSchema: { type: "object", properties: { maxBytes: { type: "integer", minimum: 512, maximum: 8192, description: "Byte cap for the outline. Default 2048." } }, additionalProperties: false },
    inputSummary: "Read the window outline",
    safety: { actionType: "inspect", getInput: () => ({}) },
    async handler(input: ReadInput, context): Promise<ToolResult<unknown>> {
      const current = await context.linux.getActiveWindow().catch(() => undefined);
      const active = current?.activeWindow;
      if (active?.pid === undefined && active?.appName === undefined) {
        return toolFailure({ tool: "screen.read", riskLevel: "low", error: { code: "active_window_unavailable", message: "No active window to outline." }, observations: ["Take a desktop.screenshot instead."] });
      }
      const scope = active.pid !== undefined ? { pid: active.pid } : { appName: active.appName! };
      const safety = evaluateSafety(
        { tool: "screen.read", actionType: "inspect", strategy: "gui_control", ...(active.appName === undefined ? {} : { appName: active.appName }) },
        context.policy,
        safetyContext(context)
      );
      if (!safety.allowed) {
        return toolFailure({ tool: "screen.read", riskLevel: safety.riskLevel, error: { code: "safety_blocked", message: "Reading this app's accessibility tree is blocked by policy.", details: { reasons: safety.reasons } }, observations: safety.reasons });
      }
      const tree = await context.linux.getAccessibilityTree({ ...scope, maxDepth: 14, maxNodes: 600, includeText: false });
      const maxBytes = input.maxBytes ?? 2048;
      if (!tree.supported || tree.root === undefined) {
        return toolSuccess({
          tool: "screen.read",
          riskLevel: "low",
          data: {
            app: active.appName ?? null,
            title: active.title ?? null,
            outline: "",
            elements: 0,
            truncated: false,
            hint: "This window exposes no accessibility outline. Take a desktop.screenshot and use desktop.click with screenshotId and imageX/imageY."
          },
          observations: ["No accessibility outline; a screenshot is the next step."]
        });
      }
      const outline = outlineOf(tree.root as OutlineNode, maxBytes);
      return toolSuccess({
        tool: "screen.read",
        riskLevel: "low",
        data: {
          app: active.appName ?? null,
          title: active.title ?? null,
          outline: outline.lines.join("\n"),
          elements: outline.elements,
          truncated: outline.truncated,
          bytes: Buffer.byteLength(outline.lines.join("\n"), "utf8")
        },
        observations: [outline.truncated
          ? `Outline cut at ${maxBytes} bytes. Use ui.find for one control, or raise maxBytes.`
          : "Outline of the active window: names and bounds, no text."]
      });
    }
  };
  return [read];
}
