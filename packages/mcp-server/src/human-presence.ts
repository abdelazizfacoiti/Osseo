import { stat } from "node:fs/promises";
import { inputGuardPath } from "./input-guard.js";

/*
 * Yield to the human. Before AgentHost injects input it checks whether the
 * person is using the keyboard or mouse right now and, if so, waits for them
 * to pause instead of fighting over the cursor.
 *
 * X idle time also resets on AgentHost's own injected input, so the last
 * injection (the `run/input-active` marker the runner already keeps) is
 * subtracted: input only counts as human when it is more recent than the
 * marker. The signal is a heuristic and only ever delays or defers an action;
 * it never grants anything.
 */

export interface YieldOptions {
  agentHostDir: string;
  readIdleMs: () => Promise<number | undefined>;
  /** Input younger than this counts as the human being active. */
  quietMs?: number;
  /** Give up and report the user as busy after this long. */
  maxWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface YieldOutcome {
  /** True when the human was still active at the deadline. */
  busy: boolean;
  waitedMs: number;
}

async function lastAgentInputAt(agentHostDir: string): Promise<number | undefined> {
  try {
    return (await stat(inputGuardPath(agentHostDir))).mtimeMs;
  } catch {
    return undefined;
  }
}

export async function humanActiveNow(options: Pick<YieldOptions, "agentHostDir" | "readIdleMs" | "quietMs" | "now">): Promise<boolean> {
  const idle = await options.readIdleMs();
  if (idle === undefined || idle >= (options.quietMs ?? 1_200)) return false;
  const agentAt = await lastAgentInputAt(options.agentHostDir);
  if (agentAt === undefined) return true;
  const sinceAgent = (options.now ?? Date.now)() - agentAt;
  // The last input event was ours when the idle time reaches back no further than our injection.
  return sinceAgent > idle + 400;
}

export async function waitForHumanToPause(options: YieldOptions): Promise<YieldOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const maxWaitMs = options.maxWaitMs ?? 15_000;
  while (await humanActiveNow(options)) {
    if (now() - started >= maxWaitMs) return { busy: true, waitedMs: now() - started };
    await sleep(options.pollMs ?? 250);
  }
  return { busy: false, waitedMs: now() - started };
}
