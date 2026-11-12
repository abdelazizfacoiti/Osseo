import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/*
 * `agenthost shortcut status|install|remove`: a GNOME custom keyboard shortcut
 * that runs `agenthost agent stop` through a small wrapper script. The wrapper
 * only writes run/stop.requested, so Stop works even when the host is hung.
 * Preview by default; --apply changes the wrapper file and the gsettings keys.
 */

type Output = { ok: boolean; command: string; data?: unknown; error?: string };
export interface RunResult { status: number | null; stdout: string; stderr: string }

export interface ShortcutDeps {
  /** Runs an external program with an argument array (never a shell string). */
  run?: (cmd: string, args: string[]) => Promise<RunResult>;
  /** File existence check (CLI entry). */
  exists?: (file: string) => boolean;
  /** Whether a gsettings program is on PATH. */
  hasGsettings?: () => boolean;
  /** CLI entry path; default process.argv[1]. */
  cliEntry?: string;
  /** Node binary; default process.execPath. */
  node?: string;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_BINDING = "<Control><Shift><Alt>Escape";
const ACCELERATOR = /^(<[A-Za-z]+>)*[A-Za-z0-9_]+$/;
const MEDIA_KEYS = "org.gnome.settings-daemon.plugins.media-keys";
const LIST_KEY = "custom-keybindings";
const SLOT = "agenthost-stop";
const SLOT_PATH = `/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/${SLOT}/`;
const SLOT_SCHEMA = `${MEDIA_KEYS}.custom-keybinding:${SLOT_PATH}`;
const NAME = "AgentHost stop";
const MANUAL = "Add a custom shortcut in your desktop's keyboard settings that runs: <node> <agenthost cli> agent stop --reason shortcut (for example Ctrl+Shift+Alt+Esc).";

const fail = (command: string, error: string, extra?: Record<string, unknown>): Output => ({ ok: false, command, error, ...(extra === undefined ? {} : { data: extra }) });

/** Single-quote one word for sh: ' becomes '\'' . */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
/** Quote for gsettings `command` values, which GNOME splits like a shell: plain words stay bare. */
function commandWord(value: string): string {
  return /^[A-Za-z0-9_\/.@%+=:,-]+$/.test(value) ? value : shQuote(value);
}

export function wrapperContent(node: string, cli: string): string {
  return `#!/bin/sh\nexec ${[node, cli, "agent", "stop", "--reason", "shortcut"].map(shQuote).join(" ")}\n`;
}

/** Parses a GVariant string array such as `['/a/', '/b/']` or `@as []`. */
export function parseStringList(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/'((?:[^'\\]|\\.)*)'/g)) out.push(m[1]!.replace(/\\(.)/g, "$1"));
  return out;
}
function formatStringList(items: string[]): string {
  return `[${items.map((item) => `'${item.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(", ")}]`;
}
function parseString(text: string): string {
  return parseStringList(text)[0] ?? "";
}

function defaultRun(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null;
      resolve({ status: code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function defaultHasGsettings(): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(path.join(dir, "gsettings")));
}

function parseFlags(args: string[]): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (name === "binding") { const next = args[i + 1]; if (next !== undefined) { values.set(name, next); i++; } else flags.add(name); } else flags.add(name);
  }
  return { values, flags };
}

export async function shortcutCommand(args: string[], agentHome: string, deps: ShortcutDeps = {}): Promise<Output> {
  const sub = args[0];
  if (sub !== "status" && sub !== "install" && sub !== "remove") return fail("shortcut", "usage: agenthost shortcut status | install [--binding <accelerator>] [--apply] | remove [--apply]");
  const command = `shortcut ${sub}`;
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const desktop = env.XDG_CURRENT_DESKTOP ?? "";
  const gnome = /GNOME/i.test(desktop) && (deps.hasGsettings ?? defaultHasGsettings)();
  const { values, flags } = parseFlags(args);
  const apply = flags.has("apply");
  const binding = values.get("binding") ?? DEFAULT_BINDING;

  if (sub === "install" && (flags.has("binding") || !ACCELERATOR.test(binding))) return fail(command, "invalid_binding: use a GTK accelerator such as <Control><Shift><Alt>Escape");
  if (!gnome) {
    if (sub === "status") return { ok: true, command, data: { desktop, supported: false, installed: false, manual: MANUAL } };
    return fail(command, `unsupported_desktop: only GNOME with gsettings is supported (desktop: ${desktop || "unknown"}). ${MANUAL}`);
  }

  const wrapper = path.join(agentHome, "bin", "agenthost-stop");
  const gs = async (...a: string[]): Promise<RunResult> => await run("gsettings", a);
  const readList = async (): Promise<string[] | undefined> => {
    const r = await gs("get", MEDIA_KEYS, LIST_KEY);
    return r.status === 0 ? parseStringList(r.stdout) : undefined;
  };
  const readKey = async (key: string): Promise<string | undefined> => {
    const r = await gs("get", SLOT_SCHEMA, key);
    return r.status === 0 ? parseString(r.stdout) : undefined;
  };

  if (sub === "status") {
    const list = await readList();
    if (list === undefined) return fail(command, "gsettings_failed: could not read the custom keybinding list");
    const present = list.includes(SLOT_PATH);
    const [cmd, bind] = present ? [await readKey("command"), await readKey("binding")] : [undefined, undefined];
    return { ok: true, command, data: { desktop, supported: true, installed: present, binding: bind ?? null, command: cmd ?? null, wrapper, wrapperExists: (deps.exists ?? existsSync)(wrapper) } };
  }

  if (sub === "install") {
    const cli = deps.cliEntry ?? process.argv[1] ?? "";
    const cliPath = cli === "" ? "" : path.resolve(cli);
    if (cliPath === "" || !(deps.exists ?? existsSync)(cliPath)) return fail(command, "cli_entry_not_found: cannot locate the agenthost CLI entry to put in the wrapper");
    const node = deps.node ?? process.execPath;
    const content = wrapperContent(node, cliPath);
    const cmdValue = commandWord(wrapper);
    const planned = [
      ["get", MEDIA_KEYS, LIST_KEY],
      ["set", MEDIA_KEYS, LIST_KEY, "<current list plus our path>"],
      ["set", SLOT_SCHEMA, "name", NAME],
      ["set", SLOT_SCHEMA, "command", cmdValue],
      ["set", SLOT_SCHEMA, "binding", binding]
    ].map((a) => ["gsettings", ...a].join(" "));
    if (!apply) return { ok: true, command, data: { applied: false, wrapper, wrapperContent: content, binding, gsettings: planned, hint: "Run again with --apply to install." } };

    const list = await readList();
    if (list === undefined) return fail(command, "gsettings_failed: could not read the custom keybinding list");
    const present = list.includes(SLOT_PATH);
    let currentBinding: string | undefined;
    if (present) {
      const existing = await readKey("command");
      if (existing !== undefined && existing !== "" && existing !== cmdValue && existing !== wrapper) return fail(command, "binding_conflict: the AgentHost slot already has a different command; not overwritten", { existingCommand: existing });
      currentBinding = await readKey("binding");
      if (existing !== undefined && (existing === cmdValue || existing === wrapper) && currentBinding === binding) return { ok: true, command, data: { applied: false, alreadyInstalled: true, wrapper, binding } };
    }
    await mkdir(path.dirname(wrapper), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(wrapper), 0o700);
    await writeFile(wrapper, content, { mode: 0o700 });
    await chmod(wrapper, 0o700);
    const calls: string[][] = [];
    if (!present) calls.push(["set", MEDIA_KEYS, LIST_KEY, formatStringList([...list, SLOT_PATH])]);
    calls.push(["set", SLOT_SCHEMA, "name", NAME], ["set", SLOT_SCHEMA, "command", cmdValue], ["set", SLOT_SCHEMA, "binding", binding]);
    for (const call of calls) {
      const r = await gs(...call);
      if (r.status !== 0) return fail(command, `gsettings_failed: ${call.slice(0, 3).join(" ")}: ${r.stderr.trim()}`);
    }
    return { ok: true, command, data: { applied: true, wrapper, binding, keptEntries: list.length } };
  }

  // remove
  const planned = [
    ["get", MEDIA_KEYS, LIST_KEY],
    ["set", MEDIA_KEYS, LIST_KEY, "<current list without our path>"],
    ["reset", SLOT_SCHEMA, "name"], ["reset", SLOT_SCHEMA, "command"], ["reset", SLOT_SCHEMA, "binding"]
  ].map((a) => ["gsettings", ...a].join(" "));
  if (!apply) return { ok: true, command, data: { applied: false, wrapper, gsettings: planned, hint: "Run again with --apply to remove." } };
  const list = await readList();
  if (list === undefined) return fail(command, "gsettings_failed: could not read the custom keybinding list");
  const present = list.includes(SLOT_PATH);
  const calls: string[][] = [];
  if (present) calls.push(["set", MEDIA_KEYS, LIST_KEY, formatStringList(list.filter((item) => item !== SLOT_PATH))]);
  calls.push(["reset", SLOT_SCHEMA, "name"], ["reset", SLOT_SCHEMA, "command"], ["reset", SLOT_SCHEMA, "binding"]);
  for (const call of calls) {
    const r = await gs(...call);
    if (r.status !== 0) return fail(command, `gsettings_failed: ${call.slice(0, 3).join(" ")}: ${r.stderr.trim()}`);
  }
  await rm(wrapper, { force: true });
  return { ok: true, command, data: { applied: true, removed: present, wrapperRemoved: true, keptEntries: list.length - (present ? 1 : 0) } };
}
