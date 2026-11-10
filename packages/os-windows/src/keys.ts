/*
 * Key names to Windows virtual-key codes. Hotkeys arrive as names ("ctrl", "l", "Return") or as
 * chords ("ctrl+shift+t"); the helper only ever sees numbers.
 */

const NAMED: Record<string, number> = {
  ctrl: 0x11, control: 0x11,
  shift: 0x10,
  alt: 0x12, option: 0x12,
  super: 0x5b, win: 0x5b, windows: 0x5b, meta: 0x5b, cmd: 0x5b,
  return: 0x0d, enter: 0x0d,
  tab: 0x09,
  escape: 0x1b, esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e, del: 0x2e,
  insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23,
  pageup: 0x21, prior: 0x21, page_up: 0x21,
  pagedown: 0x22, next: 0x22, page_down: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  minus: 0xbd, equal: 0xbb, comma: 0xbc, period: 0xbe, slash: 0xbf,
  semicolon: 0xba, bracketleft: 0xdb, bracketright: 0xdd, backslash: 0xdc,
  grave: 0xc0, apostrophe: 0xde
};

/** The virtual-key code for one key name, or undefined when the name is unknown. */
export function keyToVirtualKey(name: string): number | undefined {
  const key = name.trim().toLowerCase();
  if (key === "") return undefined;
  const named = NAMED[key];
  if (named !== undefined) return named;
  if (/^[a-z]$/.test(key)) return 0x41 + (key.charCodeAt(0) - 97);
  if (/^[0-9]$/.test(key)) return 0x30 + (key.charCodeAt(0) - 48);
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (fn !== null) return 0x70 + Number(fn[1]) - 1;
  return undefined;
}

export type ParsedHotkey = { ok: true; vks: number[] } | { ok: false; reason: string };

/** Accepts ["ctrl", "l"] and ["ctrl+shift+t"] alike. The chord is pressed in order and released in reverse. */
export function parseHotkey(keys: string[]): ParsedHotkey {
  const names = keys.flatMap((entry) => (entry.length > 1 ? entry.split("+") : [entry])).map((entry) => entry.trim()).filter((entry) => entry !== "");
  if (names.length === 0) return { ok: false, reason: "No keys were given." };
  const vks: number[] = [];
  for (const name of names) {
    const vk = keyToVirtualKey(name);
    if (vk === undefined) return { ok: false, reason: `Unknown key "${name}".` };
    vks.push(vk);
  }
  return { ok: true, vks };
}
