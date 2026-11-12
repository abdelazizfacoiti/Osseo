import { afterEach, describe, expect, it } from "vitest";
import { forgetViews, lookupTarget, recallView, rememberView, VIEW_LIMIT, VIEW_TTL_MS, type Box, type ViewTarget } from "../view-registry.js";

const box: Box = { x: 10, y: 10, width: 200, height: 100 };
const screen = (extra: Partial<Extract<ViewTarget, { kind: "screen" }>> = {}): ViewTarget => ({ kind: "screen", bounds: { x: 20, y: 20, width: 40, height: 20 }, enabled: true, blocked: false, role: "button", name: "Save", windowId: "w1", ...extra });
const remember = (windowKey: string, targets: Array<[number, ViewTarget]>, now?: number) =>
  rememberView({ windowKey, windowBounds: box, source: "accessibility", targets: new Map(targets) }, now);

afterEach(() => forgetViews());

describe("view registry", () => {
  it("gives each view a short id and recalls it, or the newest when no id is given", () => {
    const a = remember("w1", [[1, screen()]], 1000);
    const b = remember("w2", [[1, screen()]], 2000);
    expect(a.id).toMatch(/^v_[0-9a-f]{6}$/);
    expect(recallView(a.id, 3000)).toBe(a);
    expect(recallView(undefined, 3000)).toBe(b);
  });

  it("expires a view after five minutes", () => {
    const view = remember("w1", [[1, screen()]], 1000);
    expect(recallView(view.id, 1000 + VIEW_TTL_MS)).toBeDefined();
    expect(recallView(view.id, 1001 + VIEW_TTL_MS)).toBeUndefined();
  });

  it("keeps at most ten views, dropping the oldest", () => {
    const first = remember("k0", [[1, screen()]], 1000);
    for (let i = 1; i <= VIEW_LIMIT; i += 1) remember(`k${i}`, [[1, screen()]], 1000 + i);
    expect(recallView(first.id, 2000)).toBeUndefined();
    expect(recallView(undefined, 2000)).toBeDefined();
  });

  it("replaces the earlier view of the same window", () => {
    const old = remember("w1", [[1, screen()]], 1000);
    const other = remember("w2", [[1, screen()]], 1001);
    const fresh = remember("w1", [[1, screen()]], 1002);
    expect(recallView(old.id, 1003)).toBeUndefined();
    expect(recallView(fresh.id, 1003)).toBe(fresh);
    expect(recallView(other.id, 1003)).toBe(other);
  });

  it("refuses a screen target once its window moved or resized, and when it is gone", async () => {
    const view = remember("w1", [[1, screen()]], 1000);
    const find = (bounds: Box | undefined) => lookupTarget({ view: view.id, n: 1 }, async () => bounds, 1100);
    expect((await find(box)).ok).toBe(true);
    expect(await find({ ...box, x: 11 })).toMatchObject({ ok: false, code: "view_stale" });
    expect(await find({ ...box, width: 201 })).toMatchObject({ ok: false, code: "view_stale" });
    expect(await find(undefined)).toMatchObject({ ok: false, code: "view_stale" });
  });

  it("does not check bounds for a dom target", async () => {
    const view = remember("browser", [[1, { kind: "dom", ref: "s1-e1", role: "button", name: "Go", enabled: true, blocked: false }]], 1000);
    expect((await lookupTarget({ view: view.id, n: 1 }, async () => undefined, 1100)).ok).toBe(true);
  });

  it("has distinct codes for no view, unknown view, unknown number, blocked and disabled", async () => {
    const bounds = async () => box;
    expect(await lookupTarget({ n: 1 }, bounds, 1000)).toMatchObject({ ok: false, code: "no_view" });
    const view = remember("w1", [[1, screen({ enabled: false })], [2, screen({ blocked: true, role: "password text" })], [3, screen()]], 1000);
    expect(await lookupTarget({ view: "v_nope", n: 1 }, bounds, 1100)).toMatchObject({ ok: false, code: "view_unknown" });
    expect(await lookupTarget({ view: view.id, n: 9 }, bounds, 1100)).toMatchObject({ ok: false, code: "number_unknown" });
    expect(await lookupTarget({ view: view.id, n: 1 }, bounds, 1100)).toMatchObject({ ok: false, code: "target_disabled" });
    expect(await lookupTarget({ view: view.id, n: 2 }, bounds, 1100)).toMatchObject({ ok: false, code: "target_blocked" });
    expect(await lookupTarget({ view: view.id, n: 3 }, bounds, 1100)).toMatchObject({ ok: true });
  });
});
