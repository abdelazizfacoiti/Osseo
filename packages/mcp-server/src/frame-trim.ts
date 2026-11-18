/*
 * The always-on edge frame is four strips of FRAME_THICKNESS pixels along the screen edges. A window-only capture of
 * a window that touches a screen edge is cropped from the composited screen, so it would contain those strip pixels.
 * `frameTrim` says how many pixels to cut from each side of the capture so the picture holds only the window.
 */

/** Strip thickness in pixels. Keep equal to FRAME_THICKNESS in packages/app-overlay/runtime/gtk3-renderer.py. */
export const OVERLAY_FRAME_THICKNESS = 6;

export interface PixelBox { x: number; y: number; width: number; height: number }
export interface FrameTrim { left: number; top: number; right: number; bottom: number }

/** Pixels of `windowBox` that lie under a frame strip of `thickness` along the edges of `screen`. Undefined when none. */
export function frameTrim(windowBox: PixelBox, screen: PixelBox, thickness: number = OVERLAY_FRAME_THICKNESS): FrameTrim | undefined {
  if (!(thickness > 0)) return undefined;
  const clamp = (value: number, max: number) => Math.max(0, Math.min(Math.round(value), max));
  const left = clamp(screen.x + thickness - windowBox.x, windowBox.width);
  const top = clamp(screen.y + thickness - windowBox.y, windowBox.height);
  const right = clamp(windowBox.x + windowBox.width - (screen.x + screen.width - thickness), windowBox.width);
  const bottom = clamp(windowBox.y + windowBox.height - (screen.y + screen.height - thickness), windowBox.height);
  // A window that is almost all strip would leave nothing; keep the capture whole rather than empty.
  if (left + right >= windowBox.width || top + bottom >= windowBox.height) return undefined;
  return left + top + right + bottom === 0 ? undefined : { left, top, right, bottom };
}
