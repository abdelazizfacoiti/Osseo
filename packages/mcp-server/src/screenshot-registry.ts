import { randomBytes } from "node:crypto";

/**
 * Screenshots an agent can click on. A desktop.screenshot returns an id; a later click may name
 * that id plus a point in the picture, and Osseo maps the point to screen coordinates.
 *
 * The mapping is only valid while the picture still matches the screen: the reference window
 * (the active window when the picture was taken) must still be where it was. Entries expire, and
 * the registry is bounded, so an old id cannot quietly point at a moved window.
 */

export interface CapturedScreen {
  id: string;
  createdAt: number;
  /** Screen position of picture pixel (0, 0), before any scaling. */
  origin: { x: number; y: number };
  /** Picture pixels per screen pixel: the inline downscale times the capture scale. */
  pixelsPerPoint: number;
  imageWidth: number;
  imageHeight: number;
  /** The window the picture was taken against; absent when no window was known. */
  reference?: { windowId: string; bounds: { x: number; y: number; width: number; height: number } };
}

export const SCREENSHOT_TTL_MS = 5 * 60 * 1000;
export const SCREENSHOT_LIMIT = 20;

const entries = new Map<string, CapturedScreen>();

function expire(now: number): void {
  for (const [id, entry] of entries) {
    if (now - entry.createdAt > SCREENSHOT_TTL_MS) entries.delete(id);
  }
  while (entries.size > SCREENSHOT_LIMIT) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** Stores a capture and returns its id. */
export function rememberScreen(entry: Omit<CapturedScreen, "id" | "createdAt">, now = Date.now()): string {
  expire(now);
  const id = `shot_${randomBytes(6).toString("hex")}`;
  entries.set(id, { ...entry, id, createdAt: now });
  expire(now);
  return id;
}

/** The capture for an id, or undefined when it is unknown or expired. */
export function recallScreen(id: string, now = Date.now()): CapturedScreen | undefined {
  expire(now);
  return entries.get(id);
}

/** Maps a picture point to a screen point. Refuses points outside the picture. */
export function imagePointToScreen(screen: CapturedScreen, imageX: number, imageY: number): { x: number; y: number } | { error: "image_point_outside" } {
  if (!Number.isFinite(imageX) || !Number.isFinite(imageY)) return { error: "image_point_outside" };
  if (imageX < 0 || imageY < 0 || imageX >= screen.imageWidth || imageY >= screen.imageHeight) return { error: "image_point_outside" };
  return {
    x: screen.origin.x + Math.round(imageX / screen.pixelsPerPoint),
    y: screen.origin.y + Math.round(imageY / screen.pixelsPerPoint)
  };
}

/** Whether a reference window still has the bounds it had when the picture was taken. */
export function sameBounds(
  left: { x: number; y: number; width: number; height: number } | undefined,
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return left !== undefined && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

/** Test support: forget everything. */
export function forgetScreens(): void {
  entries.clear();
}
