import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OsseoMcpContext } from "../context.js";
import { forgetScreens, rememberScreen } from "../screenshot-registry.js";
import { inputGuardPath } from "../input-guard.js";
import { createGuideTools, guideActive, guideHooks } from "../tools/guide.js";

const [show, clear] = createGuideTools() as unknown as Array<{ name: string; inputSchema: { parse(v: unknown): unknown }; handler(input: unknown, context: OsseoMcpContext): Promise<{ ok: boolean; data?: any; error?: { code: string; message: string } }> }>;

function fake(options: { overlay?: boolean; screen?: { width: number; height: number }; active?: boolean; showOk?: boolean; wait?: (input: any) => Promise<any>; dir?: string } = {}) {
  const showPrimitive = vi.fn(async (_p: any, _r?: any) => ({ ok: options.showOk ?? true, errors: [] as string[] }));
  const dismiss = vi.fn(async (_id: string) => ({ ok: true }));
  const context = {
    ...(options.dir === undefined ? {} : { config: { osseoDir: options.dir } }),
    ...(options.overlay === false ? {} : { overlay: { showPrimitive, dismiss } }),
    linux: {
      ...(options.wait === undefined ? {} : { waitForPointerPress: options.wait }),
      getActiveWindow: async () => ({ activeWindow: options.active === false ? undefined : { windowId: "w1", title: "App", appName: "App", pid: 7 } }),
      getScreenGeometry: async () => ({ supported: true, bounds: { x: 0, y: 0, ...(options.screen ?? { width: 1920, height: 1080 }) }, reason: "ok" })
    }
  } as unknown as OsseoMcpContext;
  return { context, showPrimitive, dismiss };
}

const run = (context: OsseoMcpContext, input: unknown) => show!.handler(show!.inputSchema.parse(input), context);

afterEach(() => forgetScreens());

const clearBox = [{ text: "a", bounds: { x: 0, y: 0, width: 50, height: 50 } }, { text: "b", bounds: { x: 100, y: 100, width: 50, height: 50 } }];
const noStop = { stop: { requested: false }, takeover: { requested: false }, pause: { requested: false } };

describe("guide.show", () => {
  it("draws a box and a labelled tooltip per bounds step", async () => {
    const { context, showPrimitive } = fake();
    const result = await run(context, { steps: [
      { text: "Open the menu", bounds: { x: 10, y: 20, width: 100, height: 30 } },
      { text: "Pick Save", bounds: { x: 200, y: 220, width: 80, height: 24 } }
    ] });
    expect(result.ok).toBe(true);
    expect(result.data.shown).toBe(2);
    expect(result.data.steps[1]).toMatchObject({ index: 2, source: "bounds", bounds: { x: 200, y: 220, width: 80, height: 24 } });
    const prims = showPrimitive.mock.calls.map((c) => c[0]);
    expect(prims.filter((p) => p.type === "highlight")).toHaveLength(2);
    const tips = prims.filter((p) => p.type === "tooltip");
    expect(tips.map((p) => p.label)).toEqual(["Step 1 of 2", "Step 2 of 2"]);
    expect(tips[0].text).toBe("Open the menu");
    expect(tips[0].target).toMatchObject({ kind: "window_region", windowId: "w1", bounds: { x: 10, y: 20, width: 100, height: 30 } });
  });

  it("labels a single step Tip", async () => {
    const { context, showPrimitive } = fake();
    await run(context, { steps: [{ text: "Here", bounds: { x: 0, y: 0, width: 50, height: 50 } }] });
    expect(showPrimitive.mock.calls.map((c) => c[0]).find((p) => p.type === "tooltip").label).toBe("Tip");
  });

  it("the resolver accepts a window_region target", async () => {
    const { context, showPrimitive } = fake();
    await run(context, { steps: [{ text: "x", bounds: { x: 0, y: 0, width: 50, height: 50 } }] });
    const [prim, resolver] = showPrimitive.mock.calls[0]!;
    const resolved = await resolver(prim.target, "s");
    expect(resolved.ok).toBe(true);
    expect(resolved.summary.bounds).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });

  it("a second show dismisses the first one's ids", async () => {
    const { context, showPrimitive, dismiss } = fake();
    const step = { text: "a", bounds: { x: 0, y: 0, width: 50, height: 50 } };
    await run(context, { steps: [step] });
    const first = showPrimitive.mock.calls.map((c) => c[0].overlayId);
    expect(dismiss).not.toHaveBeenCalled();
    await run(context, { steps: [step] });
    expect(dismiss.mock.calls.map((c) => c[0]).sort()).toEqual([...first].sort());
  });

  it("maps a screenshot rectangle to screen coordinates", async () => {
    const { context, showPrimitive } = fake();
    const id = rememberScreen({ origin: { x: 100, y: 50 }, pixelsPerPoint: 0.5, imageWidth: 400, imageHeight: 300 });
    const result = await run(context, { steps: [{ text: "Click", screenshotId: id, imageX: 20, imageY: 40, imageWidth: 100, imageHeight: 60 }] });
    expect(result.ok).toBe(true);
    expect(result.data.steps[0]).toMatchObject({ source: "screenshot", bounds: { x: 140, y: 130, width: 198, height: 118 } });
    expect(showPrimitive.mock.calls[0]![0].target.bounds).toEqual({ x: 140, y: 130, width: 198, height: 118 });
  });

  it("fails on an unknown screenshot id and shows nothing, even for earlier good steps", async () => {
    const { context, showPrimitive } = fake();
    const result = await run(context, { steps: [
      { text: "ok", bounds: { x: 0, y: 0, width: 50, height: 50 } },
      { text: "bad", screenshotId: "shot_nope", imageX: 0, imageY: 0, imageWidth: 10, imageHeight: 10 }
    ] });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe("screenshot_unknown");
    expect(result.error!.message).toContain("Step 2");
    expect(showPrimitive).not.toHaveBeenCalled();
  });

  it("fails when the rectangle starts outside the picture", async () => {
    const { context, showPrimitive } = fake();
    const id = rememberScreen({ origin: { x: 0, y: 0 }, pixelsPerPoint: 1, imageWidth: 100, imageHeight: 100 });
    const result = await run(context, { steps: [{ text: "x", screenshotId: id, imageX: 500, imageY: 0, imageWidth: 10, imageHeight: 10 }] });
    expect(result.error!.code).toBe("image_point_outside");
    expect(showPrimitive).not.toHaveBeenCalled();
  });

  it("fails for bounds off screen and shows nothing", async () => {
    const { context, showPrimitive } = fake({ screen: { width: 800, height: 600 } });
    const result = await run(context, { steps: [{ text: "x", bounds: { x: 700, y: 10, width: 200, height: 40 } }] });
    expect(result.error!.code).toBe("bounds_off_screen");
    expect(showPrimitive).not.toHaveBeenCalled();
  });

  it("fails with overlay_unavailable when there is no overlay or every mark is refused", async () => {
    const step = { text: "x", bounds: { x: 0, y: 0, width: 50, height: 50 } };
    expect((await run(fake({ overlay: false }).context, { steps: [step] })).error!.code).toBe("overlay_unavailable");
    expect((await run(fake({ showOk: false }).context, { steps: [step] })).error!.code).toBe("overlay_unavailable");
  });

  it("fails without a window", async () => {
    const result = await run(fake({ active: false }).context, { steps: [{ text: "x", bounds: { x: 0, y: 0, width: 50, height: 50 } }] });
    expect(result.error!.code).toBe("active_window_unavailable");
  });

  it("rejects a step with two ways to say where", () => {
    expect(() => show!.inputSchema.parse({ steps: [{ text: "x", label: "Save", bounds: { x: 0, y: 0, width: 5, height: 5 } }] })).toThrow();
    expect(() => show!.inputSchema.parse({ steps: [{ text: "x" }] })).toThrow();
  });
});

describe("guide.clear and guideActive", () => {
  const step = { text: "a", bounds: { x: 0, y: 0, width: 50, height: 50 } };

  it("dismisses everything and reports the count", async () => {
    const { context, dismiss } = fake();
    await run(context, { steps: [step, step] });
    const result = await clear!.handler({}, context);
    expect(result.data).toEqual({ cleared: 4 });
    expect(dismiss).toHaveBeenCalledTimes(4);
    expect((await clear!.handler({}, context)).data).toEqual({ cleared: 0 });
  });

  it("is active after show, not after clear, not after the ttl", async () => {
    const { context } = fake();
    expect(guideActive(context)).toBe(false);
    await run(context, { steps: [step], ttlSeconds: 30 });
    expect(guideActive(context)).toBe(true);
    expect(guideActive(context, Date.now() + 31_000)).toBe(false);
    await clear!.handler({}, context);
    expect(guideActive(context)).toBe(false);
  });
});


describe("guide.show waitForClick", () => {
  it("reports the clicked step (1-based), clears the marks and passes the regions", async () => {
    const wait = vi.fn(async (_i: any) => ({ pressed: true as const, index: 1, x: 120, y: 130 }));
    const { context, dismiss } = fake({ wait });
    const result = await run(context, { steps: clearBox, waitForClick: true, waitSeconds: 30 });
    expect(result.ok).toBe(true);
    expect(result.data.clicked).toEqual({ index: 2, x: 120, y: 130 });
    expect(wait.mock.calls[0]![0].regions).toEqual([clearBox[0]!.bounds, clearBox[1]!.bounds]);
    expect(wait.mock.calls[0]![0].timeoutMs).toBeLessThanOrEqual(30_000);
    expect(dismiss).toHaveBeenCalledTimes(4);
    expect(guideActive(context)).toBe(false);
    expect((result as any).observations.join(" ")).toMatch(/clicked step 2/);
  });

  it("leaves the marks on timeout", async () => {
    const { context, dismiss } = fake({ wait: async () => ({ pressed: false, reason: "timeout" }) });
    const result = await run(context, { steps: clearBox, waitForClick: true });
    expect(result.data).toMatchObject({ clicked: null, waitTimedOut: true });
    expect(dismiss).not.toHaveBeenCalled();
    expect(guideActive(context)).toBe(true);
    await clear!.handler({}, context);
  });

  it("leaves the marks when the watcher is missing or unavailable", async () => {
    const missing = fake();
    const r1 = await run(missing.context, { steps: clearBox, waitForClick: true });
    expect(r1.data).toMatchObject({ clicked: null, waitUnavailable: true });
    expect(guideActive(missing.context)).toBe(true);
    const unavailable = fake({ wait: async () => ({ pressed: false, reason: "unavailable" }) });
    const r2 = await run(unavailable.context, { steps: clearBox, waitForClick: true });
    expect(r2.data).toMatchObject({ clicked: null, waitUnavailable: true });
    expect(unavailable.dismiss).not.toHaveBeenCalled();
    await clear!.handler({}, missing.context);
    await clear!.handler({}, unavailable.context);
  });

  it("ignores a press while the input-guard file is fresh and counts the next one", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "guide-wait-"));
    try {
      mkdirSync(path.join(dir, "run"), { recursive: true });
      writeFileSync(inputGuardPath(dir), "");
      let calls = 0;
      const wait = vi.fn(async () => {
        calls += 1;
        if (calls === 2) rmSync(inputGuardPath(dir));
        return { pressed: true as const, index: 0, x: 5, y: 6 };
      });
      const { context } = fake({ wait, dir });
      const result = await run(context, { steps: clearBox, waitForClick: true });
      expect(wait).toHaveBeenCalledTimes(2);
      expect(result.data.clicked).toEqual({ index: 1, x: 5, y: 6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("guide.clear during a wait ends it with cleared", async () => {
    const wait = (input: any) => new Promise<any>((resolve) => input.signal.addEventListener("abort", () => resolve({ pressed: false, reason: "aborted" })));
    const { context } = fake({ wait });
    const pending = run(context, { steps: clearBox, waitForClick: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await clear!.handler({}, context);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ clicked: null, cleared: true });
  });

  it("a wait without waitForClick behaves as before", async () => {
    const wait = vi.fn();
    const { context } = fake({ wait });
    const result = await run(context, { steps: clearBox });
    expect(wait).not.toHaveBeenCalled();
    expect(result.data.clicked).toBeUndefined();
    expect(guideActive(context)).toBe(true);
    await clear!.handler({}, context);
  });

  it("rejects out-of-range waitSeconds", () => {
    expect(() => show!.inputSchema.parse({ steps: clearBox, waitSeconds: 2 })).toThrow();
    expect(() => show!.inputSchema.parse({ steps: clearBox, waitSeconds: 241 })).toThrow();
  });
});

describe("guide.show and Stop", () => {
  const original = guideHooks.readRunState;
  afterEach(() => { guideHooks.readRunState = original; vi.useRealTimers(); });

  it("refuses to show while the stop flag is set, but guide.clear still works", async () => {
    guideHooks.readRunState = async () => ({ ...noStop, stop: { requested: true } });
    const { context, showPrimitive } = fake({ dir: "/nonexistent-guide-dir" });
    const result = await run(context, { steps: clearBox });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("emergency_stop_requested");
    expect(showPrimitive).not.toHaveBeenCalled();
    expect((await clear!.handler({}, context)).ok).toBe(true);
  });

  it("removes the marks and ends a wait when Stop is pressed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let stopped = false;
    guideHooks.readRunState = async () => ({ ...noStop, stop: { requested: stopped } });
    const wait = (input: any) => new Promise<any>((resolve) => input.signal.addEventListener("abort", () => resolve({ pressed: false, reason: "aborted" })));
    const { context, dismiss } = fake({ wait, dir: "/nonexistent-guide-dir" });
    const pending = run(context, { steps: clearBox, waitForClick: true });
    await vi.advanceTimersByTimeAsync(10);
    stopped = true;
    await vi.advanceTimersByTimeAsync(1100);
    const result = await pending;
    expect(result.data).toMatchObject({ clicked: null, stopped: true });
    expect(dismiss).toHaveBeenCalledTimes(4);
    expect(guideActive(context)).toBe(false);
  });

  it("removes the marks of a plain guide when Stop is pressed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let stopped = false;
    guideHooks.readRunState = async () => ({ ...noStop, stop: { requested: stopped } });
    const { context, dismiss } = fake({ dir: "/nonexistent-guide-dir" });
    await run(context, { steps: clearBox });
    await vi.advanceTimersByTimeAsync(1100);
    expect(dismiss).not.toHaveBeenCalled();
    stopped = true;
    await vi.advanceTimersByTimeAsync(1100);
    expect(dismiss).toHaveBeenCalledTimes(4);
  });
});

describe("guide.show Teach mode (waitForClick with cards)", () => {
  const three = [
    { text: "one", bounds: { x: 0, y: 0, width: 50, height: 50 } },
    { text: "two", bounds: { x: 100, y: 100, width: 50, height: 50 } },
    { text: "three", bounds: { x: 200, y: 200, width: 50, height: 50 } }
  ];
  const original = guideHooks.readRunState;
  afterEach(() => { guideHooks.readRunState = original; vi.useRealTimers(); });

  // A watcher that never sees a press unless the test queues one, and ends on abort.
  function teachFake(options: { dir?: string; presses?: Array<{ index: number }> } = {}) {
    const base = fake({
      ...(options.dir === undefined ? {} : { dir: options.dir }),
      wait: (input: any) => new Promise<any>((resolve) => {
        const queued = options.presses?.shift();
        if (queued !== undefined) { setTimeout(() => resolve({ pressed: true, index: queued.index, x: 1, y: 2 }), 30); return; }
        input.signal.addEventListener("abort", () => resolve({ pressed: false, reason: "aborted" }));
      })
    });
    const queue: Array<{ overlayId: string; event: string }> = [];
    const showWidget = vi.fn(async (_w: any, _r?: any) => ({ ok: true, errors: [] as string[] }));
    const pollEvents = vi.fn(async (overlayId?: string) => {
      const mine = queue.filter((e) => e.overlayId === overlayId);
      for (const e of mine) queue.splice(queue.indexOf(e), 1);
      return mine;
    });
    Object.assign((base.context as any).overlay, { showWidget, pollEvents });
    const cardIds = () => showWidget.mock.calls.map((c) => c[0].widgetId as string);
    const press = (event: string, index?: number) => {
      const ids = cardIds();
      const id = index === undefined ? ids[ids.length - 1]! : ids.filter((x) => x.includes(`-${index}-card`)).pop()!;
      queue.push({ overlayId: id, event });
    };
    return { ...base, showWidget, pollEvents, queue, press, cardIds };
  }
  const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

  it("draws every box and one card with Step n of m, text and buttons; no tooltips", async () => {
    const t = teachFake();
    const pending = run(t.context, { steps: three, waitForClick: true });
    await settle(50);
    const prims = t.showPrimitive.mock.calls.map((c) => c[0]);
    expect(prims.filter((p) => p.type === "highlight")).toHaveLength(3);
    expect(prims.filter((p) => p.type === "tooltip")).toHaveLength(0);
    expect(t.showWidget).toHaveBeenCalledTimes(1);
    const card = t.showWidget.mock.calls[0]![0];
    expect(card.title).toBe("Step 1 of 3");
    expect(card.components.map((c: any) => c.type === "button" ? c.label : c.text)).toEqual(["one", "Next"]);
    expect(card.interaction).toEqual({ interactive: true, focus: "never", dismissible: false, allowedEvents: ["next"] });
    expect(card.target).toMatchObject({ kind: "window_region", bounds: three[0]!.bounds });
    await clear!.handler({}, t.context);
    await pending;
  });

  it("Next advances, Back goes back and re-draws the box and card, Done clears and finishes", async () => {
    const t = teachFake();
    const pending = run(t.context, { steps: three, waitForClick: true, waitSeconds: 30 });
    await settle(50);
    t.press("next"); await settle();
    expect(t.showWidget.mock.calls.at(-1)![0].title).toBe("Step 2 of 3");
    expect(t.showWidget.mock.calls.at(-1)![0].components.map((c: any) => c.label ?? c.text)).toEqual(["two", "Back", "Next"]);
    expect(t.dismiss).toHaveBeenCalledWith(t.cardIds()[0]);
    const boxCalls = t.showPrimitive.mock.calls.filter((c) => c[0].type === "highlight").length;
    t.press("back"); await settle();
    expect(t.showWidget.mock.calls.at(-1)![0].title).toBe("Step 1 of 3");
    expect(t.showPrimitive.mock.calls.filter((c) => c[0].type === "highlight").length).toBe(boxCalls + 1);
    t.press("next"); await settle();
    t.press("next"); await settle();
    const last = t.showWidget.mock.calls.at(-1)![0];
    expect(last.title).toBe("Step 3 of 3");
    expect(last.components.map((c: any) => c.label ?? c.text)).toEqual(["three", "Back", "Done"]);
    t.dismiss.mockClear();
    t.press("next");
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ clicked: { index: 3, via: "done" }, finished: true, shown: 3 });
    expect(t.dismiss).toHaveBeenCalled();
    expect(guideActive(t.context)).toBe(false);
  });

  it("a press inside a box moves to the next step; a press in the last box finishes", async () => {
    const t = teachFake({ presses: [{ index: 0 }, { index: 2 }] });
    const result = await run(t.context, { steps: three, waitForClick: true, waitSeconds: 30 });
    expect(t.showWidget.mock.calls.map((c) => c[0].title)).toEqual(["Step 1 of 3", "Step 2 of 3"]);
    expect(result.data).toMatchObject({ clicked: { index: 3, x: 1, y: 2 }, finished: true });
    expect(guideActive(t.context)).toBe(false);
  });

  it("one step ends at the first box press", async () => {
    const t = teachFake({ presses: [{ index: 0 }] });
    const result = await run(t.context, { steps: [three[0]], waitForClick: true });
    expect(result.data).toMatchObject({ clicked: { index: 1 }, finished: true });
  });

  it("reads events only for the current card", async () => {
    const t = teachFake();
    const pending = run(t.context, { steps: three, waitForClick: true });
    await settle(250);
    expect(t.pollEvents.mock.calls.length).toBeGreaterThan(0);
    expect(t.pollEvents.mock.calls.every((c) => c[0] === t.cardIds()[0])).toBe(true);
    t.queue.push({ overlayId: "someone-else", event: "next" });
    await settle(250);
    expect(t.queue).toHaveLength(1);
    expect(t.showWidget).toHaveBeenCalledTimes(1);
    await clear!.handler({}, t.context);
    await pending;
  });

  it("guide.clear ends the wait", async () => {
    const t = teachFake();
    const pending = run(t.context, { steps: three, waitForClick: true });
    await settle(50);
    await clear!.handler({}, t.context);
    const result = await pending;
    expect(result.data).toMatchObject({ clicked: null, cleared: true });
    expect(guideActive(t.context)).toBe(false);
  });

  it("Stop removes the marks and the card", async () => {
    let stopped = false;
    guideHooks.readRunState = async () => ({ ...noStop, stop: { requested: stopped } });
    const t = teachFake({ dir: "/nonexistent-guide-dir" });
    const pending = run(t.context, { steps: three, waitForClick: true });
    await settle(50);
    stopped = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const result = await pending;
    expect(result.data).toMatchObject({ clicked: null, stopped: true });
    expect(t.dismiss).toHaveBeenCalledTimes(4);
    expect(guideActive(t.context)).toBe(false);
  });

  it("Next and Back work when the pointer watcher is unavailable", async () => {
    const t = teachFake();
    (t.context.linux as any).waitForPointerPress = async () => ({ pressed: false, reason: "unavailable" });
    const pending = run(t.context, { steps: [three[0], three[1]], waitForClick: true, waitSeconds: 30 });
    await settle(50);
    t.press("next"); await settle();
    t.press("next");
    expect((await pending).data).toMatchObject({ finished: true, clicked: { index: 2, via: "done" } });
  });

  it("without waitForClick there is no card, only tooltips", async () => {
    const t = teachFake();
    await run(t.context, { steps: three });
    expect(t.showWidget).not.toHaveBeenCalled();
    expect(t.pollEvents).not.toHaveBeenCalled();
    expect(t.showPrimitive.mock.calls.filter((c) => c[0].type === "tooltip")).toHaveLength(3);
    await clear!.handler({}, t.context);
  });

  it("falls back to tooltips when the card cannot be drawn", async () => {
    const t = teachFake({ presses: [{ index: 0 }] });
    t.showWidget.mockResolvedValue({ ok: false, errors: ["no"] });
    const result = await run(t.context, { steps: [three[0]], waitForClick: true });
    expect(t.showPrimitive.mock.calls.filter((c) => c[0].type === "tooltip")).toHaveLength(1);
    expect(result.data.clicked).toMatchObject({ index: 1 });
  });
});
