import { evaluateSafety } from "@osseo/core";
import type { OsseoMcpContext } from "./context.js";
import { safetyContext } from "./context.js";
import { flattenTree, formatLine, matchesFilter, resolveWindow } from "./tools/see.js";
import { setOutline, type SeenView } from "./view-registry.js";

/**
 * Structure-first verification. After a numbered action the window's accessibility outline is read
 * again with the same source, filter and size as `see`, and compared with the outline the model
 * last saw. The result says what changed in words. Pixels are only the fallback.
 */

export const NO_CHANGE = "no change in the window's controls";
export const STRUCTURE_BUDGET_MS = 1500;
export const STRUCTURE_MAX_NODES = 600;
const MAX_VALUE = 40;
const MAX_SENTENCES = 10;
const VALUE_ROLES = new Set(["entry", "text", "spin button", "combo box"]);

export interface OutlineDiff {
  /** Sentences, or the single "no change" sentence. */
  changes: string[];
  /** Number of real changes (0 when nothing changed), before the sentences were capped. */
  count: number;
  appeared: number;
  wentAway: number;
  changed: number;
  protectedChanged: number;
}

interface Parsed {
  role: string;
  name: string;
  value?: string;
  checked: boolean;
  enabled: boolean;
  blocked: boolean;
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > MAX_VALUE ? `${flat.slice(0, MAX_VALUE - 1)}…` : flat;
}

/** Reads one `see` line: `[n] role "name" = "value" (checked) (disabled)` or `(blocked)`. */
export function parseOutlineLine(line: string): Parsed {
  let rest = line.replace(/^\[\d+\]\s*/, "").trim();
  let blocked = false;
  let checked = false;
  let enabled = true;
  if (rest.endsWith(" (blocked)")) {
    blocked = true;
    rest = rest.slice(0, -" (blocked)".length);
  }
  for (;;) {
    if (rest.endsWith(" (checked)")) { checked = true; rest = rest.slice(0, -" (checked)".length); continue; }
    if (rest.endsWith(" (disabled)")) { enabled = false; rest = rest.slice(0, -" (disabled)".length); continue; }
    break;
  }
  let value: string | undefined;
  let head = rest;
  if (rest.endsWith('"')) {
    const split = rest.lastIndexOf(' = "');
    if (split >= 0) {
      value = rest.slice(split + 4, -1);
      head = rest.slice(0, split);
    }
  }
  let role = head;
  let name = "";
  const q = head.indexOf(' "');
  if (q >= 0 && head.endsWith('"')) {
    role = head.slice(0, q);
    name = head.slice(q + 2, -1);
  }
  // A protected field never carries a value into a sentence.
  return { role, name, ...(blocked || value === undefined ? {} : { value }), checked, enabled, blocked };
}

function label(entry: Parsed, forValue = false): string {
  const role = forValue && VALUE_ROLES.has(entry.role) ? "field" : entry.role;
  return entry.name.length > 0 ? `${role} "${clip(entry.name)}"` : role;
}

/** Compares two outlines (lists of `see` lines) and says what changed. Pure. */
export function diffOutlines(before: readonly string[], after: readonly string[]): OutlineDiff {
  const group = (lines: readonly string[]): Map<string, Parsed[]> => {
    const map = new Map<string, Parsed[]>();
    for (const line of lines) {
      const entry = parseOutlineLine(line);
      const key = `${entry.role}\u0000${entry.name}`;
      map.set(key, [...(map.get(key) ?? []), entry]);
    }
    return map;
  };
  const was = group(before);
  const now = group(after);
  const sentences: string[] = [];
  let appeared = 0;
  let wentAway = 0;
  let changed = 0;
  let protectedChanged = 0;

  for (const [key, entries] of now) {
    const old = was.get(key) ?? [];
    entries.forEach((entry, index) => {
      const prev = old[index];
      if (prev === undefined) {
        appeared += 1;
        sentences.push(entry.blocked ? "a protected field appeared" : `${label(entry)} appeared`);
        return;
      }
      if (prev.blocked !== entry.blocked) {
        protectedChanged += 1;
        changed += 1;
        sentences.push("protected field changed");
        return;
      }
      if (entry.blocked) return;
      if ((prev.value ?? "") !== (entry.value ?? "")) {
        changed += 1;
        sentences.push(entry.value === undefined || entry.value.length === 0 ? `${label(entry, true)} was cleared` : `${label(entry, true)} now reads "${clip(entry.value)}"`);
      }
      if (prev.checked !== entry.checked) {
        changed += 1;
        sentences.push(`${label(entry)} is ${entry.checked ? "now checked" : "no longer checked"}`);
      }
      if (prev.enabled !== entry.enabled) {
        changed += 1;
        sentences.push(`${label(entry)} is now ${entry.enabled ? "enabled" : "disabled"}`);
      }
    });
  }
  for (const [key, old] of was) {
    const present = now.get(key)?.length ?? 0;
    for (const entry of old.slice(present)) {
      wentAway += 1;
      sentences.push(entry.blocked ? "a protected field went away" : `${label(entry)} went away`);
    }
  }

  const count = sentences.length;
  if (count === 0) return { changes: [NO_CHANGE], count: 0, appeared, wentAway, changed, protectedChanged };
  const shown = sentences.slice(0, MAX_SENTENCES);
  if (count > shown.length) shown.push(`and ${count - shown.length} more changes`);
  return { changes: shown, count, appeared, wentAway, changed, protectedChanged };
}

export type StructureReason = "no_view" | "browser_page" | "no_baseline" | "window_differs" | "window_gone" | "blocked" | "unsupported" | "empty" | "timeout";

export type StructureResult =
  | { structure: "used"; changes: string[]; changeCount: number; diff: OutlineDiff }
  | { structure: "unavailable"; changes: []; changeCount: 0; reason: StructureReason };

const unavailable = (reason: StructureReason): StructureResult => ({ structure: "unavailable", changes: [], changeCount: 0, reason });

/**
 * Reads the window's outline again and diffs it against the view the model last saw, then stores
 * the new outline on that view (its numbers stay those of the last `see`). Never throws and never
 * guesses: when it cannot compare it says why and the pixel check stays the judge.
 */
export async function observeStructure(
  context: OsseoMcpContext,
  view: SeenView | undefined,
  windowId: string | undefined,
  budgetMs = STRUCTURE_BUDGET_MS
): Promise<StructureResult> {
  try {
    if (view === undefined) return unavailable("no_view");
    if (view.windowKey === "browser") return unavailable("browser_page");
    if (view.source !== "accessibility" || view.outline === undefined) return unavailable("no_baseline");
    if (windowId !== undefined && windowId !== view.windowKey) return unavailable("window_differs");
    const window = await resolveWindow(context, view.windowKey);
    if (window === undefined || window.id !== view.windowKey) return unavailable("window_gone");
    const safety = evaluateSafety({ tool: "see", actionType: "inspect", strategy: "gui_control", ...(window.app.length === 0 ? {} : { appName: window.app }) }, context.policy, safetyContext(context));
    if (!safety.allowed) return unavailable("blocked");
    const scope = window.pid !== undefined ? { pid: window.pid } : window.app.length > 0 ? { appName: window.app } : undefined;
    if (scope === undefined) return unavailable("unsupported");

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), budgetMs); });
    const read = context.linux.getAccessibilityTree({ ...scope, maxDepth: 14, maxNodes: STRUCTURE_MAX_NODES, includeText: true }).catch(() => undefined);
    const tree = await Promise.race([read, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    if (tree === "timeout") return unavailable("timeout");
    if (tree === undefined || tree.supported !== true) return unavailable("unsupported");
    if (tree.root === undefined) return unavailable("empty");
    const all = flattenTree(tree.root, window.bounds).filter((element) => matchesFilter(element, view.filter));
    const lines = all.slice(0, view.max ?? 60).map((element, index) => formatLine(index + 1, element));
    if (lines.length === 0) return unavailable("empty");

    const diff = diffOutlines(view.outline, lines);
    setOutline(view.id, lines);
    return { structure: "used", changes: diff.changes, changeCount: diff.count, diff };
  } catch {
    return unavailable("unsupported");
  }
}
