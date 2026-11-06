import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backgroundEnvironment, findXephyr, startBackgroundDisplay } from "../background-display.js";
import { captureLinuxScreenshot, clickLinuxDesktop, getLinuxClipboard, setLinuxClipboard, focusLinuxWindow, getLinuxActiveWindow, listLinuxWindows, parseXwininfoChildren, typeLinuxText } from "../desktop.js";

const APP = `
import gi, sys
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
out = sys.argv[1]
win = Gtk.Window(title="Nested probe"); win.set_default_size(300, 120); win.move(0, 0)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
entry = Gtk.Entry(); button = Gtk.Button(label="Press")
entry.connect("changed", lambda e: open(out, "w").write("text:" + e.get_text()))
button.connect("clicked", lambda b: open(out + ".click", "w").write("clicked"))
box.pack_start(entry, False, False, 0); box.pack_start(button, True, True, 0)
win.add(box); win.show_all(); win.connect("destroy", Gtk.main_quit); Gtk.main()
`;

describe("nested display helpers", () => {
  it("parses top-level windows, skipping 1x1 helpers", () => {
    const output = `
     0x400004 "Calculator": ("gnome-calculator" "Gnome-calculator")  360x514+0+0  +0+0
     0x400002 "gnome-calculator": ("gnome-calculator" "gnome-calculator")  1x1+0+0  +0+0
     0x20000a (has no name): ()  164x164+10+20  +10+20`;
    expect(parseXwininfoChildren(output)).toEqual([
      { windowId: "4194308", title: "Calculator", appClass: "Gnome-calculator", bounds: { x: 0, y: 0, width: 360, height: 514 } },
      { windowId: "2097162", bounds: { x: 10, y: 20, width: 164, height: 164 } }
    ]);
  });

  it("points desktop commands at the nested display and drops the person's cookie", () => {
    expect(backgroundEnvironment({ DISPLAY: ":0", XAUTHORITY: "/x", WAYLAND_DISPLAY: "w", PATH: "/bin" }, ":91")).toEqual({ DISPLAY: ":91", XDG_SESSION_TYPE: "x11", PATH: "/bin" });
  });
});

const available = findXephyr() !== undefined && Boolean(process.env.DISPLAY);

describe.skipIf(!available)("nested display (real Xephyr, no window manager)", () => {
  let home: string;
  let out: string;
  let app: ChildProcess;
  let nested: Extract<Awaited<ReturnType<typeof startBackgroundDisplay>>, { ok: true }>;
  const realPointer = () => execFileSync("xdotool", ["getmouselocation", "--shell"], { encoding: "utf8" }).split("\n").slice(0, 2).join(",");

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "agenthost-nested-"));
    out = path.join(home, "probe.txt");
    const started = await startBackgroundDisplay({ width: 800, height: 600, firstDisplay: 100 });
    if (!started.ok) throw new Error(started.reason);
    nested = started;
    app = spawn("python3", ["-W", "ignore", "-c", APP, out], { env: nested.env, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }, 30_000);
  afterAll(async () => {
    app?.kill("SIGTERM");
    await nested?.stop();
    await rm(home, { recursive: true, force: true });
  });

  it("lists, focuses, inspects, screenshots, and drives an app without touching the real pointer", async () => {
    const context = { agentHostDir: home, env: nested.env };
    const before = realPointer();
    const listed = await listLinuxWindows({ includeTitles: true }, context);
    expect(listed.supported).toBe(true);
    const window = listed.windows.find((entry) => entry.title === "Nested probe");
    expect(window).toBeDefined();

    expect((await focusLinuxWindow({ windowId: window!.windowId }, context)).focused).toBe(true);
    const active = await getLinuxActiveWindow(context);
    expect(active.activeWindow?.windowId).toBe(window!.windowId);

    const shot = path.join(home, "shot.png");
    await captureLinuxScreenshot({ path: shot }, context);
    expect((await stat(shot)).size).toBeGreaterThan(500);

    const bounds = window!.bounds!;
    const typed = await typeLinuxText({ text: "hello", activeWindow: active.activeWindow! }, context);
    expect(typed.typed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readFileSync(out, "utf8")).toBe("text:hello");

    const clicked = await clickLinuxDesktop({ x: bounds.x + bounds.width / 2 | 0, y: bounds.y + bounds.height - 30, button: "left", activeWindow: active.activeWindow! }, context);
    expect(clicked.clicked).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(existsSync(`${out}.click`)).toBe(true);
    expect(realPointer()).toBe(before);
  }, 60_000);

  it("sets and reads the clipboard without hanging on xclip's background owner", async () => {
    const context = { agentHostDir: home, env: nested.env };
    const started = Date.now();
    const set = await setLinuxClipboard("hello: world (1), \"quoted\"", context);
    expect(set.supported).toBe(true);
    // Before the fix this took the full 5 s timeout and reported failure.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect((await getLinuxClipboard(context)).text).toBe("hello: world (1), \"quoted\"");
  }, 30_000);
});
