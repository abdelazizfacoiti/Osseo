import type { ToolResult } from "@agenthost/core";

/**
 * How a tool result is written to the agent.
 *
 * lean (default) drops what the agent does not need to act: null fields, the approval block when
 * none is required, and the state block when it is the same as the last one (stateUnchanged says
 * so). Compact JSON, no indentation. Provenance (serverVersion, serverPath) stays only on the
 * tools whose answer is about the server itself.
 *
 * full writes every field, pretty-printed, as before.
 */

export type OutputVerbosity = "lean" | "full";

/** The result fields that tell the caller which build answered. */
type Provenance = { serverVersion?: string; serverPath?: string };

const PROVENANCE_TOOLS = new Set(["agent.status", "system.get_info"]);

/** Holds the last state fingerprint across one session's results. */
export interface StateHolder {
  fingerprint?: string | undefined;
}

function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === null || item === undefined) continue;
      out[key] = dropNulls(item);
    }
    return out;
  }
  return value;
}

/** The text an agent reads for one result. */
export function renderResultText(result: ToolResult & Provenance, verbosity: OutputVerbosity, holder: StateHolder): string {
  if (verbosity === "full") return JSON.stringify(result, null, 2);
  const { serverVersion, serverPath, approval, state, ...rest } = result;
  const shown: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value === null || value === undefined) continue;
    shown[key] = dropNulls(value);
  }
  if (PROVENANCE_TOOLS.has(result.tool)) {
    if (serverVersion !== undefined) shown.serverVersion = serverVersion;
    if (serverPath !== undefined) shown.serverPath = serverPath;
  }
  if (approval !== undefined && approval.required !== false) shown.approval = dropNulls(approval);
  if (state !== undefined) {
    const fingerprint = JSON.stringify(dropNulls({ ...state, capturedAt: undefined }));
    if (fingerprint === holder.fingerprint) {
      shown.stateUnchanged = true;
    } else {
      shown.state = dropNulls(state);
    }
    holder.fingerprint = fingerprint;
  }
  return JSON.stringify(shown);
}
