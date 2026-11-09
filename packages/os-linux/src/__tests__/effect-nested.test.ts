import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findXephyr, startBackgroundDisplay } from "../background-display.js";
import { captureLinuxScreenshot, clickLinuxDesktop, focusLinuxWindow, getLinuxActiveWindow, listLinuxWindows } from "../desktop.js";
import { measureEffect } from "../effect.js";

// "Does nothing" must not change the window. "Change label" must.
const APP = `
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
win = Gtk.Window(title="Effect probe")
win.set_default_size(320, 160)
win.move(0, 0)
fixed = Gtk.Fixed()
label = Gtk.Label(label="idle")
label.set_size_request(280, 20)
fixed.put(label, 20, 8)
nothing = Gtk.Button(label="Does nothing")
nothing.set_size_request(200, 40)
fixed.put(nothing, 20, 100)
change = Gtk.Button(label="Change label")
change.set_size_request(200, 40)
change.connect("clicked", lambda b: label.set_text("changed"))
fixed.put(change, 20, 40)
win.add(fixed)
win.show_all()
win.connect("destroy", Gtk.main_quit)
Gtk.main()
`;

const available = findXephyr() !== undefined && Boolean(process.env.DISPLAY);

describe.skipIf(!available)("effect measurement on a nested display", () => {
  let home: string;
  let app: ChildProcess | undefined;
  let nested: Extract<Awaited<ReturnType<typeof startBackgroundDisplay>>, { ok: true }>;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "agenthost-effect-"));
    const started = await startBackgroundDisplay({ width: 800, height: 600, firstDisplay: 110 });
    if (!started.ok) throw new Error(started.reason);
    nested = started;
    app = spawn("python3", ["-W", "ignore", "-c", APP], { env: nested.env, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }, 30_000);

  afterAll(async () => {
    app?.kill("SIGTERM");
    await nested?.stop();
    await rm(home, { recursive: true, force: true });
  });

  it("tells a click that did nothing apart from one that changed the window", async () => {
    const context = { agentHostDir: home, env: nested.env };
    const listed = await listLinuxWindows({ includeTitles: true }, context);
    const win = listed.windows?.find((entry) => entry.title === "Effect probe");
    expect(win).toBeDefined();
    const bounds = win!.bounds!;
    await focusLinuxWindow({ windowId: win!.windowId }, context);
    const active = (await getLinuxActiveWindow(context)).activeWindow!;

    const capture = async (): Promise<Buffer | undefined> => {
      const file = path.join(home, `shot-${randomUUID()}.png`);
      try {
        const shot = await captureLinuxScreenshot({ path: file, includeActiveWindowOnly: true }, context);
        return shot.supported === true ? await readFile(file) : undefined;
      } finally {
        await rm(file, { force: true });
      }
    };
    const hover = (x: number, y: number) => () => {
      execFileSync("xdotool", ["mousemove", String(bounds.x + x), String(bounds.y + y)], { env: nested.env });
      return Promise.resolve();
    };
    const click = (x: number, y: number) => clickLinuxDesktop({ x: bounds.x + x, y: bounds.y + y, button: "left", activeWindow: active }, context);

    const nothing = await measureEffect({ capture, prepare: hover(120, 120) }, () => click(120, 120));
    expect(nothing.value.clicked).toBe(true);
    expect(nothing.effect.screenChanged).toBe(false);

    const changed = await measureEffect({ capture, prepare: hover(120, 60) }, () => click(120, 60));
    expect(changed.value.clicked).toBe(true);
    expect(changed.effect.screenChanged).toBe(true);
  }, 60_000);
});
