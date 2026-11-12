import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeDir = fileURLToPath(new URL("../../runtime/", import.meta.url));

function python<T>(body: string): T {
  const script = `import json, sys\nsys.path.insert(0, sys.argv[1])\nimport overlay_geometry as g\n${body}`;
  return JSON.parse(execFileSync("python3", ["-c", script, runtimeDir], { encoding: "utf8" })) as T;
}

describe("rail geometry", () => {
  it("returns the collapsed strip, the expanded panel and the strut", () => {
    const rects = python<Record<string, unknown>>(`print(json.dumps({
  "right": g.rail_rects((0, 0, 1920, 1080), "right", 345),
  "left": g.rail_rects((0, 0, 1920, 1080), "left", 345),
  "second_monitor": g.rail_rects((1920, 0, 1280, 720), "right", 240),
  "tiny": g.rail_rects((0, 0, 200, 600), "right", 500)
}))`);
    expect(rects).toEqual({
      right: { collapsed: [1872, 0, 48, 1080], expanded: [1527, 0, 345, 1080], strut: 48 },
      left: { collapsed: [0, 0, 48, 1080], expanded: [48, 0, 345, 1080], strut: 48 },
      second_monitor: { collapsed: [3152, 0, 48, 720], expanded: [2912, 0, 240, 720], strut: 48 },
      tiny: { collapsed: [152, 0, 48, 600], expanded: [0, 0, 152, 600], strut: 48 }
    });
  });

  it("decides collapsed or expanded without GTK", () => {
    const out = python<Record<string, boolean>>(`print(json.dumps({
  "idle": g.rail_expanded(False, None),
  "hover": g.rail_expanded(True, None),
  "just_left": g.rail_expanded(False, 799),
  "after_800": g.rail_expanded(False, 800),
  "approval": g.rail_expanded(False, 5000, attention=True),
  "error": g.rail_expanded(False, 5000, error=True)
}))`);
    expect(out).toEqual({ idle: false, hover: true, just_left: true, after_800: false, approval: true, error: true });
  });

  it("reads status and a three-word action from the timeline components", () => {
    const out = python<unknown>(`
entries = [{"label": "Click the Save button now", "state": "running"}, {"label": "Open", "state": "done"}]
print(json.dumps({
  "running": g.rail_status([{"type": "status_badge", "text": "Working"}, {"type": "timeline", "entries": entries}]),
  "waiting": g.rail_status([{"type": "status_badge", "text": "Waiting for you"}, {"type": "timeline", "entries": []}]),
  "stopped": g.rail_status([{"type": "status_badge", "text": "Stopped"}]),
  "paused": g.rail_status([{"type": "status_badge", "text": "Paused"}]),
  "failed": g.rail_status([{"type": "status_badge", "text": "Idle"}, {"type": "timeline", "entries": [{"label": "x", "state": "failed"}]}]),
  "none": g.rail_status([]),
  "long": g.rail_words("Extraordinarily long words everywhere"),
  "empty": g.rail_words("")
}))`);
    expect(out).toEqual({
      running: ["running", "Click the Save", false, false],
      waiting: ["waiting", "Idle", true, false],
      stopped: ["stopped", "Idle", false, true],
      paused: ["paused", "Idle", false, false],
      failed: ["idle", "Idle", false, true],
      none: ["idle", "Idle", false, false],
      long: "Extrao. long words",
      empty: "Idle"
    });
  });
});

describe("rail on a nested display", () => {
  it("passes the selftest (skips without Xephyr or python3-gi)", () => {
    const result = spawnSync("python3", [`${runtimeDir}rail_selftest.py`], { encoding: "utf8", timeout: 90_000 });
    if (result.status === 77) return;
    expect(result.stdout + result.stderr).toContain("RESULT PASS");
    expect(result.status).toBe(0);
  });
});
