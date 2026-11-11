import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findXephyr, startBackgroundDisplay } from "../background-display.js";
import { waitForPointerPress } from "../pointer-watch.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  return child;
}
const regions = [{ x: 10, y: 10, width: 50, height: 50 }, { x: 100, y: 100, width: 20, height: 20 }];
const watch = (child: ReturnType<typeof fakeChild>, extra: object = {}) =>
  waitForPointerPress({ regions, timeoutMs: 5_000, spawnProcess: () => child as never, ...extra });

describe("waitForPointerPress", () => {
  it("resolves on a JSON line, ignores junk, and kills the child", async () => {
    const child = fakeChild();
    const promise = watch(child);
    child.stdout.write("noise\n{not json\n{\"index\":1,\"x\":105,\"y\":110}\n");
    expect(await promise).toEqual({ pressed: true, index: 1, x: 105, y: 110 });
    expect(child.kill).toHaveBeenCalled();
  });

  it("reads a line split across chunks", async () => {
    const child = fakeChild();
    const promise = watch(child);
    child.stdout.write("{\"index\":0,\"x\"");
    child.stdout.write(":12,\"y\":13}\n");
    expect(await promise).toMatchObject({ pressed: true, index: 0 });
  });

  it("reports timeout when the helper exits with its timeout code", async () => {
    const child = fakeChild();
    const promise = watch(child);
    child.emit("close", 4);
    expect(await promise).toEqual({ pressed: false, reason: "timeout" });
    expect(child.kill).toHaveBeenCalled();
  });

  it("reports timeout from the backstop timer and kills a hung child", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const promise = watch(child, { timeoutMs: 100 });
      await vi.advanceTimersByTimeAsync(1_200);
      expect(await promise).toEqual({ pressed: false, reason: "timeout" });
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports aborted and kills the child", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const promise = watch(child, { signal: controller.signal });
    controller.abort();
    expect(await promise).toEqual({ pressed: false, reason: "aborted" });
    expect(child.kill).toHaveBeenCalled();
  });

  it("is aborted at once when the signal is already aborted", async () => {
    const spawnProcess = vi.fn();
    const result = await waitForPointerPress({ regions, timeoutMs: 1000, signal: AbortSignal.abort(), spawnProcess });
    expect(result).toEqual({ pressed: false, reason: "aborted" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("reports unavailable when python is missing", async () => {
    const child = fakeChild();
    const promise = watch(child);
    child.emit("error", Object.assign(new Error("spawn python3 ENOENT"), { code: "ENOENT" }));
    expect(await promise).toMatchObject({ pressed: false, reason: "unavailable" });
    expect(child.kill).toHaveBeenCalled();
  });

  it("reports unavailable when the helper fails without a press", async () => {
    const child = fakeChild();
    const promise = watch(child);
    child.emit("close", 3);
    expect(await promise).toMatchObject({ pressed: false, reason: "unavailable" });
  });

  it("reports unavailable when spawn throws", async () => {
    const result = await waitForPointerPress({ regions, timeoutMs: 1000, spawnProcess: () => { throw new Error("boom"); } });
    expect(result).toMatchObject({ pressed: false, reason: "unavailable", detail: "boom" });
  });

  it("passes env and the regions to the helper", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const promise = waitForPointerPress({ regions, timeoutMs: 5000, env: { DISPLAY: ":99" }, spawnProcess });
    child.emit("close", 4);
    await promise;
    const call = spawnProcess.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(call[2].env.DISPLAY).toBe(":99");
    expect(JSON.parse(call[1][3]!)).toEqual(regions);
  });
});

function hasGi(): boolean {
  try {
    execFileSync("python3", ["-c", "import gi; gi.require_version('Gdk','3.0'); from gi.repository import Gdk"], { stdio: "ignore" });
    return true;
  } catch { return false; }
}
function hasXdotool(): boolean {
  try { execFileSync("xdotool", ["version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const nestedAvailable = findXephyr() !== undefined && Boolean(process.env.DISPLAY) && hasXdotool() && hasGi();

describe.skipIf(!nestedAvailable)("waitForPointerPress on a nested display", () => {
  let nested: Extract<Awaited<ReturnType<typeof startBackgroundDisplay>>, { ok: true }>;
  beforeAll(async () => {
    const started = await startBackgroundDisplay({ width: 800, height: 600, firstDisplay: 115 });
    if (!started.ok) throw new Error(started.reason);
    nested = started;
  }, 30_000);
  afterAll(async () => { await nested?.stop(); });

  const xdo = (...args: string[]) => execFileSync("xdotool", args, { env: nested.env });
  // A person holds the button for tens of milliseconds; xdotool click releases at once and the 20 ms poll would miss it.
  const press = async () => { xdo("mousedown", "1"); await new Promise((resolve) => setTimeout(resolve, 120)); xdo("mouseup", "1"); };

  it("ignores a press outside every region and reports one inside", async () => {
    const promise = waitForPointerPress({ regions: [{ x: 300, y: 200, width: 100, height: 80 }], timeoutMs: 15_000, env: nested.env });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    xdo("mousemove", "50", "50");
    await press();
    await new Promise((resolve) => setTimeout(resolve, 300));
    xdo("mousemove", "350", "240");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await press();
    const result = await promise;
    expect(result).toMatchObject({ pressed: true, index: 0 });
    if (result.pressed) {
      expect(result.x).toBe(350);
      expect(result.y).toBe(240);
    }
  }, 30_000);
});
