import { describe, expect, it } from "vitest";
import { waitForSettled } from "../effect.js";

// A fake clock: each sleep advances time, so the poll interval and the cap are exact.
function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

// Each capture returns the next frame; the last frame repeats. undefined means "not capturable".
function frames(...items: Array<string | undefined>): () => Promise<Buffer | undefined> {
  let index = 0;
  return async () => {
    const item = items[Math.min(index, items.length - 1)];
    index += 1;
    return item === undefined ? undefined : Buffer.from(item);
  };
}

describe("waitForSettled", () => {
  it("is stable once two captures in a row match", async () => {
    const clock = fakeClock();
    const result = await waitForSettled({ capture: frames("a", "b", "b", "b"), now: clock.now, sleep: clock.sleep, pollMs: 80 });
    expect(result).toEqual({ stable: true, settledMs: 160 });
  });

  it("gives up at the cap while the window keeps changing", async () => {
    const clock = fakeClock();
    let frame = 0;
    const result = await waitForSettled({
      capture: async () => Buffer.from(String((frame += 1))),
      now: clock.now,
      sleep: clock.sleep,
      pollMs: 80,
      capCapMs: 300
    });
    expect(result.stable).toBe(false);
    expect(result.settledMs).toBeGreaterThanOrEqual(300);
  });

  it("reports unsettled, without waiting, when the window cannot be captured", async () => {
    const clock = fakeClock();
    const result = await waitForSettled({ capture: frames(undefined), now: clock.now, sleep: clock.sleep });
    expect(result).toEqual({ stable: false, settledMs: 0 });
  });

  it("reports unsettled when a capture is lost part way through", async () => {
    const clock = fakeClock();
    const result = await waitForSettled({ capture: frames("a", undefined), now: clock.now, sleep: clock.sleep, pollMs: 80 });
    expect(result.stable).toBe(false);
  });
});
