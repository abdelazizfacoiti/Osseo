/*
 * Codex runs the program named by a top-level `notify = [...]` key in
 * ~/.codex/config.toml when a turn completes, and appends one JSON argument.
 * These helpers edit that one key as text so every other byte of the file
 * (comments, tables, spacing) stays as it was. Only one notify program can be
 * set, so a notify that is not ours is never touched.
 */

export const CODEX_NOTIFY_ARGS = ["osseo", "attention", "request", "--source", "codex", "--reason", "done"] as const;
export const CODEX_NOTIFY_LINE = `notify = [${CODEX_NOTIFY_ARGS.map((arg) => JSON.stringify(arg)).join(", ")}]`;

/** Windows runs `osseo` (a .cmd file) through cmd.exe: Codex starts the program without a shell. */
export function codexNotifyArgs(platform: NodeJS.Platform = process.platform): readonly string[] {
  return platform === "win32" ? ["cmd", "/c", ...CODEX_NOTIFY_ARGS] : CODEX_NOTIFY_ARGS;
}
export function codexNotifyLine(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `notify = [${codexNotifyArgs(platform).map((arg) => JSON.stringify(arg)).join(", ")}]` : CODEX_NOTIFY_LINE;
}

export interface CodexNotifyState {
  /** A top-level notify key exists. */
  present: boolean;
  /** It is an Osseo attention command (possibly an older form). */
  ours: boolean;
  /** It is exactly the command we would write. */
  matches: boolean;
}

interface Scan {
  /** Where the next insert goes. */
  insertAt: number;
  hasKeyLines: boolean;
  hasHeader: boolean;
  notify?: { start: number; end: number; items: string[] | undefined };
}

/** Moves the bracket depth and multi-line-string state across one line. */
function scanLine(line: string, depth: number, multi: string | undefined): { depth: number; multi: string | undefined } {
  let index = 0;
  while (index < line.length) {
    if (multi !== undefined) {
      const close = line.indexOf(multi, index);
      if (close < 0) return { depth, multi };
      index = close + 3;
      multi = undefined;
      continue;
    }
    const character = line[index]!;
    if (character === "#") break;
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      multi = line.slice(index, index + 3);
      index += 3;
      continue;
    }
    if (character === '"' || character === "'") {
      index += 1;
      while (index < line.length && line[index] !== character) index += character === '"' && line[index] === "\\" ? 2 : 1;
      index += 1;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]") depth = Math.max(0, depth - 1);
    index += 1;
  }
  return { depth, multi };
}

/** Reads the string items of `[ "a", 'b', ... ]` after the `=`; undefined when it holds anything else. */
function parseStringArray(value: string): string[] | undefined {
  let index = 0;
  const skip = (): void => {
    for (;;) {
      while (index < value.length && /\s/.test(value[index]!)) index += 1;
      if (value[index] === "#") { while (index < value.length && value[index] !== "\n") index += 1; continue; }
      return;
    }
  };
  skip();
  if (value[index] !== "[") return undefined;
  index += 1;
  const items: string[] = [];
  for (;;) {
    skip();
    if (value[index] === ",") { index += 1; continue; }
    if (value[index] === "]") return items;
    const quote = value[index];
    if (quote !== '"' && quote !== "'") return undefined;
    const start = index;
    index += 1;
    while (index < value.length && value[index] !== quote) index += quote === '"' && value[index] === "\\" ? 2 : 1;
    if (index >= value.length) return undefined;
    const token = value.slice(start, index + 1);
    index += 1;
    if (quote === "'") { items.push(token.slice(1, -1)); continue; }
    try { items.push(JSON.parse(token) as string); } catch { return undefined; }
  }
}

function scan(text: string): Scan {
  let offset = 0;
  let depth = 0;
  let multi: string | undefined;
  let lastKeyEnd: number | undefined;
  let notify: Scan["notify"];
  let notifyStart = -1;
  let commentBlockStart: number | undefined;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline < 0 ? text.length : newline + 1;
    const line = text.slice(offset, lineEnd).replace(/\r?\n$/, "");
    const atTop = depth === 0 && multi === undefined;
    if (atTop && /^[ \t]*\[/.test(line)) {
      return {
        insertAt: lastKeyEnd ?? commentBlockStart ?? offset,
        hasKeyLines: lastKeyEnd !== undefined,
        hasHeader: true,
        ...(notify === undefined ? {} : { notify })
      };
    }
    if (atTop && /^[ \t]*notify[ \t]*=/.test(line) && notify === undefined) notifyStart = offset;
    if (atTop) {
      if (line.trim() === "") commentBlockStart = undefined;
      else if (line.trim().startsWith("#")) commentBlockStart ??= offset;
      else commentBlockStart = undefined;
    }
    const next = scanLine(line, depth, multi);
    depth = next.depth;
    multi = next.multi;
    const insideValue = depth !== 0 || multi !== undefined;
    if (atTop && line.trim() !== "" && !line.trim().startsWith("#")) lastKeyEnd = lineEnd;
    else if (!atTop && line.trim() !== "") lastKeyEnd = lineEnd;
    if (notifyStart >= 0 && notify === undefined && !insideValue) {
      const raw = text.slice(notifyStart, lineEnd);
      notify = { start: notifyStart, end: lineEnd, items: parseStringArray(raw.slice(raw.indexOf("=") + 1)) };
      notifyStart = -1;
    }
    offset = lineEnd;
  }
  return { insertAt: lastKeyEnd ?? text.length, hasKeyLines: lastKeyEnd !== undefined, hasHeader: false, ...(notify === undefined ? {} : { notify }) };
}

export function codexNotifyState(text: string): CodexNotifyState {
  const { notify } = scan(text);
  if (notify === undefined) return { present: false, ours: false, matches: false };
  const items = notify.items;
  const viaCmd = items !== undefined && items[0] === "cmd" && items[1] === "/c";
  const own = viaCmd ? items!.slice(2) : items;
  const ours = own !== undefined && own[0] === CODEX_NOTIFY_ARGS[0] && own[1] === CODEX_NOTIFY_ARGS[1];
  const wanted = viaCmd ? codexNotifyArgs("win32") : CODEX_NOTIFY_ARGS;
  return { present: true, ours, matches: ours && items!.length === wanted.length && items!.every((item, index) => item === wanted[index]) };
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Adds our notify key above the first table; leaves a foreign notify and an exact match alone. */
export function codexNotifyAdd(text: string, platform: NodeJS.Platform = process.platform): { text: string; state: CodexNotifyState } {
  const state = codexNotifyState(text);
  const line = codexNotifyLine(platform);
  if (state.present && !state.ours) return { text, state };
  const wanted = codexNotifyArgs(platform);
  const items = scan(text).notify?.items;
  if (state.matches && items !== undefined && items.length === wanted.length && items.every((item, index) => item === wanted[index])) return { text, state };
  const found = scan(text);
  const eol = eolOf(text);
  if (found.notify !== undefined) {
    const hadNewline = text.slice(found.notify.start, found.notify.end).endsWith("\n");
    const updated = `${text.slice(0, found.notify.start)}${line}${hadNewline ? eol : ""}${text.slice(found.notify.end)}`;
    return { text: updated, state: { present: true, ours: true, matches: true } };
  }
  let before = text.slice(0, found.insertAt);
  const after = text.slice(found.insertAt);
  if (before !== "" && !before.endsWith("\n")) before += eol;
  const blankAfter = !found.hasKeyLines && after !== "" ? eol : "";
  return { text: `${before}${line}${eol}${blankAfter}${after}`, state: { present: true, ours: true, matches: true } };
}

/** Removes the notify key only when it is ours. */
export function codexNotifyRemove(text: string): { text: string; removed: boolean } {
  const state = codexNotifyState(text);
  if (!state.ours) return { text, removed: false };
  const { notify } = scan(text);
  return { text: `${text.slice(0, notify!.start)}${text.slice(notify!.end)}`, removed: true };
}
