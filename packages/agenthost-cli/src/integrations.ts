import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexNotifyLine, codexNotifyAdd, codexNotifyRemove, codexNotifyState } from "./codex-notify.js";

export const INTEGRATION_TARGETS = ["opencode", "claude", "codex", "copilot", "copilot-cli", "cursor"] as const;
export type IntegrationTarget = (typeof INTEGRATION_TARGETS)[number];
export type IntegrationAction = "status" | "add" | "remove";

export interface IntegrationPaths {
  home: string;
  project: string;
  xdgConfigHome?: string;
  codexHome?: string;
  copilotHome?: string;
  /** Claude Code's CLAUDE_CONFIG_DIR, when set. Holds `.claude.json` and `settings.json` instead of the home folder. */
  claudeConfigDir?: string;
  /** Defaults to the host platform. Windows starts the server through `cmd /c agenthost start`. */
  platform?: NodeJS.Platform;
}

/** Whether a command is on PATH. On Windows the file has a PATHEXT extension (claude.exe, agenthost.cmd). */
export function commandOnPath(command: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  const names = platform === "win32"
    ? [command, ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "").map((ext) => `${command}${ext.toLowerCase()}`)]
    : [command];
  return (env.PATH ?? "").split(path.delimiter).some((dir) => dir !== "" && names.some((name) => existsSync(path.join(dir, name))));
}

/** The CLI this copy runs from: the release's bin wrapper (it sets the release root) or the built CLI in a checkout. */
function cliEntry(): string {
  const wrapper = fileURLToPath(new URL("../../../bin/agenthost.mjs", import.meta.url));
  if (existsSync(wrapper)) return wrapper;
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/**
 * How a client starts the server. On Windows `agenthost` is a .cmd file, and clients that launch the
 * program directly (without a shell) cannot run a .cmd by its bare name, so the entry goes through cmd.exe.
 * With no `agenthost` on PATH (a checkout, or a terminal opened before the install), this copy runs under node.
 */
export function serverCommand(platform: NodeJS.Platform = process.platform, onPath: (command: string) => boolean = (command) => commandOnPath(command, platform)): { command: string; args: string[] } {
  if (platform !== "win32") return { command: "agenthost", args: ["start"] };
  if (onPath("agenthost")) return { command: "cmd", args: ["/c", "agenthost", "start"] };
  return { command: process.execPath, args: [cliEntry(), "start"] };
}

/** The Codex `notify` key that raises the terminal when a turn ends. */
export interface CodexNotifyReport {
  /** Our notify command is the one set. */
  configured: boolean;
  changed: boolean;
  applied: boolean;
  reason?: string;
}

export interface IntegrationReport {
  target: IntegrationTarget;
  configPath: string;
  configLabel: string;
  configured: boolean;
  matches: boolean;
  changed: boolean;
  applied: boolean;
  backup: boolean;
  proposed?: unknown;
  codexNotify?: CodexNotifyReport;
  error?: string;
}

type Json = Record<string, unknown>;

const LABELS: Record<IntegrationTarget, string> = {
  opencode: "[opencode-config]",
  claude: "[claude-config]",
  codex: "[codex-config]",
  copilot: "[copilot-config]",
  "copilot-cli": "[copilot-cli-config]",
  cursor: "[cursor-config]"
};

const CODEX_HEADER = "[mcp_servers.agenthost]";
function codexEntry(platform: NodeJS.Platform | undefined): string {
  const server = serverCommand(platform);
  return `${CODEX_HEADER}\ncommand = ${JSON.stringify(server.command)}\nargs = [${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]\n`;
}

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const next = text[index + 1];
    if (inLine) {
      if (character === "\n") {
        inLine = false;
        output += character;
      }
      continue;
    }
    if (inBlock) {
      if (character === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function stripTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let cursor = index + 1;
      while (cursor < text.length && /\s/.test(text[cursor]!)) cursor += 1;
      if (text[cursor] === "}" || text[cursor] === "]") continue;
    }
    output += character;
  }
  return output;
}

function parseJsonConfig(text: string): Json | undefined {
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text))) as unknown;
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isStartCommand(command: unknown, args: unknown[]): boolean {
  if (typeof command !== "string") return false;
  // path.win32 also splits on "/" and "\\", so it reads a Windows path on any host.
  const base = path.win32.basename(command).replace(/\.(cmd|exe)$/iu, "");
  if ((base === "agenthost" || base === "agenthost.mjs") && args.includes("start")) return true;
  // Windows: cmd /c agenthost start
  return base.toLowerCase() === "cmd" && args[0]?.toString().toLowerCase() === "/c" && args[1] === "agenthost" && args.includes("start");
}

/**
 * A checkout registers the server by its path (`node <repo>/packages/mcp-server/dist/index.js`, which the setup guide
 * prints when there is no `agenthost` on PATH). That is still AgentHost, so the status check must count it.
 */
function isMcpServerEntry(command: unknown, args: unknown[]): boolean {
  if (typeof command !== "string") return false;
  if (path.win32.basename(command).replace(/\.exe$/iu, "").toLowerCase() !== "node") return false;
  const entry = args.find((arg): arg is string => typeof arg === "string" && !arg.startsWith("-"));
  return entry !== undefined && /mcp-server[\\/]dist[\\/]index\.js$/iu.test(entry);
}

/** `node <this CLI or its release wrapper> start`: the form serverCommand writes when there is no agenthost on PATH. */
function isNodeCliStart(command: unknown, args: unknown[]): boolean {
  if (typeof command !== "string") return false;
  if (path.win32.basename(command).replace(/\.exe$/iu, "").toLowerCase() !== "node") return false;
  const entry = args.find((arg): arg is string => typeof arg === "string" && !arg.startsWith("-"));
  return entry !== undefined && /(agenthost-cli[\\/](dist|src)[\\/]index\.js|bin[\\/]agenthost\.mjs)$/iu.test(entry) && args.includes("start");
}

function isAgentHostEntry(entry: unknown): boolean {
  if (!isObject(entry) || entry.enabled === false) return false;
  if (typeof entry.command === "string") {
    const args = Array.isArray(entry.args) ? entry.args : [];
    return isStartCommand(entry.command, args) || isMcpServerEntry(entry.command, args) || isNodeCliStart(entry.command, args);
  }
  if (Array.isArray(entry.command)) {
    const [command, ...args] = entry.command;
    return isStartCommand(command, args);
  }
  return false;
}

export function integrationConfigPath(target: IntegrationTarget, paths: IntegrationPaths): string {
  switch (target) {
    case "opencode": {
      const directory = path.join(paths.xdgConfigHome ?? path.join(paths.home, ".config"), "opencode");
      const jsonc = path.join(directory, "opencode.jsonc");
      return existsSync(jsonc) ? jsonc : path.join(directory, "opencode.json");
    }
    case "claude": return path.join(paths.claudeConfigDir ?? paths.home, ".claude.json");
    case "codex": return path.join(paths.codexHome ?? path.join(paths.home, ".codex"), "config.toml");
    case "copilot": return path.join(paths.project, ".vscode", "mcp.json");
    case "copilot-cli": return path.join(paths.copilotHome ?? path.join(paths.home, ".copilot"), "mcp-config.json");
    case "cursor": return path.join(paths.project, ".cursor", "mcp.json");
  }
}

async function writePrivate(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function backup(file: string, content: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  await writePrivate(`${file}.agenthost.bak`, content);
  return true;
}

function jsonContainer(root: Json, target: IntegrationTarget, paths: IntegrationPaths): { container: Json; entry: Json } | undefined {
  if (target === "opencode") {
    if (root.mcp !== undefined && !isObject(root.mcp)) return undefined;
    const mcp = isObject(root.mcp) ? root.mcp : {};
    root.mcp = mcp;
    const server = serverCommand(paths.platform);
    return { container: mcp, entry: { type: "local", command: [server.command, ...server.args] } };
  }
  const key = target === "copilot" ? "servers" : "mcpServers";
  if (root[key] !== undefined && !isObject(root[key])) return undefined;
  const container = isObject(root[key]) ? root[key] as Json : {};
  root[key] = container;
  const server = serverCommand(paths.platform);
  const entry = target === "copilot"
    ? { type: "stdio", command: server.command, args: server.args }
    : target === "copilot-cli"
      ? { type: "local", command: server.command, args: server.args, tools: ["*"] }
      : { command: server.command, args: server.args };
  return { container, entry };
}

function codexBlock(text: string): { start: number; end: number } | undefined {
  const match = /^\[mcp_servers\.agenthost\][ \t\r]*$/m.exec(text);
  if (match === null) return undefined;
  const start = match.index;
  const next = text.indexOf("\n[", start + match[0].length);
  return { start, end: next < 0 ? text.length : next };
}

function codexUnsupported(text: string): boolean {
  return text.length > 2_000_000
    || text.includes("\u0000")
    || text.split("\n").some((line) => line.trimStart().startsWith("[") && !line.trim().endsWith("]"));
}

function codexMatches(text: string, platform: NodeJS.Platform | undefined): boolean {
  const block = codexBlock(text);
  if (block === undefined) return false;
  const section = text.slice(block.start, block.end);
  const linux = /^command\s*=\s*"agenthost"\s*$/m.test(section) && /^args\s*=\s*\["start"\]\s*$/m.test(section);
  const windows = /^command\s*=\s*"cmd"\s*$/m.test(section) && /^args\s*=\s*\["\/c",\s*"agenthost",\s*"start"\]\s*$/m.test(section);
  return (platform ?? process.platform) === "win32" ? windows : linux;
}

function report(target: IntegrationTarget, configPath: string, values: Omit<IntegrationReport, "target" | "configPath" | "configLabel">): IntegrationReport {
  return {
    target,
    configPath,
    configLabel: LABELS[target],
    ...values,
    ...(values.proposed === undefined ? {} : { proposed: values.proposed })
  };
}

async function readConfig(file: string): Promise<{ text: string; existed: boolean }> {
  if (!existsSync(file)) return { text: "", existed: false };
  // Windows editors often save a byte order mark; JSON.parse rejects it.
  return { text: (await readFile(file, "utf8")).replace(/^\uFEFF/u, ""), existed: true };
}

async function jsonStatus(target: IntegrationTarget, paths: IntegrationPaths): Promise<IntegrationReport> {
  const file = integrationConfigPath(target, paths);
  const { text } = await readConfig(file);
  const root = text.trim() === "" ? {} : parseJsonConfig(text);
  if (root === undefined) return report(target, file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_invalid_json" });
  const container = jsonContainer(root, target, paths);
  if (container === undefined) return report(target, file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_unsupported" });
  const existing = container.container.agenthost;
  return report(target, file, { configured: existing !== undefined, matches: isAgentHostEntry(existing), changed: false, applied: false, backup: false });
}

async function jsonAdd(target: IntegrationTarget, paths: IntegrationPaths, apply: boolean): Promise<IntegrationReport> {
  const file = integrationConfigPath(target, paths);
  const { text } = await readConfig(file);
  const root = text.trim() === "" ? {} : parseJsonConfig(text);
  if (root === undefined) return report(target, file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_invalid_json" });
  const container = jsonContainer(root, target, paths);
  if (container === undefined) return report(target, file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_unsupported" });
  const existing = container.container.agenthost;
  if (isAgentHostEntry(existing)) return report(target, file, { configured: true, matches: true, changed: false, applied: false, backup: false });
  const wasConfigured = existing !== undefined;
  container.container.agenthost = container.entry;
  const updated = `${JSON.stringify(root, null, 2)}\n`;
  const changed = updated !== text;
  if (!apply || !changed) return report(target, file, { configured: wasConfigured, matches: false, changed, applied: false, backup: false, proposed: container.entry });
  const backedUp = await backup(file, text);
  await writePrivate(file, updated);
  return report(target, file, { configured: true, matches: true, changed: true, applied: true, backup: backedUp, proposed: container.entry });
}

async function jsonRemove(target: IntegrationTarget, paths: IntegrationPaths, apply: boolean): Promise<IntegrationReport> {
  const file = integrationConfigPath(target, paths);
  const { text } = await readConfig(file);
  const root = text.trim() === "" ? {} : parseJsonConfig(text);
  if (root === undefined) return report(target, file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_invalid_json" });
  const container = jsonContainer(root, target, paths);
  if (container === undefined) return report(target, file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_unsupported" });
  const existing = container.container.agenthost;
  if (existing === undefined) return report(target, file, { configured: false, matches: false, changed: false, applied: false, backup: false });
  delete container.container.agenthost;
  const updated = `${JSON.stringify(root, null, 2)}\n`;
  if (!apply) return report(target, file, { configured: true, matches: isAgentHostEntry(existing), changed: true, applied: false, backup: false });
  const backedUp = await backup(file, text);
  await writePrivate(file, updated);
  return report(target, file, { configured: false, matches: false, changed: true, applied: true, backup: backedUp });
}

const FOREIGN_NOTIFY = "A different notify program is already set in the Codex config; it was left unchanged.";

function notifyReport(text: string, updated: string, apply: boolean, action: "add" | "remove"): CodexNotifyReport {
  const before = codexNotifyState(text);
  const after = codexNotifyState(updated);
  const changed = updated !== text;
  const foreign = before.present && !before.ours;
  return {
    configured: after.matches,
    changed,
    applied: apply && changed,
    ...(foreign && action === "add" ? { reason: FOREIGN_NOTIFY } : {})
  };
}

async function codexStatus(paths: IntegrationPaths): Promise<IntegrationReport> {
  const file = integrationConfigPath("codex", paths);
  const { text } = await readConfig(file);
  if (text !== "" && codexUnsupported(text)) return report("codex", file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_unsupported_or_invalid" });
  const state = codexNotifyState(text);
  const codexNotify: CodexNotifyReport = { configured: state.matches, changed: false, applied: false, ...(state.present && !state.ours ? { reason: FOREIGN_NOTIFY } : {}) };
  return report("codex", file, { configured: codexBlock(text) !== undefined, matches: codexMatches(text, paths.platform), changed: false, applied: false, backup: false, codexNotify });
}

async function codexAdd(paths: IntegrationPaths, apply: boolean): Promise<IntegrationReport> {
  const file = integrationConfigPath("codex", paths);
  const { text } = await readConfig(file);
  if (text !== "" && codexUnsupported(text)) return report("codex", file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_unsupported_or_invalid" });
  const block = codexBlock(text);
  // One read, one write: the MCP entry and the notify key share a single backup of the original file.
  const withEntry = codexMatches(text, paths.platform)
    ? text
    : block === undefined
      ? `${text.trimEnd()}${text.trim().length > 0 ? "\n\n" : ""}${codexEntry(paths.platform)}`
      : `${text.slice(0, block.start)}${codexEntry(paths.platform)}${text.slice(block.end).replace(/^\n+/, "\n")}`;
  const updated = codexNotifyAdd(withEntry, paths.platform).text;
  const codexNotify = notifyReport(withEntry, updated, apply, "add");
  const proposed = { ...serverCommand(paths.platform), notify: codexNotifyLine(paths.platform) };
  const changed = updated !== text;
  if (!changed) return report("codex", file, { configured: true, matches: true, changed: false, applied: false, backup: false, codexNotify });
  if (!apply) return report("codex", file, { configured: block !== undefined, matches: codexMatches(text, paths.platform), changed: true, applied: false, backup: false, proposed, codexNotify });
  const backedUp = await backup(file, text);
  await writePrivate(file, updated);
  return report("codex", file, { configured: true, matches: true, changed: true, applied: true, backup: backedUp, proposed, codexNotify });
}

async function codexRemove(paths: IntegrationPaths, apply: boolean): Promise<IntegrationReport> {
  const file = integrationConfigPath("codex", paths);
  const { text } = await readConfig(file);
  if (text !== "" && codexUnsupported(text)) return report("codex", file, { configured: false, matches: false, changed: false, applied: false, backup: false, error: "config_unsupported_or_invalid" });
  const block = codexBlock(text);
  const withoutEntry = block === undefined ? text : `${text.slice(0, block.start)}${text.slice(block.end).replace(/^\n+/, "\n")}`.trimEnd() + "\n";
  const updated = codexNotifyRemove(withoutEntry).text;
  const codexNotify = notifyReport(withoutEntry, updated, apply, "remove");
  if (updated === text) return report("codex", file, { configured: false, matches: false, changed: false, applied: false, backup: false, codexNotify });
  if (!apply) return report("codex", file, { configured: block !== undefined, matches: codexMatches(text, paths.platform), changed: true, applied: false, backup: false, codexNotify });
  const backedUp = await backup(file, text);
  await writePrivate(file, updated);
  return report("codex", file, { configured: false, matches: false, changed: true, applied: true, backup: backedUp, codexNotify });
}

export async function integrationStatus(target: IntegrationTarget, paths: IntegrationPaths): Promise<IntegrationReport> {
  if (target === "codex") return await codexStatus(paths);
  return await jsonStatus(target, paths);
}

export async function integrationAdd(target: IntegrationTarget, paths: IntegrationPaths, apply: boolean): Promise<IntegrationReport> {
  if (target === "codex") return await codexAdd(paths, apply);
  return await jsonAdd(target, paths, apply);
}

export async function integrationRemove(target: IntegrationTarget, paths: IntegrationPaths, apply: boolean): Promise<IntegrationReport> {
  if (target === "codex") return await codexRemove(paths, apply);
  return await jsonRemove(target, paths, apply);
}

export function publicIntegrationReport(value: IntegrationReport): Omit<IntegrationReport, "configPath"> {
  const { configPath: _configPath, ...rest } = value;
  return rest;
}
