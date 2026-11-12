#!/usr/bin/env python3
"""A fake org.freedesktop.portal.Desktop for tests, on a private session bus.

It offers RemoteDesktop and ScreenCast with the method signatures of the real portal
(checked against an installed xdg-desktop-portal). Like the real portal it answers
Request objects with a Response signal, and it refuses CreateSession without a
session_handle_token ("Missing token").

FAKE_PORTAL_CONSENT chooses the answer to Start: "grant" (default: one stream, node 42),
"deny" (response 1, the person said no), or "never" (no answer, so the caller times out).
FAKE_PORTAL_LOG is a file that gets one JSON line per call. Prints "ready" when the name is owned.
"""
import json
import os
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
CAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
NODE_ID = 42

INTROSPECTION = """
<node>
  <interface name="org.freedesktop.portal.RemoteDesktop">
    <method name="CreateSession">
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <method name="SelectDevices">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <method name="Start">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="s" name="parent_window" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <method name="NotifyPointerMotionAbsolute">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="u" name="stream" direction="in"/>
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
    </method>
    <method name="NotifyPointerButton">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="i" name="button" direction="in"/>
      <arg type="u" name="state" direction="in"/>
    </method>
    <method name="NotifyKeyboardKeysym">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="i" name="keysym" direction="in"/>
      <arg type="u" name="state" direction="in"/>
    </method>
    <property name="AvailableDeviceTypes" type="u" access="read"/>
    <property name="version" type="u" access="read"/>
  </interface>
  <interface name="org.freedesktop.portal.ScreenCast">
    <method name="SelectSources">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="o" name="handle" direction="out"/>
    </method>
    <method name="OpenPipeWireRemote">
      <arg type="o" name="session_handle" direction="in"/>
      <arg type="a{sv}" name="options" direction="in"/>
      <arg type="h" name="fd" direction="out"/>
    </method>
    <property name="AvailableSourceTypes" type="u" access="read"/>
    <property name="version" type="u" access="read"/>
  </interface>
</node>
"""

SESSION_INTROSPECTION = """
<node>
  <interface name="org.freedesktop.portal.Session">
    <method name="Close"/>
  </interface>
</node>
"""

CONSENT = os.environ.get("FAKE_PORTAL_CONSENT", "grant")
LOG_PATH = os.environ.get("FAKE_PORTAL_LOG", "")
state = {"connection": None, "session_ids": []}


def log(entry):
    if not LOG_PATH:
        return
    with open(LOG_PATH, "a", encoding="utf8") as handle:
        handle.write(json.dumps(entry, default=str) + "\n")


def request_path(sender, token):
    return "%s/request/%s/%s" % (PORTAL_PATH, sender, token)


def respond(sender, path, code, results):
    """Answers a Request after the method reply has gone out, as the real portal does."""
    def emit():
        state["connection"].emit_signal(None, path, REQUEST, "Response", GLib.Variant("(ua{sv})", (code, results)))
        return False
    GLib.idle_add(emit)


def start_results():
    streams = [(NODE_ID, {"position": GLib.Variant("(ii)", (0, 0)), "size": GLib.Variant("(ii)", (1920, 1080)), "source_type": GLib.Variant("u", 1)})]
    return {"devices": GLib.Variant("u", 3), "streams": GLib.Variant("a(ua{sv})", streams)}


def on_method(connection, sender, object_path, interface, method, parameters, invocation):
    args = parameters.unpack()
    log({"interface": interface, "method": method, "args": args})
    sender_name = sender[1:].replace(".", "_")
    if interface == REMOTE and method == "CreateSession":
        options = args[0]
        if "session_handle_token" not in options:
            invocation.return_dbus_error("org.freedesktop.portal.Error.Failed", "Missing token")
            return
        path = request_path(sender_name, options.get("handle_token", "none"))
        session = "%s/session/%s/%s" % (PORTAL_PATH, sender_name, options["session_handle_token"])
        invocation.return_value(GLib.Variant("(o)", (path,)))
        register_session(connection, session)
        respond(sender, path, 0, {"session_handle": GLib.Variant("s", session)})
    elif interface == REMOTE and method == "SelectDevices":
        path = request_path(sender_name, args[1].get("handle_token", "none"))
        invocation.return_value(GLib.Variant("(o)", (path,)))
        respond(sender, path, 0, {})
    elif interface == REMOTE and method == "Start":
        path = request_path(sender_name, args[2].get("handle_token", "none"))
        invocation.return_value(GLib.Variant("(o)", (path,)))
        if CONSENT == "grant":
            respond(sender, path, 0, start_results())
        elif CONSENT == "deny":
            respond(sender, path, 1, {})
        # "never": no Response, so the caller's timeout is what ends the wait.
    elif interface == CAST and method == "SelectSources":
        path = request_path(sender_name, args[1].get("handle_token", "none"))
        invocation.return_value(GLib.Variant("(o)", (path,)))
        respond(sender, path, 0, {})
    elif interface == CAST and method == "OpenPipeWireRemote":
        invocation.return_dbus_error("org.freedesktop.DBus.Error.NotSupported", "The test portal has no PipeWire node.")
    elif interface == REMOTE and method.startswith("Notify"):
        invocation.return_value(None)
    else:
        invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", "Unknown method %s" % method)


def on_session_method(connection, sender, object_path, interface, method, parameters, invocation):
    log({"interface": interface, "method": method, "path": object_path})
    invocation.return_value(None)


def register_session(connection, path):
    node = Gio.DBusNodeInfo.new_for_xml(SESSION_INTROSPECTION)
    connection.register_object(path, node.interfaces[0], on_session_method, None, None)
    state["session_ids"].append(path)


def on_get_property(connection, sender, object_path, interface, name):
    values = {
        (REMOTE, "AvailableDeviceTypes"): GLib.Variant("u", 3),
        (REMOTE, "version"): GLib.Variant("u", 2),
        (CAST, "AvailableSourceTypes"): GLib.Variant("u", 7),
        (CAST, "version"): GLib.Variant("u", 5),
    }
    return values.get((interface, name))


def on_bus_acquired(connection, _name):
    state["connection"] = connection
    node = Gio.DBusNodeInfo.new_for_xml(INTROSPECTION)
    connection.register_object(PORTAL_PATH, node.interfaces[0], on_method, on_get_property, None)
    connection.register_object(PORTAL_PATH, node.interfaces[1], on_method, on_get_property, None)


def on_name_acquired(_connection, _name):
    sys.stdout.write("ready\n")
    sys.stdout.flush()


def main():
    loop = GLib.MainLoop()
    Gio.bus_own_name(Gio.BusType.SESSION, PORTAL, Gio.BusNameOwnerFlags.NONE, on_bus_acquired, on_name_acquired, lambda *_: loop.quit())
    loop.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
