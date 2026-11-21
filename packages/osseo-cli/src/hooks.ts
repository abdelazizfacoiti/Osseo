import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/*
 * Claude Code attention hooks. Permission prompts happen inside the client
 * before any MCP call reaches Osseo, so the client itself must tell
 * Osseo to raise its terminal. Entries are recognised by the
 * "osseo attention" command text, so add/remove never touch user hooks.
 */

type Json = Record<string, unknown>;
type HookEntry = { matcher?: string; hooks: Array<{ type: "command"; command: string; timeout?: number }> };

const MARKER = "osseo attention";
const REQUEST = "osseo attention request --source claude-code --reason permission";
// Claude finished its turn (done), or is asking you something / waiting for your reply (idle).
const REQUEST_DONE = "osseo attention request --source claude-code --reason done";
const REQUEST_IDLE = "osseo attention request --source claude-code --reason idle";
// PostToolUse runs after every tool call; the shell guard keeps it to a stat()
// unless an attention record is actually pending.
const CLEAR = "[ -f \"${OSSEO_HOME:-$HOME/.osseo}/run/attention.json\" ] && osseo attention clear --restore || true";

// Windows: hook commands run in whatever shell the client uses (Git Bash, PowerShell or cmd), so the
// command is a plain program call with no shell syntax. `attention clear` returns at once when nothing
// is pending; the cost is one short Node start per tool call.
const CLEAR_PORTABLE = "osseo attention clear --restore";

export function claudeAttentionHooks(platform: NodeJS.Platform = process.platform): Record<string, HookEntry[]> {
  if (platform !== "win32") return CLAUDE_ATTENTION_HOOKS;
  return {
    ...CLAUDE_ATTENTION_HOOKS,
    PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: CLEAR_PORTABLE, timeout: 5 }] }]
  };
}

export const CLAUDE_ATTENTION_HOOKS: Record<string, HookEntry[]> = {
  PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: REQUEST, timeout: 5 }] }],
  // The question tool: Claude asks you to choose or type something.
  PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: REQUEST_IDLE, timeout: 5 }] }],
  // The turn ended: the operation is done and Claude waits for your next message.
  Stop: [{ hooks: [{ type: "command", command: REQUEST_DONE, timeout: 5 }] }],
  Notification: [
    { matcher: "permission_prompt", hooks: [{ type: "command", command: REQUEST, timeout: 5 }] },
    { matcher: "idle_prompt", hooks: [{ type: "command", command: REQUEST_IDLE, timeout: 5 }] }
  ],
  PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: CLEAR, timeout: 5 }] }]
};

export interface HookReport {
  settingsLabel: "[claude-settings]";
  configured: boolean;
  changed: boolean;
  applied: boolean;
  backup: boolean;
  error?: string;
}

/** `configDir` is Claude Code's CLAUDE_CONFIG_DIR when set; it replaces `<home>/.claude`. */
export function claudeSettingsPath(home: string, configDir?: string): string {
  return path.join(configDir ?? path.join(home, ".claude"), "settings.json");
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOurs(entry: unknown): boolean {
  return isObject(entry) && Array.isArray(entry.hooks) && entry.hooks.some((hook) => isObject(hook) && typeof hook.command === "string" && hook.command.includes(MARKER));
}

function withoutOurs(hooks: Json): Json {
  const next: Json = {};
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = Array.isArray(entries) ? entries.filter((entry) => !isOurs(entry)) : entries;
    if (!Array.isArray(kept) || kept.length > 0) next[event] = kept;
  }
  return next;
}

function hasAll(hooks: Json, platform: NodeJS.Platform): boolean {
  return Object.entries(claudeAttentionHooks(platform)).every(([event, wanted]) => {
    const entries = hooks[event];
    return Array.isArray(entries) && wanted.every((entry) => entries.some((existing) => JSON.stringify(existing) === JSON.stringify(entry)));
  });
}

async function load(file: string): Promise<{ text: string; root: Json | undefined }> {
  if (!existsSync(file)) return { text: "", root: {} };
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/u, "");
  if (text.trim() === "") return { text, root: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    return { text, root: isObject(parsed) ? parsed : undefined };
  } catch {
    return { text, root: undefined };
  }
}

async function writePrivate(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function save(file: string, text: string, root: Json): Promise<boolean> {
  const backedUp = existsSync(file);
  if (backedUp) await writePrivate(`${file}.osseo.bak`, text);
  await writePrivate(file, `${JSON.stringify(root, null, 2)}\n`);
  return backedUp;
}

export interface HookOptions {
  /** CLAUDE_CONFIG_DIR */
  configDir?: string;
  platform?: NodeJS.Platform;
}

export async function claudeHooksStatus(home: string, options: HookOptions = {}): Promise<HookReport> {
  const { root } = await load(claudeSettingsPath(home, options.configDir));
  if (root === undefined) return { settingsLabel: "[claude-settings]", configured: false, changed: false, applied: false, backup: false, error: "settings_invalid_json" };
  return { settingsLabel: "[claude-settings]", configured: isObject(root.hooks) && hasAll(root.hooks, options.platform ?? process.platform), changed: false, applied: false, backup: false };
}

export async function claudeHooksAdd(home: string, apply: boolean, options: HookOptions = {}): Promise<HookReport> {
  const platform = options.platform ?? process.platform;
  const file = claudeSettingsPath(home, options.configDir);
  const { text, root } = await load(file);
  if (root === undefined) return { settingsLabel: "[claude-settings]", configured: false, changed: false, applied: false, backup: false, error: "settings_invalid_json" };
  if (root.hooks !== undefined && !isObject(root.hooks)) return { settingsLabel: "[claude-settings]", configured: false, changed: false, applied: false, backup: false, error: "settings_hooks_unsupported" };
  const current = isObject(root.hooks) ? root.hooks : {};
  if (hasAll(current, platform)) return { settingsLabel: "[claude-settings]", configured: true, changed: false, applied: false, backup: false };
  // Replace any older Osseo entries so upgrades never leave duplicates.
  const hooks = withoutOurs(current);
  for (const [event, entries] of Object.entries(claudeAttentionHooks(platform))) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), ...entries];
  }
  if (!apply) return { settingsLabel: "[claude-settings]", configured: false, changed: true, applied: false, backup: false };
  const backup = await save(file, text, { ...root, hooks });
  return { settingsLabel: "[claude-settings]", configured: true, changed: true, applied: true, backup };
}

export async function claudeHooksRemove(home: string, apply: boolean, options: HookOptions = {}): Promise<HookReport> {
  const file = claudeSettingsPath(home, options.configDir);
  const { text, root } = await load(file);
  if (root === undefined) return { settingsLabel: "[claude-settings]", configured: false, changed: false, applied: false, backup: false, error: "settings_invalid_json" };
  if (!isObject(root.hooks) || !Object.values(root.hooks).some((entries) => Array.isArray(entries) && entries.some(isOurs))) {
    return { settingsLabel: "[claude-settings]", configured: false, changed: false, applied: false, backup: false };
  }
  if (!apply) return { settingsLabel: "[claude-settings]", configured: true, changed: true, applied: false, backup: false };
  const hooks = withoutOurs(root.hooks);
  const next: Json = { ...root, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  const backup = await save(file, text, next);
  return { settingsLabel: "[claude-settings]", configured: false, changed: true, applied: true, backup };
}

/*
 * Claude Code permission rules for Osseo's own tools. Without them, auto mode can block Osseo calls
 * ("Undermining Oversight") and default mode asks for each call. Osseo still asks the person before sends,
 * uploads, deletes and payments; these rules only stop Claude Code asking a second time.
 *   read: tools that look but change nothing (status, windows, see, wait)
 *   all:  the whole Osseo server
 */
export type AllowLevel = "read" | "all";
export const OSSEO_ALLOW_RULES: Record<AllowLevel, string[]> = {
  read: ["mcp__osseo__status", "mcp__osseo__windows", "mcp__osseo__see", "mcp__osseo__wait"],
  all: ["mcp__osseo"]
};
const ALL_OUR_RULES = new Set([...OSSEO_ALLOW_RULES.read, ...OSSEO_ALLOW_RULES.all]);

export interface AllowReport { level: AllowLevel; rules: string[]; configured: boolean; changed: boolean; applied: boolean; backup: boolean; error?: string }

export async function claudeAllowAdd(home: string, level: AllowLevel, apply: boolean, options: HookOptions = {}): Promise<AllowReport> {
  const rules = OSSEO_ALLOW_RULES[level];
  const file = claudeSettingsPath(home, options.configDir);
  const { text, root } = await load(file);
  const base = { level, rules, configured: false, changed: false, applied: false, backup: false };
  if (root === undefined) return { ...base, error: "settings_invalid_json" };
  if (root.permissions !== undefined && !isObject(root.permissions)) return { ...base, error: "settings_permissions_unsupported" };
  const permissions: Json = isObject(root.permissions) ? { ...root.permissions } : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((rule): rule is string => typeof rule === "string") : [];
  if (rules.every((rule) => allow.includes(rule))) return { ...base, configured: true };
  // Switching between read and all replaces our earlier rules; the person's other rules stay.
  permissions.allow = [...allow.filter((rule) => !ALL_OUR_RULES.has(rule)), ...rules];
  if (!apply) return { ...base, changed: true };
  const backup = await save(file, text, { ...root, permissions });
  return { ...base, configured: true, changed: true, applied: true, backup };
}

export async function claudeAllowRemove(home: string, apply: boolean, options: HookOptions = {}): Promise<{ changed: boolean; applied: boolean; error?: string }> {
  const file = claudeSettingsPath(home, options.configDir);
  const { text, root } = await load(file);
  if (root === undefined) return { changed: false, applied: false, error: "settings_invalid_json" };
  if (!isObject(root.permissions) || !Array.isArray(root.permissions.allow)) return { changed: false, applied: false };
  const allow = root.permissions.allow as unknown[];
  const kept = allow.filter((rule) => typeof rule !== "string" || !ALL_OUR_RULES.has(rule));
  if (kept.length === allow.length) return { changed: false, applied: false };
  if (!apply) return { changed: true, applied: false };
  await save(file, text, { ...root, permissions: { ...root.permissions, allow: kept } });
  return { changed: true, applied: true };
}
