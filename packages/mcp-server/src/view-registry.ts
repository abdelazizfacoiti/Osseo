import { randomBytes } from "node:crypto";
import { sameBounds } from "./screenshot-registry.js";

/**
 * Numbered views from `see`. Every number in a view maps to a stored target. A view lives five
 * minutes, at most ten views are kept, and the next `see` on the same window replaces the old view
 * of it. A screen target is refused as stale when its window moved or resized after the view.
 */

export type Box = { x: number; y: number; width: number; height: number };

export type ViewTarget =
  | { kind: "dom"; ref: string; role: string; name: string; enabled: boolean; blocked: boolean }
  | { kind: "screen"; bounds: Box; enabled: boolean; blocked: boolean; role: string; name: string; windowId: string };

export interface SeenView {
  id: string;
  createdAt: number;
  /** Key of the window the view belongs to ("browser" for the agent's own page). */
  windowKey: string;
  /** Window bounds when the view was taken; screen targets are stale once they differ. */
  windowBounds?: Box;
  source: "dom" | "accessibility" | "ocr" | "none";
  targets: Map<number, ViewTarget>;
  /** The numbered lines the model saw (accessibility views only), updated after each action. */
  outline?: string[];
  /** How the picture `see` returned maps to the screen: screen = origin + picture pixel / scale. */
  picture?: { scale: number; origin: { x: number; y: number } };
  /** The filter and max `see` used, so a later read lists the same things. */
  filter?: string;
  max?: number;
}

export const VIEW_TTL_MS = 5 * 60 * 1000;
export const VIEW_LIMIT = 10;

const views = new Map<string, SeenView>();

function expire(now: number): void {
  for (const [id, view] of views) {
    if (now - view.createdAt > VIEW_TTL_MS) views.delete(id);
  }
  while (views.size > VIEW_LIMIT) {
    const oldest = views.keys().next().value;
    if (oldest === undefined) break;
    views.delete(oldest);
  }
}

/** Stores a view, replacing any earlier view of the same window, and returns it. */
export function rememberView(entry: Omit<SeenView, "id" | "createdAt">, now = Date.now()): SeenView {
  expire(now);
  for (const [id, view] of views) {
    if (view.windowKey === entry.windowKey) views.delete(id);
  }
  const view: SeenView = { ...entry, id: `v_${randomBytes(3).toString("hex")}`, createdAt: now };
  views.set(view.id, view);
  expire(now);
  return view;
}

/** The view for an id, or the newest view when no id is given. */
export function recallView(id: string | undefined, now = Date.now()): SeenView | undefined {
  expire(now);
  if (id !== undefined) return views.get(id);
  let newest: SeenView | undefined;
  for (const view of views.values()) {
    if (newest === undefined || view.createdAt >= newest.createdAt) newest = view;
  }
  return newest;
}

export type TargetLookup =
  | { ok: true; view: SeenView; target: ViewTarget }
  | { ok: false; code: "no_view" | "view_unknown" | "number_unknown" | "target_blocked" | "target_disabled" | "view_stale"; message: string };

/**
 * Resolves a number to its target. `currentBounds` is the window's bounds now (screen targets only).
 * Refuses unknown views and numbers, blocked and disabled elements, and moved windows.
 */
export function lookupTarget(
  input: { view?: string | undefined; n: number },
  currentBounds: (view: SeenView) => Promise<Box | undefined>,
  now = Date.now()
): Promise<TargetLookup> {
  return (async (): Promise<TargetLookup> => {
    const view = recallView(input.view, now);
    if (view === undefined) {
      return input.view === undefined
        ? { ok: false, code: "no_view", message: "There is no view yet. Call see first." }
        : { ok: false, code: "view_unknown", message: `View ${input.view} is unknown or expired. Call see again.` };
    }
    const target = view.targets.get(input.n);
    if (target === undefined) {
      return { ok: false, code: "number_unknown", message: `View ${view.id} has no element [${input.n}]. Call see again.` };
    }
    if (target.blocked) {
      return { ok: false, code: "target_blocked", message: `Element [${input.n}] is a sensitive field. The agent does not act on it: use ask so the person can.` };
    }
    if (!target.enabled) {
      return { ok: false, code: "target_disabled", message: `Element [${input.n}] is disabled, so nothing was done.` };
    }
    if (target.kind === "screen") {
      const now_ = await currentBounds(view);
      if (view.windowBounds === undefined || now_ === undefined || !sameBounds(view.windowBounds, now_)) {
        return { ok: false, code: "view_stale", message: "The window moved or resized since this view, or is gone. Call see again." };
      }
    }
    return { ok: true, view, target };
  })();
}

/** Records how the picture shown with a view maps to the screen. */
export function setPicture(viewId: string, picture: { scale: number; origin: { x: number; y: number } }): void {
  const view = views.get(viewId);
  if (view !== undefined) view.picture = picture;
}

/** The newest view of one window, if it is still alive. */
export function viewForWindow(windowKey: string, now = Date.now()): SeenView | undefined {
  expire(now);
  let found: SeenView | undefined;
  for (const view of views.values()) {
    if (view.windowKey === windowKey && (found === undefined || view.createdAt >= found.createdAt)) found = view;
  }
  return found;
}

/**
 * Replaces the stored outline of a view after an action. The numbers (targets) are NOT renewed:
 * they stay those of the last `see`, so a number never silently points at another element.
 */
export function setOutline(viewId: string, outline: string[]): void {
  const view = views.get(viewId);
  if (view !== undefined) view.outline = outline;
}

/** Test support: forget everything. */
export function forgetViews(): void {
  views.clear();
}
