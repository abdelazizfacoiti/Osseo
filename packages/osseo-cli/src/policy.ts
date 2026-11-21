import {
  POLICY_ACTIONS,
  POLICY_DECISIONS,
  PolicyParseError,
  loadPolicy,
  parsePolicy,
  planAddRule,
  policyFilePath,
  removeRule,
  addRule,
  renderRule,
  removeRuleText,
  type NewPolicyRule,
  type PolicyAction
} from "@osseo/core";
import { readFile } from "node:fs/promises";
import type { parseFlags } from "./flags.js";

/*
 * `osseo policy list | add | remove`: the terminal view of policy.toml. Add and remove show a
 * preview unless --apply is given, and writes go through the core's atomic, validated writer.
 */

type Flags = ReturnType<typeof parseFlags>;
export type PolicyOutput = { ok: boolean; command: string; data?: unknown; error?: string };

const fail = (command: string, error: string): PolicyOutput => ({ ok: false, command, error });

function ruleLine(rule: { line: number; decision: string; action: string; app?: string[] | undefined; site?: string[] | undefined; note?: string | undefined }): string {
  const parts = [`line ${rule.line}`, rule.decision.toUpperCase(), rule.action];
  if (rule.app !== undefined) parts.push(`app=${rule.app.join("|")}`);
  if (rule.site !== undefined) parts.push(`site=${rule.site.join("|")}`);
  if (rule.note !== undefined) parts.push(`# ${rule.note}`);
  return parts.join("  ");
}

async function list(agentHome: string, json: boolean): Promise<PolicyOutput> {
  const loaded = await loadPolicy(agentHome);
  if (!loaded.exists) {
    const note = `There is no policy.toml at ${loaded.path}. The built-in rules apply: ask before send, upload, delete and pay.`;
    return { ok: true, command: "policy list", data: json ? { exists: false, path: loaded.path, rules: [], note } : note };
  }
  if (loaded.error !== undefined) {
    const note = `${loaded.error.message}\nThe file cannot be read, so the last good rules stay in use (the built-in asks if there were none). Fix line ${loaded.error.line} and run this again.`;
    return { ok: false, command: "policy list", error: note, ...(json ? { data: { exists: true, path: loaded.path, error: loaded.error } } : {}) };
  }
  const rules = loaded.rules.map((rule) => ({ line: rule.line, decision: rule.decision, action: rule.action, app: rule.app, site: rule.site, note: rule.note }));
  if (json) return { ok: true, command: "policy list", data: { exists: true, path: loaded.path, rules } };
  const text = rules.length === 0 ? `${loaded.path} has no rules.` : [loaded.path, ...loaded.rules.map((rule) => ruleLine(rule))].join("\n");
  return { ok: true, command: "policy list", data: text };
}

function buildRule(args: Flags): NewPolicyRule | string {
  const action = args.values.get("action");
  const decision = args.values.get("decision");
  if (action === undefined || decision === undefined) return "usage: osseo policy add --action <a> --decision <allow|ask|never> [--app <name>] [--site <host>] [--note <text>] [--apply]";
  if (!(POLICY_ACTIONS as readonly string[]).includes(action)) return `action must be one of ${POLICY_ACTIONS.join(", ")}`;
  if (!(POLICY_DECISIONS as readonly string[]).includes(decision)) return `decision must be one of ${POLICY_DECISIONS.join(", ")}`;
  const app = args.values.get("app");
  const site = args.values.get("site");
  const note = args.values.get("note");
  return {
    action: action as PolicyAction,
    decision: decision as NewPolicyRule["decision"],
    ...(app === undefined ? {} : { app }),
    ...(site === undefined ? {} : { site }),
    ...(note === undefined ? {} : { note })
  };
}

async function add(agentHome: string, args: Flags, json: boolean): Promise<PolicyOutput> {
  const rule = buildRule(args);
  if (typeof rule === "string") return fail("policy add", rule);
  try {
    const edit = await planAddRule(agentHome, rule);
    const line = parsePolicy(edit.text)[edit.index - 1]?.line;
    const block = renderRule(rule).trimEnd();
    if (!args.flags.has("apply")) {
      const note = "Nothing was written. Re-run with --apply to write it.";
      return { ok: true, command: "policy add", data: json ? { preview: true, wouldBeRule: edit.index, line, rule: block, note } : `Would add rule ${edit.index} at line ${line}:\n\n${block}\n\n${note}` };
    }
    const written = await addRule(agentHome, rule);
    return { ok: true, command: "policy add", data: json ? { applied: true, rule: written.index, line, text: block, path: policyFilePath(agentHome) } : `Added rule ${written.index} at line ${line} of ${policyFilePath(agentHome)}:\n\n${block}` };
  } catch (error) {
    return fail("policy add", error instanceof Error ? error.message : "policy_add_failed");
  }
}

async function remove(agentHome: string, args: Flags, json: boolean): Promise<PolicyOutput> {
  const raw = args.positional[2];
  const line = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(line) || line < 1) return fail("policy remove", "usage: osseo policy remove <line> [--apply]  (the line number shown by osseo policy list)");
  let text: string;
  try {
    text = await readFile(policyFilePath(agentHome), "utf8");
  } catch {
    return fail("policy remove", "There is no policy.toml to remove a rule from.");
  }
  try {
    const rules = parsePolicy(text);
    const index = rules.findIndex((rule) => rule.line === line);
    if (index < 0) return fail("policy remove", `No rule starts on line ${line}. Run osseo policy list for the line numbers.`);
    const rule = rules[index]!;
    // Prove the removal parses before offering it.
    parsePolicy(removeRuleText(text, index + 1));
    if (!args.flags.has("apply")) {
      const note = "Nothing was removed. Re-run with --apply to remove it.";
      return { ok: true, command: "policy remove", data: json ? { preview: true, line, rule: ruleLine(rule), note } : `Would remove:\n${ruleLine(rule)}\n\n${note}` };
    }
    await removeRule(agentHome, index + 1);
    return { ok: true, command: "policy remove", data: json ? { removed: true, line, rule: ruleLine(rule) } : `Removed:\n${ruleLine(rule)}` };
  } catch (error) {
    if (error instanceof PolicyParseError) return fail("policy remove", `${error.message}. Fix the file by hand first.`);
    return fail("policy remove", error instanceof Error ? error.message : "policy_remove_failed");
  }
}

export async function policyCommand(agentHome: string, sub: string | undefined, args: Flags, json: boolean): Promise<PolicyOutput> {
  if (sub === undefined || sub === "list") return list(agentHome, json);
  if (sub === "add") return add(agentHome, args, json);
  if (sub === "remove") return remove(agentHome, args, json);
  return fail("policy", "usage: osseo policy list | add --action <a> --decision <allow|ask|never> [--app <name>] [--site <host>] [--note <text>] [--apply] | remove <line> [--apply]");
}
