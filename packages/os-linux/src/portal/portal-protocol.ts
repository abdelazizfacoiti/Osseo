/*
 * Wayland portal backend, pure parts: key and button codes, the session test and the opt-in flag.
 * Nothing here does I/O. The portal calls are in portal-session.ts; the DBus code is in
 * packages/os-linux/runtime/portal_helper.py.
 */

/** Linux input event codes for the pointer buttons (linux/input-event-codes.h). */
export const BUTTON_CODES = { left: 0x110, right: 0x111, middle: 0x112 } as const;

/** X11 keysyms (keysymdef.h) for the keys Osseo names in hotkeys. */
const NAMED_KEYSYMS = new Map<string, number>([
  ["ctrl", 0xffe3],
  ["control", 0xffe3],
  ["shift", 0xffe1],
  ["alt", 0xffe9],
  ["super", 0xffeb],
  ["meta", 0xffe7],
  ["enter", 0xff0d],
  ["return", 0xff0d],
  ["esc", 0xff1b],
  ["escape", 0xff1b],
  ["tab", 0xff09],
  ["backspace", 0xff08],
  ["delete", 0xffff],
  ["del", 0xffff],
  ["insert", 0xff63],
  ["home", 0xff50],
  ["end", 0xff57],
  ["pageup", 0xff55],
  ["page_up", 0xff55],
  ["pagedown", 0xff56],
  ["page_down", 0xff56],
  ["left", 0xff51],
  ["up", 0xff52],
  ["right", 0xff53],
  ["down", 0xff54],
  ["space", 0x0020]
]);

const MODIFIER_NAMES = new Set(["ctrl", "control", "shift", "alt", "super", "meta"]);

/** Names that act as modifiers in a hotkey: they are pressed first and released last. */
export function isModifierKeyName(name: string): boolean {
  return MODIFIER_NAMES.has(name.trim().toLowerCase());
}

/**
 * The keysym for one character: Latin-1 characters are their own code point, other characters use the
 * Unicode keysym range (0x01000000 + code point). Newline and tab map to Return and Tab. Other control
 * characters have no keysym and return undefined.
 */
export function keysymForCharacter(character: string): number | undefined {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined || Array.from(character).length !== 1) return undefined;
  if (codePoint === 0x0a) return NAMED_KEYSYMS.get("enter");
  if (codePoint === 0x09) return NAMED_KEYSYMS.get("tab");
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) return codePoint;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0) || codePoint > 0x10ffff) return undefined;
  return 0x01000000 + codePoint;
}

/** Keysyms for a text, or the first character that has none. */
export function keysymsForText(text: string): { ok: true; keysyms: number[] } | { ok: false; character: string } {
  const keysyms: number[] = [];
  for (const character of text) {
    const keysym = keysymForCharacter(character);
    if (keysym === undefined) return { ok: false, character };
    keysyms.push(keysym);
  }
  return { ok: true, keysyms };
}

/** Keysym for a hotkey name ("ctrl", "Enter", "f5", "a"), or undefined when the name is unknown. */
export function keysymForKeyName(name: string): number | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return undefined;
  const named = NAMED_KEYSYMS.get(trimmed.toLowerCase());
  if (named !== undefined) return named;
  const functionKey = /^f([1-9]|1[0-2])$/i.exec(trimmed);
  if (functionKey !== null) return 0xffbe + Number(functionKey[1]) - 1;
  if (Array.from(trimmed).length === 1) return keysymForCharacter(trimmed);
  return undefined;
}

/**
 * True when the desktop session is Wayland (native or with XWayland). An explicit x11 session is not
 * Wayland even when WAYLAND_DISPLAY is set.
 */
export function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  const sessionType = (env.XDG_SESSION_TYPE ?? "").trim().toLowerCase();
  if (sessionType === "x11") return false;
  return sessionType === "wayland" || Boolean((env.WAYLAND_DISPLAY ?? "").trim());
}

/** The opt-in switch: OSSEO_WAYLAND_PORTAL=1 in the environment of the MCP server. */
export function portalRequested(env: NodeJS.ProcessEnv): boolean {
  return env.OSSEO_WAYLAND_PORTAL === "1";
}

/** The portal path is used only when it was requested and the session is Wayland. */
export function shouldUseWaylandPortal(env: NodeJS.ProcessEnv): boolean {
  return portalRequested(env) && isWaylandSession(env);
}

/** The whole shared screen is the one target on the portal path. The compositor does not report windows. */
export const PORTAL_SCREEN_WINDOW_ID = "portal-screen";
