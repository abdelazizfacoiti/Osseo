import type { AccessibilityElementCandidate, DesktopWindowBounds, DesktopWindowContext } from "@agenthost/core";
import type { AgentHostMcpContext } from "./context.js";
import { findScreenTextMatches } from "./tools/vision.js";

/**
 * Resolves a visible control name to a screen point for desktop.click.
 *
 * AT-SPI first, scoped to the active window's process so a busy desktop cannot exhaust its
 * node budget on other apps. OCR is the fallback for apps that expose no accessibility tree.
 * Only exact name matches are accepted: a near miss such as "Save" for "Save as PDF" is
 * reported as a suggestion, never clicked. Disabled and ambiguous matches are refused.
 */

export type LabelTargetCode = "label_not_found" | "label_ambiguous" | "control_disabled" | "label_lookup_unavailable";

export interface LabelQuery {
  label: string;
  role?: string;
}

export interface LabelCandidate {
  name: string;
  role?: string;
  center: { x: number; y: number };
  enabled?: boolean;
  source: "accessibility" | "ocr";
}

export interface LabelTarget {
  point: { x: number; y: number };
  source: "accessibility" | "ocr";
  name: string;
  role?: string;
  enabled?: boolean;
}

export type LabelResolution =
  | { ok: true; target: LabelTarget }
  | { ok: false; code: LabelTargetCode; message: string; candidates: LabelCandidate[] };

export interface LabelOptions {
  /** Set false to skip the OCR fallback (used for the cheap pre-click ring hint). */
  ocr?: boolean;
}

const MAX_LISTED = 5;

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function centerOf(bounds: DesktopWindowBounds): { x: number; y: number } {
  return { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) };
}

function within(point: { x: number; y: number }, bounds: DesktopWindowBounds | undefined): boolean {
  if (bounds === undefined) return true;
  return point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
}

function roleMatches(candidateRole: string | undefined, wanted: string | undefined): boolean {
  if (wanted === undefined) return true;
  const have = normalize(candidateRole ?? "");
  const want = normalize(wanted);
  return have.length > 0 && (have === want || have.includes(want) || want.includes(have));
}

function dedupe(items: LabelCandidate[]): LabelCandidate[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.name}|${item.role ?? ""}|${item.center.x},${item.center.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function windowBoundsOf(context: AgentHostMcpContext, activeWindow: DesktopWindowContext): Promise<DesktopWindowBounds | undefined> {
  if (activeWindow.windowId === undefined) return undefined;
  const listed = await context.linux.listWindows({ limit: 200 }).catch(() => undefined);
  return listed?.windows.find((window) => window.windowId === activeWindow.windowId)?.bounds;
}

async function accessibilityItems(
  context: AgentHostMcpContext,
  activeWindow: DesktopWindowContext,
  query: LabelQuery,
  bounds: DesktopWindowBounds | undefined
): Promise<{ available: true; items: LabelCandidate[] } | { available: false; reason: string }> {
  if (activeWindow.pid === undefined && activeWindow.appName === undefined) {
    return { available: false, reason: "The active window does not name its app, so AT-SPI cannot be scoped." };
  }
  const found = await context.linux.findAccessibilityElement({
    ...(activeWindow.pid !== undefined
      ? { pid: activeWindow.pid }
      : { appName: activeWindow.appName! }),
    query: query.label,
    ...(query.role === undefined ? {} : { role: query.role }),
    limit: 25
  });
  if (!found.supported) return { available: false, reason: found.reason };
  const items = found.candidates.flatMap((candidate: AccessibilityElementCandidate): LabelCandidate[] => {
    if (candidate.bounds === undefined || candidate.bounds.width <= 0 || candidate.bounds.height <= 0) return [];
    const name = (candidate.name ?? "").trim();
    const center = centerOf(candidate.bounds);
    if (name.length === 0 || !within(center, bounds) || !roleMatches(candidate.role, query.role)) return [];
    return [{
      name,
      role: candidate.role,
      center,
      ...(candidate.enabled === undefined ? {} : { enabled: candidate.enabled }),
      source: "accessibility"
    }];
  });
  return { available: true, items };
}

type Choice =
  | { kind: "none"; suggestions: LabelCandidate[] }
  | { kind: "one"; item: LabelCandidate }
  | { kind: "many"; items: LabelCandidate[] }
  | { kind: "disabled"; items: LabelCandidate[] };

function choose(items: LabelCandidate[], wanted: string): Choice {
  const unique = dedupe(items);
  const exact = unique.filter((item) => normalize(item.name) === wanted);
  if (exact.length === 0) {
    return { kind: "none", suggestions: unique.filter((item) => normalize(item.name).includes(wanted)) };
  }
  const enabled = exact.filter((item) => item.enabled !== false);
  if (enabled.length === 0) return { kind: "disabled", items: exact };
  if (enabled.length > 1) return { kind: "many", items: enabled };
  return { kind: "one", item: enabled[0]! };
}

function listed(items: LabelCandidate[]): LabelCandidate[] {
  return items.slice(0, MAX_LISTED);
}

function describe(query: LabelQuery): string {
  return query.role === undefined ? `"${query.label}"` : `"${query.label}" (${query.role})`;
}

function fromChoice(choice: Choice, query: LabelQuery): LabelResolution | undefined {
  switch (choice.kind) {
    case "none":
      return undefined;
    case "one":
      return {
        ok: true,
        target: {
          point: choice.item.center,
          source: choice.item.source,
          name: choice.item.name,
          ...(choice.item.role === undefined ? {} : { role: choice.item.role }),
          ...(choice.item.enabled === undefined ? {} : { enabled: choice.item.enabled })
        }
      };
    case "many":
      return {
        ok: false,
        code: "label_ambiguous",
        message: `${describe(query)} matches ${choice.items.length} enabled controls in the active window. Pass a role (for example role: "push button") or x and y.`,
        candidates: listed(choice.items)
      };
    case "disabled":
      return {
        ok: false,
        code: "control_disabled",
        message: `${describe(query)} is disabled, so nothing was clicked.`,
        candidates: listed(choice.items)
      };
  }
}

/** Resolves one label to a screen point inside the active window, or says why it cannot. */
export async function resolveLabelTarget(
  context: AgentHostMcpContext,
  activeWindow: DesktopWindowContext,
  query: LabelQuery,
  options: LabelOptions = {}
): Promise<LabelResolution> {
  const wanted = normalize(query.label);
  const bounds = await windowBoundsOf(context, activeWindow);
  let accessibilityNote = "";
  let suggestions: LabelCandidate[] = [];

  const accessibility = await accessibilityItems(context, activeWindow, query, bounds);
  if (accessibility.available) {
    const choice = choose(accessibility.items, wanted);
    const resolved = fromChoice(choice, query);
    if (resolved !== undefined) return resolved;
    if (choice.kind === "none") suggestions = choice.suggestions;
  } else {
    accessibilityNote = ` AT-SPI: ${accessibility.reason}`;
  }

  if (options.ocr === false) {
    return {
      ok: false,
      code: "label_not_found",
      message: `No control named ${describe(query)} was found in the active window.${accessibilityNote}`,
      candidates: listed(suggestions)
    };
  }

  const ocr = await findScreenTextMatches(context, { query: query.label, match: "contains", limit: 40 });
  if (!ocr.ok) {
    return {
      ok: false,
      code: "label_lookup_unavailable",
      message: `Neither AT-SPI nor OCR could look up ${describe(query)}.${accessibilityNote}`,
      candidates: []
    };
  }
  const ocrMatches = ((ocr.data as { matches?: Array<{ text?: unknown; screenCenter?: { x: number; y: number } }> } | null)?.matches ?? []);
  const items: LabelCandidate[] = ocrMatches.flatMap((match): LabelCandidate[] => {
    if (typeof match.text !== "string" || match.screenCenter === undefined) return [];
    if (!within(match.screenCenter, bounds)) return [];
    return [{ name: match.text.trim(), center: match.screenCenter, source: "ocr" }];
  });
  const choice = choose(items, wanted);
  const resolved = fromChoice(choice, query);
  if (resolved !== undefined) return resolved;
  const ocrSuggestions = choice.kind === "none" ? choice.suggestions : [];
  return {
    ok: false,
    code: "label_not_found",
    message: `No control named ${describe(query)} was found in the active window (AT-SPI and OCR).${accessibilityNote}`,
    candidates: listed(dedupe([...suggestions, ...ocrSuggestions]))
  };
}
