import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHostMcpContext } from "../context.js";
import { forgetScreens, rememberScreen } from "../screenshot-registry.js";
import { createGuideTools, guideActive } from "../tools/guide.js";

const [show, clear] = createGuideTools() as unknown as Array<{ name: string; inputSchema: { parse(v: unknown): unknown }; handler(input: unknown, context: AgentHostMcpContext): Promise<{ ok: boolean; data?: any; error?: { code: string; message: string } }> }>;

function fake(options: { overlay?: boolean; screen?: { width: number; height: number }; active?: boolean; showOk?: boolean } = {}) {
  const showPrimitive = vi.fn(async (_p: any, _r?: any) => ({ ok: options.showOk ?? true, errors: [] as string[] }));
  const dismiss = vi.fn(async (_id: string) => ({ ok: true }));
  const context = {
    ...(options.overlay === false ? {} : { overlay: { showPrimitive, dismiss } }),
    linux: {
      getActiveWindow: async () => ({ activeWindow: options.active === false ? undefined : { windowId: "w1", title: "App", appName: "App", pid: 7 } }),
      getScreenGeometry: async () => ({ supported: true, bounds: { x: 0, y: 0, ...(options.screen ?? { width: 1920, height: 1080 }) }, reason: "ok" })
    }
  } as unknown as AgentHostMcpContext;
  return { context, showPrimitive, dismiss };
}

const run = (context: AgentHostMcpContext, input: unknown) => show!.handler(show!.inputSchema.parse(input), context);

afterEach(() => forgetScreens());

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
