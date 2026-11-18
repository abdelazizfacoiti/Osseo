import { createHash } from "node:crypto";

/*
 * Did an action change what is on screen? xdotool reports "clicked" whenever the
 * button press was sent, even when nothing happened, so success was being
 * guessed. measureEffect hashes the window before and after the action, and
 * waits until the picture stops moving, so the result says what actually
 * happened.
 *
 * Limits: this is a pixel comparison. A blinking caret can read as a change, and
 * an animation keeps the window unsettled until the cap. Callers should treat
 * screenChanged: false as "no visible change", not as proof nothing happened.
 */

export interface EffectResult {
  /** true: the window differs afterwards. false: identical. null: could not be captured. */
  screenChanged: boolean | null;
  settledMs: number;
  reason?: string;
}

export interface MeasureEffectOptions {
  /** Grabs the target window as PNG bytes, or undefined when that is not possible. */
  capture: () => Promise<Buffer | undefined>;
  /**
   * Runs before the baseline capture, for example to hover the target so that hover
   * styling is already part of the baseline and does not read as a change.
   */
  prepare?: () => Promise<unknown>;
  prepareSettleMs?: number;
  settleCapMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function measureEffect<T>(options: MeasureEffectOptions, act: () => Promise<T>): Promise<{ value: T; effect: EffectResult }> {
  const capCap = Math.max(0, options.settleCapMs ?? 1_500);
  const poll = Math.max(10, options.pollMs ?? 40);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const digest = async (): Promise<string | undefined> => {
    const bytes = await options.capture();
    return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
  };
  if (options.prepare !== undefined) {
    await options.prepare();
    await sleep(Math.max(0, options.prepareSettleMs ?? 120));
  }
  const before = await digest();
  const value = await act();
  const started = now();
  if (before === undefined) return { value, effect: { screenChanged: null, settledMs: 0, reason: "window_not_captured" } };
  let previous = await digest();
  let current = previous;
  let settled = false;
  while (previous !== undefined && now() - started < capCap) {
    await sleep(poll);
    current = await digest();
    if (current === undefined) break;
    if (current === previous) { settled = true; break; }
    previous = current;
  }
  const settledMs = now() - started;
  if (current === undefined) return { value, effect: { screenChanged: null, settledMs, reason: "window_not_captured" } };
  const changed = current !== before;
  // Never settled: an animation, video, clock or blinking caret keeps changing pixels, so a
  // difference does not show that the action did anything.
  if (!settled && changed) return { value, effect: { screenChanged: null, settledMs, reason: "window_still_changing" } };
  return { value, effect: { screenChanged: changed, settledMs } };
}

export interface SettleOptions {
  /** Grabs the window as PNG bytes, or undefined when that is not possible. */
  capture: () => Promise<Buffer | undefined>;
  /** Longest total wait. A window that never settles (a blinking caret, an animation) costs at most this. */
  capCapMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SettleResult {
  /** true: two captures in a row matched. false: still changing at the cap, or not capturable. */
  stable: boolean;
  settledMs: number;
}

/**
 * Waits until the window stops changing: two captures in a row must match. A clipboard paste uses
 * it, so the old clipboard is restored only after the target has read the paste.
 */
export async function waitForSettled(options: SettleOptions): Promise<SettleResult> {
  const cap = Math.max(0, options.capCapMs ?? 1_500);
  const poll = Math.max(10, options.pollMs ?? 80);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepFor;
  const started = now();
  const digest = async (): Promise<string | undefined> => {
    const bytes = await options.capture();
    return bytes === undefined ? undefined : createHash("sha256").update(bytes).digest("hex");
  };
  let previous = await digest();
  while (previous !== undefined && now() - started < cap) {
    await sleep(poll);
    const current = await digest();
    if (current === undefined) break;
    if (current === previous) return { stable: true, settledMs: now() - started };
    previous = current;
  }
  return { stable: false, settledMs: now() - started };
}
