import { spawn, type ChildProcess } from "node:child_process";

/*
 * Waits for the person to press the left mouse button inside one of some screen
 * rectangles. One short-lived python3-gi child polls the root window pointer
 * (position and button mask) every 20 ms. It only reads pointer state: no grabs,
 * no windows, no input injection. The same PyGObject dependency as gtk-clipboard.ts.
 */
const HELPER = String.raw`
import json
import sys
import time
import gi
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk
regions = json.loads(sys.argv[1])
deadline = time.monotonic() + int(sys.argv[2]) / 1000.0
display = Gdk.Display.get_default()
root = Gdk.get_default_root_window()
if display is None or root is None:
    sys.stderr.write("no display\n")
    sys.exit(3)
pointer = display.get_default_seat().get_pointer()
def sample():
    _window, x, y, mask = root.get_device_position(pointer)
    return x, y, bool(mask & Gdk.ModifierType.BUTTON1_MASK)
def find(x, y):
    for index, r in enumerate(regions):
        if r["x"] <= x < r["x"] + r["width"] and r["y"] <= y < r["y"] + r["height"]:
            return index
    return -1
down = sample()[2]
while time.monotonic() < deadline:
    x, y, pressed = sample()
    if pressed and not down:
        index = find(x, y)
        if index >= 0:
            sys.stdout.write(json.dumps({"index": index, "x": x, "y": y}) + "\n")
            sys.stdout.flush()
            sys.exit(0)
    down = pressed
    time.sleep(0.02)
sys.exit(4)
`;

export interface PointerRegion { x: number; y: number; width: number; height: number }

export type PointerPressResult =
  | { pressed: true; index: number; x: number; y: number }
  | { pressed: false; reason: "timeout" | "aborted" | "unavailable"; detail?: string };

type WatchChild = Pick<ChildProcess, "stdout" | "on" | "kill"> & { exitCode?: number | null };

export interface PointerWatchOptions {
  regions: PointerRegion[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Test seam: replaces child_process.spawn. */
  spawnProcess?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "ignore"] }) => WatchChild;
}

export async function waitForPointerPress(options: PointerWatchOptions): Promise<PointerPressResult> {
  const { regions, signal } = options;
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  if (signal?.aborted) return { pressed: false, reason: "aborted" };
  if (regions.length === 0) return { pressed: false, reason: "unavailable", detail: "No regions to watch." };
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  return await new Promise<PointerPressResult>((resolve) => {
    let child: WatchChild;
    let settled = false;
    let buffer = "";
    const finish = (result: PointerPressResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try { child?.kill("SIGKILL"); } catch { /* Already gone. */ }
      resolve(result);
    };
    const onAbort = (): void => finish({ pressed: false, reason: "aborted" });
    // The helper stops by itself at the timeout; this is the backstop if it hangs.
    const timer = setTimeout(() => finish({ pressed: false, reason: "timeout" }), timeoutMs + 1_000);
    try {
      child = spawnProcess("python3", ["-I", "-c", HELPER, JSON.stringify(regions), String(timeoutMs)], { env: options.env ?? process.env, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      finish({ pressed: false, reason: "unavailable", detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        try {
          const parsed = JSON.parse(line) as { index?: unknown; x?: unknown; y?: unknown };
          if (typeof parsed.index === "number" && typeof parsed.x === "number" && typeof parsed.y === "number") {
            finish({ pressed: true, index: parsed.index, x: parsed.x, y: parsed.y });
            return;
          }
        } catch { /* Ignore junk lines. */ }
      }
    });
    child.on("error", (error: Error) => finish({ pressed: false, reason: "unavailable", detail: error.message }));
    child.on("close", (code: number | null) => {
      if (code === 4) finish({ pressed: false, reason: "timeout" });
      else finish({ pressed: false, reason: "unavailable", detail: `The pointer helper exited with code ${code ?? "none"}. It needs python3 with PyGObject and a display.` });
    });
  });
}
