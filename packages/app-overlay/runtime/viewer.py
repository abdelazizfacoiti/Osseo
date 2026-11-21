#!/usr/bin/env python3
"""Osseo background viewer: a small window that shows the agent's display.

It reads a picture file written by the frame source and the run-state files
under the agent home. It never captures the screen and never writes into the
agent home. Pause, Resume and Stop run the same `osseo agent ...` commands
the terminal uses, only on a real click.
"""
import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from overlay_input import device_node_from_props, node_is_physical  # noqa: E402

import gi  # noqa: E402
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402

REFRESH_MS = 500
TITLE = "Osseo background view"

# Same commands as the CLI: agent pause / agent resume --pause / agent stop.
ACTIONS = {
    "pause": ["agent", "pause"],
    "resume": ["agent", "resume", "--pause"],
    "stop": ["agent", "stop"],
}


def run_dir(agent_home):
    return os.path.join(agent_home, "run")


def read_status(agent_home, have_frame):
    """Status line from the run-state files. Reading only."""
    run = run_dir(agent_home)
    if os.path.exists(os.path.join(run, "stop.requested")):
        return "Stopped"
    if os.path.exists(os.path.join(run, "takeover.active")):
        return "Waiting for you"
    if os.path.exists(os.path.join(run, "pause.requested")):
        return "Paused"
    if not have_frame:
        return "Waiting for the first picture"
    return "Working on the background display"


def current_event_device_name():
    event = Gtk.get_current_event()
    if event is None:
        return None, None
    try:
        device = event.get_source_device()
        return event, device
    except Exception:
        return event, None


def pointer_activated():
    event = Gtk.get_current_event()
    if event is None:
        return False
    return event.type in {Gdk.EventType.BUTTON_RELEASE, Gdk.EventType.BUTTON_PRESS, Gdk.EventType.TOUCH_END}


def synthetic_source():
    _, device = current_event_device_name()
    try:
        return device is not None and "xtest" in (device.get_name() or "").lower()
    except Exception:
        return False


def physical_source():
    """True only when the click provably came from real hardware (not uinput, not XTEST)."""
    _, device = current_event_device_name()
    if device is None:
        return False
    try:
        device_id = device.get_property("device-id")
        props = subprocess.run(["xinput", "list-props", str(device_id)], capture_output=True, text=True, timeout=1)
        return props.returncode == 0 and node_is_physical(device_node_from_props(props.stdout))
    except Exception:
        return False


class ViewerWindow(Gtk.Window):
    def __init__(self, frame, agent_home, cli):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.frame = frame
        self.agent_home = agent_home
        self.cli = list(cli)
        self.pixbuf = None
        self.frame_mtime = None
        self.set_title(TITLE)
        self.set_default_size(640, 400)
        self.set_resizable(True)
        self.set_focus_on_map(False)
        self.connect("destroy", lambda *_: Gtk.main_quit())

        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=4)
        self.add(box)
        self.area = Gtk.DrawingArea()
        self.area.set_hexpand(True)
        self.area.set_vexpand(True)
        self.area.connect("draw", self.on_draw)
        box.pack_start(self.area, True, True, 0)
        self.status = Gtk.Label(label="")
        self.status.set_xalign(0)
        self.status.set_margin_start(8)
        box.pack_start(self.status, False, False, 0)
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        row.set_margin_start(8)
        row.set_margin_end(8)
        row.set_margin_bottom(8)
        self.buttons = {}
        for key, label in (("pause", "Pause"), ("resume", "Resume"), ("stop", "Stop")):
            button = Gtk.Button(label=label)
            # Keyboard activation (focus + space/enter) must not work; only a pointer click does.
            button.set_can_focus(False)
            button.set_focus_on_click(False)
            button.connect("clicked", self.on_button, key)
            row.pack_start(button, True, True, 0)
            self.buttons[key] = button
        box.pack_start(row, False, False, 0)
        self.refresh()
        GLib.timeout_add(REFRESH_MS, self.tick)

    def stop_file(self):
        return os.path.join(run_dir(self.agent_home), "viewer.stop")

    def tick(self):
        if os.path.exists(self.stop_file()):
            Gtk.main_quit()
            return False
        self.refresh()
        return True

    def load_frame(self):
        try:
            mtime = os.stat(self.frame).st_mtime_ns
        except OSError:
            return
        if mtime == self.frame_mtime:
            return
        try:
            self.pixbuf = GdkPixbuf.Pixbuf.new_from_file(self.frame)
            self.frame_mtime = mtime
            self.area.queue_draw()
        except Exception:
            # A half-written or missing file: keep the last picture.
            pass

    def refresh(self):
        self.load_frame()
        self.status.set_text(read_status(self.agent_home, self.pixbuf is not None))

    def on_draw(self, widget, cr):
        width, height = widget.get_allocated_width(), widget.get_allocated_height()
        cr.set_source_rgb(0.1, 0.1, 0.1)
        cr.paint()
        if self.pixbuf is None:
            return False
        source_w, source_h = self.pixbuf.get_width(), self.pixbuf.get_height()
        scale = min(width / source_w, height / source_h)
        target_w, target_h = max(1, int(source_w * scale)), max(1, int(source_h * scale))
        scaled = self.pixbuf.scale_simple(target_w, target_h, GdkPixbuf.InterpType.BILINEAR)
        Gdk.cairo_set_source_pixbuf(cr, scaled, (width - target_w) / 2, (height - target_h) / 2)
        cr.paint()
        return False

    def on_button(self, _button, key):
        # Only a pointer click counts. Pause and Stop also refuse injected (XTEST) clicks;
        # Resume needs proof of real hardware, like the card buttons.
        if not pointer_activated() or synthetic_source():
            return
        if key == "resume" and not physical_source():
            return
        self.run_action(key)

    def run_action(self, key):
        arguments = ACTIONS[key]
        env = dict(os.environ)
        env["OSSEO_HOME"] = self.agent_home
        try:
            subprocess.Popen(self.cli + arguments, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frame", required=True)
    parser.add_argument("--agent-home", required=True)
    parser.add_argument("--node", default=None)
    parser.add_argument("--entry", default=None)
    parser.add_argument("--selftest", action="store_true")
    options = parser.parse_args()
    cli = [options.node, options.entry] if options.node and options.entry else ["osseo"]
    window = ViewerWindow(options.frame, options.agent_home, cli)
    if options.selftest:
        print(json.dumps({"title": window.get_title(), "status": window.status.get_text(), "buttons": sorted(window.buttons), "hasFrame": window.pixbuf is not None}))
        return 0
    window.show_all()
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
