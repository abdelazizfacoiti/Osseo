import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Pauses the action card can clear with Resume. Guards append a human-readable reason after a colon. */
export const ACTION_CARD_PAUSE_PREFIX = "agent_action_card_pause";

export type RunFlagName = "stop" | "takeover" | "pause";

export interface RunFlagState {
  requested: boolean;
  reason?: string;
  at?: string;
}

export interface RunStateSnapshot {
  stop: RunFlagState;
  takeover: RunFlagState;
  pause: RunFlagState;
}

const FLAG_FILES: Record<RunFlagName, string> = {
  stop: "stop.requested",
  takeover: "takeover.active",
  pause: "pause.requested"
};

function flagPath(agentHostDir: string, name: RunFlagName): string {
  return path.join(agentHostDir, "run", FLAG_FILES[name]);
}

async function readFlag(agentHostDir: string, name: RunFlagName): Promise<RunFlagState> {
  const file = flagPath(agentHostDir, name);
  try {
    const raw = await readFile(file, "utf8");
    const value = JSON.parse(raw) as { reason?: unknown; at?: unknown };
    return {
      requested: true,
      ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 500) } : {}),
      ...(typeof value.at === "string" ? { at: value.at } : {})
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { requested: false };
    return { requested: true, reason: "run_flag_unreadable" };
  }
}

export async function readRunState(agentHostDir: string): Promise<RunStateSnapshot> {
  const [stop, takeover, pause] = await Promise.all([
    readFlag(agentHostDir, "stop"),
    readFlag(agentHostDir, "takeover"),
    readFlag(agentHostDir, "pause")
  ]);
  return { stop, takeover, pause };
}

async function writeFlag(agentHostDir: string, name: RunFlagName, reason: string): Promise<RunFlagState> {
  const directory = path.dirname(flagPath(agentHostDir, name));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const record = { requested: true, reason: reason.slice(0, 500), at: new Date().toISOString() };
  const target = flagPath(agentHostDir, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
  return { requested: true, reason: record.reason, at: record.at };
}

async function clearFlag(agentHostDir: string, name: RunFlagName): Promise<void> {
  await rm(flagPath(agentHostDir, name), { force: true });
}

export function requestStop(agentHostDir: string, reason = "operator_stop"): Promise<RunFlagState> {
  return writeFlag(agentHostDir, "stop", reason);
}

export function clearStop(agentHostDir: string): Promise<void> {
  return clearFlag(agentHostDir, "stop");
}

export function beginTakeover(agentHostDir: string, reason = "operator_takeover"): Promise<RunFlagState> {
  return writeFlag(agentHostDir, "takeover", reason);
}

export function endTakeover(agentHostDir: string): Promise<void> {
  return clearFlag(agentHostDir, "takeover");
}

export function requestPause(agentHostDir: string, reason = "operator_pause"): Promise<RunFlagState> {
  return writeFlag(agentHostDir, "pause", reason);
}

export function clearPause(agentHostDir: string): Promise<void> {
  return clearFlag(agentHostDir, "pause");
}

export const HANDOFF_KINDS = ["login", "mfa", "captcha", "payment", "other"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];
const HANDOFF_REASON_PREFIX = "handoff:";

export interface HandoffState {
  active: boolean;
  kind?: HandoffKind;
  message?: string;
  at?: string;
}

function handoffPath(agentHostDir: string): string {
  return path.join(agentHostDir, "run", "handoff.active");
}

/** Reads the active "your turn" handoff, if any. Unreadable records count as active with no detail. */
export async function readHandoff(agentHostDir: string): Promise<HandoffState> {
  try {
    const value = JSON.parse(await readFile(handoffPath(agentHostDir), "utf8")) as { kind?: unknown; message?: unknown; at?: unknown };
    return {
      active: true,
      kind: HANDOFF_KINDS.find((kind) => kind === value.kind) ?? "other",
      ...(typeof value.message === "string" ? { message: value.message.slice(0, 300) } : {}),
      ...(typeof value.at === "string" ? { at: value.at } : {})
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { active: false } : { active: true, kind: "other" };
  }
}

/**
 * Asks the human to do a step the agent must not (login, MFA, CAPTCHA, payment).
 * It raises the takeover flag, so state-changing tools halt, and records the
 * handoff so screen-reading tools are refused until the human continues.
 */
export async function beginHandoff(agentHostDir: string, input: { kind: HandoffKind; message: string }): Promise<HandoffState> {
  const directory = path.dirname(handoffPath(agentHostDir));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const record = { kind: input.kind, message: input.message.slice(0, 300), at: new Date().toISOString() };
  const target = handoffPath(agentHostDir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  await beginTakeover(agentHostDir, `${HANDOFF_REASON_PREFIX}${input.kind}`);
  return { active: true, ...record };
}

/** Ends a handoff. A takeover the operator started separately is left alone. */
export async function endHandoff(agentHostDir: string): Promise<void> {
  const takeover = await readFlag(agentHostDir, "takeover");
  if (takeover.reason?.startsWith(HANDOFF_REASON_PREFIX) === true) await endTakeover(agentHostDir);
  await rm(handoffPath(agentHostDir), { force: true });
}

export function evaluateRunStateGate(state: RunStateSnapshot): {
  allowed: boolean;
  code?: "emergency_stop_requested" | "human_takeover_active" | "pause_requested";
  reason?: string;
} {
  if (state.stop.requested) {
    return {
      allowed: false,
      code: "emergency_stop_requested",
      reason: state.stop.reason ?? "An operator stop is active; state-changing tools are halted."
    };
  }

  if (state.takeover.requested) {
    return {
      allowed: false,
      code: "human_takeover_active",
      reason: state.takeover.reason ?? "A human operator has taken control; state-changing tools are halted."
    };
  }

  if (state.pause.requested) {
    return {
      allowed: false,
      code: "pause_requested",
      reason: state.pause.reason ?? "The operator paused AgentHost; state-changing tools are held until resume."
    };
  }

  return { allowed: true };
}
