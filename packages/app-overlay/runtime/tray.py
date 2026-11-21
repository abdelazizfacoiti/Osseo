#!/usr/bin/env python3
"""Osseo tray icon: a StatusNotifierItem (org.kde.StatusNotifierItem) on the session bus.

Shows the agent's state (running, paused, stopped, waiting for approval) and offers
Stop, Pause, Resume, Open viewer and Quit tray. GNOME needs the AppIndicator
extension to show it; KDE shows it natively. The menu is a Gtk.Menu popped up at the
pointer (the DBusMenu protocol is not used).

The tray only reads run/stop.requested, run/pause.requested and run/activity.json.
Every action runs a fixed argument list (no shell). The tray never writes into the
agent home; the only file it touches is its own run/tray.pid, which it removes on exit.
"""
import argparse
import json
import os
import signal
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import gi  # noqa: E402
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

REFRESH_SECONDS = 2
ITEM_PATH = "/StatusNotifierItem"
WATCHER_NAME = "org.kde.StatusNotifierWatcher"
WATCHER_PATH = "/StatusNotifierWatcher"

NODE_XML = """
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="u" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="ContextMenu"><arg type="i" name="x" direction="in"/><arg type="i" name="y" direction="in"/></method>
    <method name="Activate"><arg type="i" name="x" direction="in"/><arg type="i" name="y" direction="in"/></method>
    <method name="SecondaryActivate"><arg type="i" name="x" direction="in"/><arg type="i" name="y" direction="in"/></method>
    <method name="Scroll"><arg type="i" name="delta" direction="in"/><arg type="s" name="orientation" direction="in"/></method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg type="s" name="status"/></signal>
  </interface>
</node>
"""

# State -> (tooltip text, icon name, Status). Standard icon names from the freedesktop theme.
STATES = {
    "running": ("Osseo: running", "dialog-information", "Active"),
    "paused": ("Osseo: paused", "media-playback-pause", "Active"),
    "stopped": ("Osseo: stopped", "process-stop", "Active"),
    "approval": ("Osseo: waiting for approval", "dialog-warning", "NeedsAttention"),
}

# Menu key -> (label, arguments after `node <entry>`). Fixed lists, never built from input.
ACTIONS = {
    "stop": ("Stop", ["agent", "stop"]),
    "pause": ("Pause", ["agent", "pause"]),
    "resume": ("Resume", ["agent", "resume", "--pause"]),
    "viewer": ("Open viewer", ["viewer", "start"]),
}


def run_dir(agent_home):
    return os.path.join(agent_home, "run")


def read_state(agent_home):
    """running | paused | stopped | approval, from the run-state files. Reading only."""
    run = run_dir(agent_home)
    if os.path.exists(os.path.join(run, "stop.requested")):
        return "stopped"
    if os.path.exists(os.path.join(run, "pause.requested")):
        return "paused"
    try:
        with open(os.path.join(run, "activity.json"), "r", encoding="utf8") as handle:
            record = json.load(handle)
        if isinstance(record, dict) and record.get("phase") == "finished" and record.get("outcome") == "approval_required":
            return "approval"
    except (OSError, ValueError):
        pass
    return "running"


def build_command(key, node, entry):
    """The exact argument list for a menu action."""
    if key not in ACTIONS:
        raise KeyError(key)
    return [node, entry] + list(ACTIONS[key][1])


def run_action(key, node, entry, agent_home, popen=subprocess.Popen):
    """Run one action with a fixed argument list and no shell. `popen` is injectable."""
    env = dict(os.environ)
    env["OSSEO_HOME"] = agent_home
    try:
        popen(build_command(key, node, entry), env=env, shell=False, stdin=subprocess.DEVNULL,
              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except OSError:
        return False


class Tray:
    def __init__(self, agent_home, node, entry, pid_file=None, popen=subprocess.Popen):
        self.agent_home = agent_home
        self.node = node
        self.entry = entry
        self.pid_file = pid_file or os.path.join(run_dir(agent_home), "tray.pid")
        self.popen = popen
        self.state = read_state(agent_home)
        self.connection = None
        self.owner_id = 0
        self.registration_id = 0
        self.watch_id = 0
        self.bus_name = "org.kde.StatusNotifierItem-%d-1" % os.getpid()
        self.loop = GLib.MainLoop()
        self.menu = None
        self.node_info = Gio.DBusNodeInfo.new_for_xml(NODE_XML)

    # --- properties -------------------------------------------------------------
    def properties(self):
        text, icon, status = STATES[self.state]
        return {
            "Category": GLib.Variant("s", "ApplicationStatus"),
            "Id": GLib.Variant("s", "osseo"),
            "Title": GLib.Variant("s", "Osseo"),
            "Status": GLib.Variant("s", status),
            "WindowId": GLib.Variant("u", 0),
            "IconName": GLib.Variant("s", icon),
            "OverlayIconName": GLib.Variant("s", ""),
            "AttentionIconName": GLib.Variant("s", "dialog-warning"),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", (icon, [], "Osseo", text)),
            "ItemIsMenu": GLib.Variant("b", False),
            "Menu": GLib.Variant("o", "/NO_DBUSMENU"),
        }

    def on_get_property(self, _conn, _sender, _path, _iface, name):
        return self.properties().get(name)

    def on_method(self, _conn, _sender, _path, _iface, method, _params, invocation):
        if method in ("Activate", "ContextMenu"):
            GLib.idle_add(self.show_menu)
        invocation.return_value(None)

    # --- bus --------------------------------------------------------------------
    def start(self):
        self.owner_id = Gio.bus_own_name(
            Gio.BusType.SESSION, self.bus_name, Gio.BusNameOwnerFlags.NONE,
            self.on_bus_acquired, None, None)
        self.watch_id = Gio.bus_watch_name(
            Gio.BusType.SESSION, WATCHER_NAME, Gio.BusNameWatcherFlags.NONE,
            self.on_watcher_appeared, None)
        GLib.timeout_add_seconds(REFRESH_SECONDS, self.tick)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, self.quit)
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, self.quit)

    def on_bus_acquired(self, connection, _name):
        self.connection = connection
        self.registration_id = connection.register_object(
            ITEM_PATH, self.node_info.interfaces[0], self.on_method, self.on_get_property, None)

    def on_watcher_appeared(self, connection, _name, _owner):
        # Also fires again if the watcher restarts, so the icon comes back.
        self.register_with_watcher(connection)

    def register_with_watcher(self, connection):
        connection.call(
            WATCHER_NAME, WATCHER_PATH, WATCHER_NAME, "RegisterStatusNotifierItem",
            GLib.Variant("(s)", (self.bus_name,)), None, Gio.DBusCallFlags.NONE, 2000, None,
            self.on_registered)

    def on_registered(self, connection, result):
        try:
            connection.call_finish(result)
        except GLib.Error as error:
            sys.stderr.write("tray: register failed: %s\n" % error.message)

    def emit(self, signal_name, params=None):
        if self.connection is None:
            return
        try:
            self.connection.emit_signal(None, ITEM_PATH, "org.kde.StatusNotifierItem", signal_name, params)
        except GLib.Error:
            pass

    def tick(self):
        state = read_state(self.agent_home)
        if state != self.state:
            self.state = state
            self.emit("NewStatus", GLib.Variant("(s)", (STATES[state][2],)))
            self.emit("NewIcon")
            self.emit("NewToolTip")
        return True

    # --- menu -------------------------------------------------------------------
    def show_menu(self):
        try:
            gi.require_version("Gtk", "3.0")
            gi.require_version("Gdk", "3.0")
            from gi.repository import Gtk
            if not Gtk.init_check()[0]:
                return False
            if self.menu is not None:
                self.menu.destroy()
            self.menu = Gtk.Menu()
            for key in ("stop", "pause", "resume", "viewer"):
                item = Gtk.MenuItem(label=ACTIONS[key][0])
                item.connect("activate", self.on_item, key)
                self.menu.append(item)
            self.menu.append(Gtk.SeparatorMenuItem())
            quit_item = Gtk.MenuItem(label="Quit tray")
            quit_item.connect("activate", lambda *_: self.quit())
            self.menu.append(quit_item)
            self.menu.show_all()
            self.menu.popup_at_pointer(None)
        except Exception as error:  # a missing display must not take the tray down
            sys.stderr.write("tray: menu failed: %s\n" % error)
        return False

    def on_item(self, _item, key):
        # Same rule as the viewer window: pointer-style activation, not injected (XTEST) input.
        if key in ("stop", "pause", "resume"):
            try:
                from viewer import pointer_activated, synthetic_source, physical_source
                if not pointer_activated() or synthetic_source():
                    return
                if key == "resume" and not physical_source():
                    return
            except Exception:
                return
        run_action(key, self.node, self.entry, self.agent_home, self.popen)

    # --- exit -------------------------------------------------------------------
    def quit(self, *_):
        self.loop.quit()
        return False

    def cleanup(self):
        """Unregister (release the bus name), unexport and remove our PID file."""
        if self.watch_id:
            Gio.bus_unwatch_name(self.watch_id)
            self.watch_id = 0
        if self.connection is not None and self.registration_id:
            self.connection.unregister_object(self.registration_id)
            self.registration_id = 0
        if self.owner_id:
            Gio.bus_unown_name(self.owner_id)
            self.owner_id = 0
        if self.connection is not None:
            try:
                self.connection.flush_sync(None)
            except GLib.Error:
                pass
        try:
            with open(self.pid_file, "r", encoding="utf8") as handle:
                recorded = json.load(handle).get("pid")
            if recorded == os.getpid():
                os.remove(self.pid_file)
        except (OSError, ValueError, AttributeError):
            pass

    def run(self):
        self.start()
        try:
            self.loop.run()
        finally:
            self.cleanup()


def quit_running(agent_home):
    """--quit: ask the tray named in run/tray.pid to exit (SIGTERM). Returns 0 or 1."""
    try:
        with open(os.path.join(run_dir(agent_home), "tray.pid"), "r", encoding="utf8") as handle:
            pid = int(json.load(handle)["pid"])
        os.kill(pid, signal.SIGTERM)
        return 0
    except (OSError, ValueError, KeyError, TypeError):
        return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent-home", required=True)
    parser.add_argument("--node", default=None)
    parser.add_argument("--entry", default=None)
    parser.add_argument("--quit", action="store_true")
    options = parser.parse_args()
    if options.quit:
        return quit_running(options.agent_home)
    if not options.node or not options.entry:
        sys.stderr.write("tray: --node and --entry are required\n")
        return 2
    Tray(options.agent_home, options.node, options.entry).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
