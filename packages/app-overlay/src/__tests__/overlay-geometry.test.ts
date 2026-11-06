import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeDir = fileURLToPath(new URL("../../runtime/", import.meta.url));
const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
import overlay_geometry as geometry
area = (66, 32, 1854, 1048)
print(json.dumps({
    "ring_clamped": geometry.ring_placement([(0, 0, 1920, 1080, 1)], (-24, -24, 48, 48)),
    "ring_second_monitor": geometry.ring_placement([(0, 0, 1920, 1080, 1), (1920, 0, 1920, 1080, 1)], (1910, 100, 20, 20)),
    "card_avoids_point": geometry.card_position(area, 380, 120, "top_center", point={"x": 900, "y": 56}),
    "card_clamps_to_work_area": geometry.card_position(area, 380, 120, "top_right", user_position=(99999, -99999))
}))
`;

describe("overlay geometry", () => {
  it("clamps cards and rings to the work area and avoids targets", () => {
    const output = execFileSync("python3", ["-c", script, runtimeDir], { encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({
      ring_clamped: [0, 0, 104, 104],
      ring_second_monitor: [1920, 72, 76, 76],
      card_avoids_point: [90, 56],
      card_clamps_to_work_area: [1516, 56]
    });
  });

  it("keeps the dock timeline clear of bottom cards at any size", () => {
    const layoutScript = `
import json, sys
sys.path.insert(0, sys.argv[1])
import overlay_geometry as g
cases = {
    "none": g.dock_layout(1080, 0, [228]),
    "empty_timeline_room": g.dock_layout(1080, 198, [228]),
    "long_timeline": g.dock_layout(1080, 1300, [228]),
    "tall_task_card": g.dock_layout(1080, 1300, [900]),
    "small_screen": g.dock_layout(600, 1300, [320]),
    "no_task_card": g.dock_layout(1080, 1300, []),
    "two_bottom": g.dock_layout(1080, 1300, [228, 228]),
}
print(json.dumps(cases))
`;
    const cases = JSON.parse(execFileSync("python3", ["-c", layoutScript, runtimeDir], { encoding: "utf8" })) as Record<string, { timeline: number; bottom: Array<{ y: number; height: number }> }>;
    for (const [name, layout] of Object.entries(cases)) {
      const top = Math.min(...layout.bottom.map((card) => card.y), 1080 - 24);
      expect(layout.timeline + 24 <= top || layout.bottom.length === 0, name).toBe(true);
      for (const card of layout.bottom) expect(card.y + card.height, name).toBeLessThanOrEqual(1080 - 24 + (name === "small_screen" ? -480 : 0));
    }
    expect(cases.none!.timeline).toBe(0);
    expect(cases.empty_timeline_room!.timeline).toBe(198);
    expect(cases.long_timeline!.bottom).toEqual([{ y: 828, height: 228 }]);
    expect(cases.long_timeline!.timeline).toBe(780);
    expect(cases.tall_task_card!.timeline).toBeGreaterThanOrEqual(96);
    expect(cases.no_task_card!.timeline).toBe(1032);
    expect(cases.two_bottom!.bottom[0]!.y).toBeGreaterThan(cases.two_bottom!.bottom[1]!.y);
  });

  it("treats only uinput sysfs paths as virtual and fails closed on anything unknown", () => {
    const inputScript = `
import json, sys
sys.path.insert(0, sys.argv[1])
import overlay_input as i
paths = {
    "/sys/class/input/event5": "/sys/devices/virtual/input/input30/event5",
    "/sys/class/input/event6": "/sys/devices/pci0000:00/0000:00:14.0/usb1/1-2/input/input7/event6",
    "/sys/class/input/event7": "/sys/devices/virtual/misc/uhid/0005:046D:B023.0006/input/input22/event7",
    "/sys/class/input/event9": "/sys/class/input/event9"
}
look = lambda p: paths.get(p, p)
print(json.dumps({
    "uinput": i.node_is_physical("/dev/input/event5", look),
    "usb": i.node_is_physical("/dev/input/event6", look),
    "bluetooth": i.node_is_physical("/dev/input/event7", look),
    "missing": i.node_is_physical("/dev/input/event9", look),
    "none": i.node_is_physical(None, look),
    "node": i.device_node_from_props('\\tDevice Node (283):\\t"/dev/input/event12"'),
    "no_node": i.device_node_from_props("Device Enabled (163): 1")
}))
`;
    expect(JSON.parse(execFileSync("python3", ["-c", inputScript, runtimeDir], { encoding: "utf8" }))).toEqual({
      uinput: false, usb: true, bluetooth: true, missing: false, none: false, node: "/dev/input/event12", no_node: null
    });
  });
});
