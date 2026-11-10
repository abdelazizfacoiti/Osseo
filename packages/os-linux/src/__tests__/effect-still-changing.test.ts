import { describe, expect, it } from "vitest";
import { measureEffect } from "../effect.js";

describe("measureEffect with a window that never settles", () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it("reports an inconclusive result instead of a change", async () => {
    const { now, sleep } = clock();
    let n = 0;
    const { effect } = await measureEffect({ capture: async () => Buffer.from(`frame${n++}`), now, sleep }, async () => undefined);
    expect(effect.screenChanged).toBeNull();
    expect(effect.reason).toBe("window_still_changing");
  });

  it("still reports a real change once the window settles", async () => {
    const { now, sleep } = clock();
    let phase = 0;
    const { effect } = await measureEffect({ capture: async () => Buffer.from(phase === 0 ? "a" : "b"), now, sleep }, async () => { phase = 1; });
    expect(effect.screenChanged).toBe(true);
  });

  it("reports no change for an identical settled window", async () => {
    const { now, sleep } = clock();
    const { effect } = await measureEffect({ capture: async () => Buffer.from("same"), now, sleep }, async () => undefined);
    expect(effect.screenChanged).toBe(false);
  });
});
