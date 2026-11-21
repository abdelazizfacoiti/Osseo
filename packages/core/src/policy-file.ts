import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ConfirmationRecord } from "./confirmations.js";
import type { RiskLevel } from "./types.js";
import { stripBom } from "./text.js";

/*
 * policy.toml: the rules a person can read and change in one file.
 *
 * Precedence, which is fixed:
 *   1. Floors: the blocked tier, typing into password / OTP / card fields, and password-manager
 *      apps. No rule can change these.
 *   2. File rules, first match wins.
 *   3. The classifier's own decision.
 *
 * Only the host process writes this file. Its path is in the control plane, so an agent tool call
 * cannot write it.
 */

export const POLICY_ACTIONS = ["any", "send", "upload", "delete", "pay", "navigate", "type", "click"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];
export const POLICY_DECISIONS = ["allow", "ask", "never"] as const;
export type PolicyDecisionWord = (typeof POLICY_DECISIONS)[number];

export const POLICY_FILE_NAME = "policy.toml";
export const MAX_POLICY_NOTE = 200;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_POLICY_RULES = 500;

export interface PolicyRule {
  /** Patterns matched case-insensitively against the window's app name; `*` is a wildcard. */
  app?: string[];
  /** Host suffixes, browser tools only. */
  site?: string[];
  action: PolicyAction;
  decision: PolicyDecisionWord;
  note?: string;
  /** 1-based line of the `[[rule]]` header. */
  line: number;
  /** 1-based line of the last key of the rule. */
  endLine: number;
}

export class PolicyParseError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(`policy.toml line ${line}: ${message}`);
    this.name = "PolicyParseError";
    this.line = line;
  }
}

type Value = string | string[];

function scanString(text: string, start: number, line: number): { value: string; end: number } {
  // text[start] is the opening quote.
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index]!;
    if (char === "\"") return { value, end: index + 1 };
    if (char === "\\") {
      const next = text[index + 1];
      if (next === "\"" || next === "\\") value += next;
      else if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else throw new PolicyParseError(line, "unsupported escape in string (use \\\\, \\\" , \\n or \\t)");
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  throw new PolicyParseError(line, "string is not closed (strings stay on one line)");
}

function skipSpaces(text: string, index: number): number {
  let next = index;
  while (next < text.length && (text[next] === " " || text[next] === "\t")) next += 1;
  return next;
}

function parseValue(text: string, line: number): Value {
  let index = skipSpaces(text, 0);
  let value: Value;
  if (text[index] === "\"") {
    const scanned = scanString(text, index, line);
    value = scanned.value;
    index = scanned.end;
  } else if (text[index] === "[") {
    const items: string[] = [];
    index = skipSpaces(text, index + 1);
    while (true) {
      if (index >= text.length) throw new PolicyParseError(line, "array is not closed (arrays stay on one line)");
      if (text[index] === "]") { index += 1; break; }
      if (text[index] !== "\"") throw new PolicyParseError(line, "arrays may hold only strings");
      const scanned = scanString(text, index, line);
      items.push(scanned.value);
      index = skipSpaces(text, scanned.end);
      if (text[index] === ",") index = skipSpaces(text, index + 1);
      else if (text[index] !== "]") throw new PolicyParseError(line, "expected , or ] in array");
    }
    value = items;
  } else {
    throw new PolicyParseError(line, "values must be \"strings\" or [\"string\", \"arrays\"]");
  }
  index = skipSpaces(text, index);
  if (index < text.length && text[index] !== "#") throw new PolicyParseError(line, "unexpected text after the value");
  return value;
}

function asArray(value: Value): string[] {
  return Array.isArray(value) ? value : [value];
}

function validSite(site: string): boolean {
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(site);
}

/** Strict parser for the policy subset. Throws PolicyParseError with the line number. */
export function parsePolicy(text: string): PolicyRule[] {
  if (Buffer.byteLength(text, "utf8") > MAX_POLICY_BYTES) throw new PolicyParseError(1, "file is too large");
  const rules: PolicyRule[] = [];
  let current: { line: number; endLine: number; values: Map<string, Value>; keyLines: Map<string, number> } | undefined;

  const finish = (): void => {
    if (current === undefined) return;
    const { line, endLine, values, keyLines } = current;
    const at = (key: string): number => keyLines.get(key) ?? line;
    const action = values.get("action");
    const decision = values.get("decision");
    if (action === undefined) throw new PolicyParseError(line, "rule needs an action");
    if (decision === undefined) throw new PolicyParseError(line, "rule needs a decision");
    if (Array.isArray(action) || !(POLICY_ACTIONS as readonly string[]).includes(action)) {
      throw new PolicyParseError(at("action"), `action must be one of ${POLICY_ACTIONS.join(", ")}`);
    }
    if (Array.isArray(decision) || !(POLICY_DECISIONS as readonly string[]).includes(decision)) {
      throw new PolicyParseError(at("decision"), `decision must be one of ${POLICY_DECISIONS.join(", ")}`);
    }
    const note = values.get("note");
    if (Array.isArray(note)) throw new PolicyParseError(at("note"), "note must be a single string");
    if (note !== undefined && note.length > MAX_POLICY_NOTE) throw new PolicyParseError(at("note"), `note is longer than ${MAX_POLICY_NOTE} characters`);
    const rule: PolicyRule = { action: action as PolicyAction, decision: decision as PolicyDecisionWord, line, endLine };
    const app = values.get("app");
    if (app !== undefined) {
      const apps = asArray(app).map((entry) => entry.trim());
      if (apps.length === 0 || apps.some((entry) => entry.length === 0 || entry.length > 200)) throw new PolicyParseError(at("app"), "app must be a non-empty string of at most 200 characters");
      rule.app = apps;
    }
    const site = values.get("site");
    if (site !== undefined) {
      const sites = asArray(site).map((entry) => entry.trim().toLowerCase().replace(/^\*?\./, ""));
      if (sites.length === 0 || sites.some((entry) => !validSite(entry))) throw new PolicyParseError(at("site"), "site must be a host such as admin.shopify.com (no scheme or path)");
      rule.site = sites;
    }
    if (note !== undefined) rule.note = note;
    rules.push(rule);
    if (rules.length > MAX_POLICY_RULES) throw new PolicyParseError(line, `more than ${MAX_POLICY_RULES} rules`);
    current = undefined;
  };

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index]!;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      const header = trimmed.replace(/\s*#.*$/, "");
      if (header !== "[[rule]]") throw new PolicyParseError(lineNumber, "only [[rule]] tables are allowed");
      finish();
      current = { line: lineNumber, endLine: lineNumber, values: new Map(), keyLines: new Map() };
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) throw new PolicyParseError(lineNumber, "expected key = value");
    const key = trimmed.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) throw new PolicyParseError(lineNumber, `invalid key "${key.slice(0, 40)}"`);
    if (current === undefined) throw new PolicyParseError(lineNumber, "key outside a [[rule]] table");
    if (!["app", "site", "action", "decision", "note"].includes(key)) throw new PolicyParseError(lineNumber, `unknown key "${key}"`);
    if (current.values.has(key)) throw new PolicyParseError(lineNumber, `duplicate key "${key}"`);
    const value = parseValue(trimmed.slice(equals + 1), lineNumber);
    if (Array.isArray(value) && (key === "action" || key === "decision" || key === "note")) throw new PolicyParseError(lineNumber, `${key} must be a single string`);
    current.values.set(key, value);
    current.keyLines.set(key, lineNumber);
    current.endLine = lineNumber;
  }
  finish();
  return rules;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface PolicyTarget {
  /** The window's app name, when known. */
  app?: string | undefined;
  /** Host of the page, for browser tools only. A desktop call leaves this undefined, so site rules never match it. */
  site?: string | undefined;
}

/** Case-insensitive glob where `*` matches any run of characters. Linear time: no regular expression, so no backtracking blow-up. */
function wildcardMatches(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  let pi = 0;
  let vi = 0;
  let star = -1;
  let mark = 0;
  while (vi < v.length) {
    if (pi < p.length && p[pi] === "*") { star = pi; mark = vi; pi += 1; }
    else if (pi < p.length && p[pi] === v[vi]) { pi += 1; vi += 1; }
    else if (star >= 0) { pi = star + 1; mark += 1; vi = mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

export function hostMatchesSite(host: string, site: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === site || normalized.endsWith(`.${site}`);
}

export function ruleMatches(rule: PolicyRule, category: PolicyAction, target: PolicyTarget): boolean {
  if (rule.action !== "any" && rule.action !== category) return false;
  if (rule.app !== undefined) {
    const app = target.app;
    if (!rule.app.some((pattern) => pattern === "*" || (app !== undefined && wildcardMatches(pattern, app)))) return false;
  }
  if (rule.site !== undefined) {
    const site = target.site;
    if (site === undefined || !rule.site.some((entry) => hostMatchesSite(site, entry))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface PolicyClassification {
  riskLevel: RiskLevel;
  /** From the classifier: normal, communication, financial, credential_or_security, ... */
  appSensitivity?: string | undefined;
  /** The tool changes state. Reads and screenshots have no category. */
  stateChanging: boolean;
  externalEffect?: boolean | undefined;
  destructive?: boolean | undefined;
  communicative?: boolean | undefined;
  /** The classifier or the tool asked for an exact confirmation (for example a "Place order" click). */
  consequential?: boolean | undefined;
  /** The classifier's action type, when the caller has it (for example upload, file_delete). */
  actionType?: string | undefined;
  /** The preview summary, used only to tell a pay/delete click from a send click. */
  summary?: string | undefined;
}

const PAY_WORDS = /\b(pay|buy|purchase|order|checkout|check out|donate|transfer|withdraw)\b/i;
const DELETE_WORDS = /\b(delete|remove|erase)\b/i;

/**
 * The category a call falls in. The high-tier categories come from what the classifier already
 * knows (effect flags, app sensitivity, risk tier). Only type, navigate and click use the last
 * segment of the tool name, because nothing else tells them apart.
 */
export function actionCategory(tool: string, _input: unknown, classification: PolicyClassification): PolicyAction {
  // browser.own_click is the same kind of action as browser.click.
  const last = (tool.split(".").pop() ?? tool).replace(/^own_/, "");
  const readOnlyAction = classification.actionType === "observe" || classification.actionType === "inspect" || classification.actionType === "file_read";
  if (!classification.stateChanging || readOnlyAction) return "any";
  if (classification.destructive === true || classification.actionType === "file_delete" || last === "delete") return "delete";
  if (classification.actionType === "upload" || last === "upload" || last === "file_dialog_select") return "upload";
  if (classification.appSensitivity === "financial") return "pay";
  if (
    classification.appSensitivity === "communication"
    || classification.externalEffect === true
    || classification.communicative === true
    || classification.actionType === "communication_send"
  ) return "send";
  if (classification.consequential === true && (last === "click" || last === "activate")) {
    const summary = classification.summary ?? "";
    if (PAY_WORDS.test(summary)) return "pay";
    if (DELETE_WORDS.test(summary)) return "delete";
    return "send";
  }
  if (["type", "type_text", "set_field", "fill", "set_text"].includes(last)) return "type";
  if (last === "navigate" || last === "open_url") return "navigate";
  if (last === "click" || last === "activate") return "click";
  return "any";
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export type PolicySource = "floor" | "policy_rule" | "classifier";

export interface PolicyOutcome {
  source: PolicySource;
  category: PolicyAction;
  /** 1-based index of the deciding rule. */
  ruleIndex?: number;
  /** 1-based line of the deciding rule's `[[rule]]` header in policy.toml. */
  line?: number;
  note?: string;
  decision?: PolicyDecisionWord;
  /**
   * An allow rule downgrades an approval only when it names the action exactly, never through `any`.
   */
  exact?: boolean;
}

/** Built-in defaults when no policy file exists. The classifier already asks for these. */
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = (["send", "upload", "delete", "pay"] as const).map((action) => ({ action, decision: "ask" as const, line: 0, endLine: 0 }));

export function auditPolicySource(outcome: PolicyOutcome): string {
  if (outcome.source === "policy_rule" && outcome.line !== undefined) return `policy_rule:${outcome.line}`;
  return outcome.source;
}

export function decidePolicy(
  rules: readonly PolicyRule[],
  call: { tool: string; input: unknown; target: PolicyTarget; classification: PolicyClassification; floor?: boolean }
): PolicyOutcome {
  const category = actionCategory(call.tool, call.input, call.classification);
  if (call.floor === true || call.classification.riskLevel === "blocked") return { source: "floor", category };
  const index = rules.findIndex((rule) => ruleMatches(rule, category, call.target));
  if (index < 0) return { source: "classifier", category };
  const rule = rules[index]!;
  // Built-in defaults carry line 0: they describe the classifier, so they are reported as such.
  if (rule.line === 0) return { source: "classifier", category, decision: rule.decision, exact: rule.action === category };
  return {
    source: "policy_rule",
    category,
    ruleIndex: index + 1,
    line: rule.line,
    decision: rule.decision,
    exact: rule.action === category,
    ...(rule.note === undefined ? {} : { note: rule.note })
  };
}

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

export function policyFilePath(osseoDir: string): string {
  return path.join(osseoDir, POLICY_FILE_NAME);
}

export const DEFAULT_POLICY_TEXT = `# Osseo policy.
#
# Rules are checked from top to bottom. The first rule that matches decides.
# Each rule has an action and a decision. app and site are optional.
#
#   app      application name, any case; * is a wildcard        app = "Slack"
#   site     host suffix, browser tools only                    site = "admin.shopify.com"
#   action   any, send, upload, delete, pay, navigate, type, click
#   decision allow (no prompt), ask (prompt each time), never (refuse)
#   note     free text, up to ${MAX_POLICY_NOTE} characters, shown in the audit log
#
# Fixed floors that no rule can change: blocked actions stay blocked, password / one-time-code /
# card fields are never typed into, and password managers are never automated.
# An allow rule skips the prompt only for the action it names; allow with action = "any" does not.
# Without this file the same four asks apply.

[[rule]]
action = "send"
decision = "ask"

[[rule]]
action = "upload"
decision = "ask"

[[rule]]
action = "delete"
decision = "ask"

[[rule]]
action = "pay"
decision = "ask"

# Example: let the agent move around the Shopify admin without asking.
# [[rule]]
# site = "admin.shopify.com"
# action = "navigate"
# decision = "allow"
# note = "browsing is fine"
`;

/** Writes the commented default file when none exists. Never overwrites. Returns true when it wrote. */
export async function ensurePolicyFile(osseoDir: string): Promise<boolean> {
  try {
    await mkdir(osseoDir, { recursive: true, mode: 0o700 });
    await writeFile(policyFilePath(osseoDir), DEFAULT_POLICY_TEXT, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    return false;
  }
}

export interface LoadedPolicy {
  /** The rules in force: the file's rules, the last good set after a bad edit, or the built-in defaults. */
  rules: readonly PolicyRule[];
  exists: boolean;
  path: string;
  error?: { line: number; message: string };
}

const cache = new Map<string, { key: string; loaded: LoadedPolicy }>();

export function invalidatePolicyCache(osseoDir?: string): void {
  if (osseoDir === undefined) cache.clear();
  else cache.delete(path.resolve(osseoDir));
}

/** Reads policy.toml, again whenever its mtime or size changes. */
export async function loadPolicy(osseoDir: string): Promise<LoadedPolicy> {
  const file = policyFilePath(osseoDir);
  const dir = path.resolve(osseoDir);
  let info;
  try {
    info = await stat(file);
  } catch {
    cache.delete(dir);
    return { rules: DEFAULT_POLICY_RULES, exists: false, path: file };
  }
  const key = `${info.mtimeMs}:${info.size}`;
  const cached = cache.get(dir);
  if (cached?.key === key) return cached.loaded;
  let loaded: LoadedPolicy;
  try {
    const rules = parsePolicy(stripBom(await readFile(file, "utf8")));
    loaded = { rules, exists: true, path: file };
  } catch (error) {
    const line = error instanceof PolicyParseError ? error.line : 0;
    const message = error instanceof Error ? error.message : "policy.toml could not be read";
    // A bad edit keeps the last good rules (or the defaults); the classifier still protects everything.
    loaded = { rules: cached?.loaded.error === undefined ? (cached?.loaded.rules ?? DEFAULT_POLICY_RULES) : DEFAULT_POLICY_RULES, exists: true, path: file, error: { line, message } };
  }
  cache.set(dir, { key, loaded });
  return loaded;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

export interface NewPolicyRule {
  app?: string | undefined;
  site?: string | undefined;
  action: PolicyAction;
  decision: PolicyDecisionWord;
  note?: string | undefined;
}

export function renderRule(rule: NewPolicyRule): string {
  return [
    "[[rule]]",
    ...(rule.app === undefined ? [] : [`app = ${tomlString(rule.app)}`]),
    ...(rule.site === undefined ? [] : [`site = ${tomlString(rule.site)}`]),
    `action = ${tomlString(rule.action)}`,
    `decision = ${tomlString(rule.decision)}`,
    ...(rule.note === undefined ? [] : [`note = ${tomlString(rule.note)}`]),
    ""
  ].join("\n");
}

export function validateNewRule(rule: NewPolicyRule): string | undefined {
  if (!(POLICY_ACTIONS as readonly string[]).includes(rule.action)) return `action must be one of ${POLICY_ACTIONS.join(", ")}`;
  if (!(POLICY_DECISIONS as readonly string[]).includes(rule.decision)) return `decision must be one of ${POLICY_DECISIONS.join(", ")}`;
  if (rule.app !== undefined && (rule.app.trim().length === 0 || rule.app.length > 200 || /[\u0000-\u001f]/.test(rule.app))) return "app must be 1 to 200 printable characters";
  if (rule.site !== undefined && !validSite(rule.site.trim().toLowerCase().replace(/^\*?\./, ""))) return "site must be a host such as admin.shopify.com";
  if (rule.note !== undefined && rule.note.length > MAX_POLICY_NOTE) return `note is longer than ${MAX_POLICY_NOTE} characters`;
  return undefined;
}

/** Inserts a rule block before the first existing rule that already decides the same call, or at the end. */
export function insertRuleText(text: string, rule: NewPolicyRule): { text: string; index: number } {
  const rules = parsePolicy(text);
  const target: PolicyTarget = { app: rule.app, site: rule.site?.trim().toLowerCase().replace(/^\*?\./, "") };
  const position = rules.findIndex((existing) => ruleMatches(existing, rule.action, target));
  const block = renderRule({ ...rule, ...(rule.site === undefined ? {} : { site: rule.site.trim().toLowerCase().replace(/^\*?\./, "") }) });
  const lines = text.split("\n");
  if (position < 0) {
    const body = text.length === 0 || text.endsWith("\n") ? text : `${text}\n`;
    const separator = body.length === 0 || body.endsWith("\n\n") ? "" : "\n";
    const next = `${body}${separator}${block}`;
    return { text: next, index: rules.length + 1 };
  }
  // Keep a comment block that sits directly above the rule with that rule.
  let at = rules[position]!.line - 1;
  while (at > 0 && lines[at - 1]!.trim().startsWith("#")) at -= 1;
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  return { text: [...before, ...block.split("\n"), ...after].join("\n"), index: position + 1 };
}

/** Removes rule `index` (1-based) and the blank line after it. */
export function removeRuleText(text: string, index: number): string {
  const rules = parsePolicy(text);
  const rule = rules[index - 1];
  if (rule === undefined) throw new Error(`There is no rule ${index}. The file has ${rules.length}.`);
  const lines = text.split("\n");
  let end = rule.endLine; // 1-based, inclusive
  // The last element after a final newline is not a blank line of the file; keep it so the newline stays.
  if (end < lines.length - 1 && lines[end]?.trim() === "") end += 1;
  return [...lines.slice(0, rule.line - 1), ...lines.slice(end)].join("\n");
}

async function atomicWritePolicy(osseoDir: string, text: string): Promise<void> {
  parsePolicy(text); // never write a file the loader would reject
  await mkdir(osseoDir, { recursive: true, mode: 0o700 });
  const target = policyFilePath(osseoDir);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  invalidatePolicyCache(osseoDir);
}

async function readPolicyText(osseoDir: string): Promise<string> {
  try {
    return await readFile(policyFilePath(osseoDir), "utf8");
  } catch {
    return DEFAULT_POLICY_TEXT;
  }
}

export interface PolicyEdit { index: number; text: string; rule: NewPolicyRule }

/** Builds the edit without writing it (preview). */
export async function planAddRule(osseoDir: string, rule: NewPolicyRule): Promise<PolicyEdit> {
  const problem = validateNewRule(rule);
  if (problem !== undefined) throw new Error(problem);
  const inserted = insertRuleText(await readPolicyText(osseoDir), rule);
  return { index: inserted.index, text: inserted.text, rule };
}

export async function addRule(osseoDir: string, rule: NewPolicyRule): Promise<PolicyEdit> {
  const edit = await planAddRule(osseoDir, rule);
  await atomicWritePolicy(osseoDir, edit.text);
  return edit;
}

export async function removeRule(osseoDir: string, index: number): Promise<void> {
  const text = await readPolicyText(osseoDir);
  await atomicWritePolicy(osseoDir, removeRuleText(text, index));
}

export type AlwaysAllowResult =
  | { written: true; index: number; rule: NewPolicyRule }
  | { written: false; reason: "no_category" | "not_approvable" | "blocked" | "unknown_app" | "already_allowed" | "policy_invalid" | "write_failed"; message: string };

export const ALWAYS_ALLOW_NOTE = "added from an approval prompt";
/** Only these ever need an approval, so only these can be remembered. */
export const REMEMBERABLE_ACTIONS: readonly PolicyAction[] = ["send", "upload", "delete", "pay"];

/**
 * Writes the one rule behind "Always allow here". The caller has already shown the person the
 * prompt and got a physical or chat answer; this only turns the answer into a rule.
 */
export async function applyAlwaysAllow(
  osseoDir: string,
  record: { appName?: string | undefined; site?: string | undefined; category?: string | undefined }
): Promise<AlwaysAllowResult> {
  const category = record.category;
  if (category === undefined || category === "any" || !(POLICY_ACTIONS as readonly string[]).includes(category)) {
    return { written: false, reason: "no_category", message: "This kind of action has no category a rule can name, so it was approved once only." };
  }
  if (!(REMEMBERABLE_ACTIONS as readonly string[]).includes(category)) {
    return { written: false, reason: "not_approvable", message: `${category} actions never need an approval, so there is nothing to remember. Approved once only.` };
  }
  const app = record.appName?.trim();
  const site = record.site?.trim();
  const hasSite = site !== undefined && site.length > 0;
  const hasApp = app !== undefined && app.length > 0;
  if ((!hasApp && !hasSite) || (hasApp && (app.includes("*") || validateNewRule({ app, action: "any", decision: "allow" }) !== undefined))) {
    return { written: false, reason: "unknown_app", message: "The app is not known, so it was approved once only." };
  }
  const rule: NewPolicyRule = {
    ...(hasApp ? { app } : {}),
    ...(hasSite ? { site } : {}),
    action: category as PolicyAction,
    decision: "allow",
    note: ALWAYS_ALLOW_NOTE
  };
  const problem = validateNewRule(rule);
  if (problem !== undefined) return { written: false, reason: "policy_invalid", message: `${problem}. Approved once only.` };
  try {
    const text = await readPolicyText(osseoDir);
    const existing = parsePolicy(text);
    const target: PolicyTarget = { app: hasApp ? app : undefined, site: hasSite ? site.toLowerCase().replace(/^\*?\./, "") : undefined };
    const decided = existing.find((entry) => ruleMatches(entry, category as PolicyAction, target));
    if (decided?.decision === "allow" && decided.action === category) {
      return { written: false, reason: "already_allowed", message: "A rule already allows this, so it was approved once only." };
    }
    const edit = await addRule(osseoDir, rule);
    return { written: true, index: edit.index, rule };
  } catch (error) {
    const invalid = error instanceof PolicyParseError;
    return { written: false, reason: invalid ? "policy_invalid" : "write_failed", message: invalid ? `${error.message}. Fix policy.toml first. Approved once only.` : "policy.toml could not be written. Approved once only." };
  }
}

/** The one function all three surfaces (chat, card, CLI) call after the person chose "Always allow here". */
export async function alwaysAllowFromConfirmation(
  osseoDir: string,
  record: Pick<ConfirmationRecord, "policyTarget" | "riskLevel">
): Promise<AlwaysAllowResult> {
  if (record.riskLevel === "blocked") {
    return { written: false, reason: "blocked", message: "Blocked actions cannot be allowed by a rule. Approved once only." };
  }
  const target = record.policyTarget;
  if (target === undefined) {
    return { written: false, reason: "no_category", message: "This approval did not record what it was about, so it was approved once only." };
  }
  return applyAlwaysAllow(osseoDir, { appName: target.app, site: target.site, category: target.category });
}

export function describeRule(rule: PolicyRule, index: number): string {
  const parts = [`${index}.`, rule.decision.toUpperCase(), rule.action];
  if (rule.app !== undefined) parts.push(`app=${rule.app.join("|")}`);
  if (rule.site !== undefined) parts.push(`site=${rule.site.join("|")}`);
  if (rule.note !== undefined) parts.push(`# ${rule.note}`);
  return parts.join(" ");
}
