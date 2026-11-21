#!/usr/bin/env python3
"""Osseo Wayland portal helper.

Talks to the XDG desktop portal (org.freedesktop.portal.Desktop) on the person's
session bus. RemoteDesktop sends keyboard and pointer input; ScreenCast captures the
shared screen through PipeWire. One RemoteDesktop Start asks the person once, and that
one answer covers input and capture.

Protocol: one JSON request per line on stdin, one JSON reply per line on stdout. The
first line is {"event": "ready"} (or {"event": "fatal"} when there is no session bus).
Log text goes to stderr only. The portal ends a session when the caller's bus connection
goes away, so this process owns at most one session and must stay alive while it is used.

Commands: probe, open, pointer_motion, pointer_button, keysym, screenshot, close.
"""
import json
import os
import secrets
import shutil
import sys
import tempfile

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

PORTAL = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
CAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
PROPERTIES = "org.freedesktop.DBus.Properties"

DEVICE_KEYBOARD = 1
DEVICE_POINTER = 2
SOURCE_MONITOR = 1
CURSOR_EMBEDDED = 2
RESPONSE_OK = 0
RESPONSE_CANCELLED = 1
DEFAULT_OPEN_TIMEOUT_MS = 180000
CALL_TIMEOUT_MS = 15000


class PortalError(Exception):
    def __init__(self, code, message=None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def classify(error):
    """Maps a DBus error to a stable code. A missing portal service is not a crash."""
    text = error.message or ""
    if any(name in text for name in ("ServiceUnknown", "NameHasNoOwner", "UnknownObject", "UnknownMethod")):
        return "portal_unavailable"
    return "portal_error"


def capture_to(path, fd, node, fmt, quality, timeout_ms):
    """One frame from the PipeWire node into an image file, through GStreamer's API (no command-line parsing)."""
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst

    Gst.init(None)
    pipeline = Gst.Pipeline.new("osseo-capture")
    source = Gst.ElementFactory.make("pipewiresrc", "source")
    convert = Gst.ElementFactory.make("videoconvert", "convert")
    encoder = Gst.ElementFactory.make("pngenc" if fmt == "png" else "jpegenc", "encoder")
    sink = Gst.ElementFactory.make("filesink", "sink")
    if source is None or convert is None or encoder is None or sink is None:
        raise PortalError("gstreamer_missing", "Screenshots through the portal need gstreamer1.0-pipewire and gstreamer1.0-plugins-good.")
    source.set_property("fd", fd)
    source.set_property("path", str(node))
    source.set_property("num-buffers", 1)
    if fmt != "png":
        encoder.set_property("quality", int(quality))
    sink.set_property("location", path)
    for element in (source, convert, encoder, sink):
        pipeline.add(element)
    if not (source.link(convert) and convert.link(encoder) and encoder.link(sink)):
        raise PortalError("gstreamer_link_failed", "The capture pipeline could not be linked.")
    bus = pipeline.get_bus()
    pipeline.set_state(Gst.State.PLAYING)
    try:
        message = bus.timed_pop_filtered(timeout_ms * Gst.MSECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    finally:
        pipeline.set_state(Gst.State.NULL)
    if message is None:
        raise PortalError("capture_timeout", "No frame arrived within %d s." % (timeout_ms // 1000))
    if message.type == Gst.MessageType.ERROR:
        error, _debug = message.parse_error()
        raise PortalError("capture_failed", error.message)


class Helper:
    def __init__(self, bus):
        self.bus = bus
        # The portal names request objects after the caller's unique name: ":1.234" becomes "1_234".
        self.sender = bus.get_unique_name()[1:].replace(".", "_")
        self.session = None
        self.streams = []
        self.devices = 0

    # --- portal plumbing -----------------------------------------------------

    def call_request(self, iface, method, build, timeout_ms):
        """Calls a portal method that answers with a request object, then waits for its Response signal.

        The subscription is made before the call, at the request path the portal uses for this sender
        and handle token, so the Response cannot be missed. If the reply names another path, the
        subscription moves to that path. Returns (response_code, results)."""
        token = "osseo_" + secrets.token_hex(8)
        expected = "%s/request/%s/%s" % (PORTAL_PATH, self.sender, token)
        options = {"handle_token": GLib.Variant("s", token)}
        seen = {}
        loop = GLib.MainLoop()

        def on_response(_connection, _sender, _path, _iface, _signal, parameters):
            code, results = parameters.unpack()
            seen["code"] = code
            seen["results"] = results
            loop.quit()

        def expire():
            seen["timeout"] = True
            loop.quit()
            return False

        subscription = self.bus.signal_subscribe(PORTAL, REQUEST, "Response", expected, None, Gio.DBusSignalFlags.NONE, on_response)
        timer = None
        try:
            reply = self.bus.call_sync(PORTAL, PORTAL_PATH, iface, method, build(options), GLib.VariantType.new("(o)"), Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, None)
            handle = reply.unpack()[0]
            if handle != expected:
                self.bus.signal_unsubscribe(subscription)
                subscription = self.bus.signal_subscribe(PORTAL, REQUEST, "Response", handle, None, Gio.DBusSignalFlags.NONE, on_response)
            timer = GLib.timeout_add(timeout_ms, expire)
            loop.run()
        finally:
            self.bus.signal_unsubscribe(subscription)
            if timer is not None and "timeout" not in seen:
                GLib.source_remove(timer)
        if "timeout" in seen:
            raise PortalError("portal_timeout", "The portal did not answer within %d s." % (timeout_ms // 1000))
        return seen["code"], seen["results"]

    def create_session(self, timeout_ms):
        """RemoteDesktop.CreateSession. The portal also needs a session_handle_token, or it answers "Missing token"."""
        session_token = "osseo_" + secrets.token_hex(8)

        def build(options):
            return GLib.Variant("(a{sv})", (dict(options, session_handle_token=GLib.Variant("s", session_token)),))

        return self.call_request(REMOTE, "CreateSession", build, timeout_ms)

    def notify(self, method, signature, values):
        self.bus.call_sync(PORTAL, PORTAL_PATH, REMOTE, method, GLib.Variant(signature, values), None, Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, None)

    def get_properties(self, iface):
        reply = self.bus.call_sync(PORTAL, PORTAL_PATH, PROPERTIES, "GetAll", GLib.Variant("(s)", (iface,)), GLib.VariantType.new("(a{sv})"), Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, None)
        return reply.unpack()[0]

    def close_portal_session(self, handle):
        try:
            self.bus.call_sync(PORTAL, handle, SESSION, "Close", None, None, Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, None)
        except GLib.Error:
            pass

    def require_open(self):
        if self.session is None:
            raise PortalError("not_open", "No portal session is open. Open one first.")

    def first_node(self, cmd):
        if cmd.get("node") is not None:
            return int(cmd["node"])
        if not self.streams:
            raise PortalError("no_streams", "The portal session has no screen stream.")
        return self.streams[0]["node"]

    # --- commands --------------------------------------------------------------

    def probe(self):
        """Reads the portal's properties and creates and closes one session. Shows nothing on screen."""
        remote = self.get_properties(REMOTE)
        cast = self.get_properties(CAST)
        code, results = self.create_session(DEFAULT_OPEN_TIMEOUT_MS)
        handle = results.get("session_handle") if code == RESPONSE_OK else None
        if handle:
            self.close_portal_session(handle)
        if code != RESPONSE_OK or not handle:
            raise PortalError("create_session_failed", "CreateSession answered %d." % code)
        return {
            "availableDeviceTypes": int(remote.get("AvailableDeviceTypes", 0)),
            "remoteDesktopVersion": int(remote.get("version", 0)),
            "availableSourceTypes": int(cast.get("AvailableSourceTypes", 0)),
            "screenCastVersion": int(cast.get("version", 0)),
            "sessionCreated": True,
        }

    def open(self, keyboard, pointer, screen, timeout_ms):
        """One consent: CreateSession, SelectDevices, SelectSources (screen only), then Start, which shows the dialog."""
        if self.session is not None:
            raise PortalError("already_open", "A portal session is already open.")
        code, results = self.create_session(timeout_ms)
        handle = results.get("session_handle") if code == RESPONSE_OK else None
        if not handle:
            raise PortalError("create_session_failed", "CreateSession answered %d." % code)
        try:
            types = (DEVICE_KEYBOARD if keyboard else 0) | (DEVICE_POINTER if pointer else 0)
            if types:
                code, _results = self.call_request(REMOTE, "SelectDevices", lambda options: GLib.Variant("(oa{sv})", (handle, dict(options, types=GLib.Variant("u", types)))), timeout_ms)
                if code != RESPONSE_OK:
                    raise PortalError("select_devices_failed", "SelectDevices answered %d." % code)
            if screen:
                code, _results = self.call_request(CAST, "SelectSources", lambda options: GLib.Variant("(oa{sv})", (handle, dict(options, types=GLib.Variant("u", SOURCE_MONITOR), cursor_mode=GLib.Variant("u", CURSOR_EMBEDDED)))), timeout_ms)
                if code != RESPONSE_OK:
                    raise PortalError("select_sources_failed", "SelectSources answered %d." % code)
            code, results = self.call_request(REMOTE, "Start", lambda options: GLib.Variant("(osa{sv})", (handle, "", options)), timeout_ms)
            if code == RESPONSE_CANCELLED:
                raise PortalError("consent_denied", "The person did not allow remote control.")
            if code != RESPONSE_OK:
                raise PortalError("start_failed", "Start answered %d." % code)
            streams = []
            for node, props in results.get("streams", []):
                x, y = props.get("position", (0, 0))
                width, height = props.get("size", (0, 0))
                streams.append({"node": int(node), "x": int(x), "y": int(y), "width": int(width), "height": int(height)})
            if screen and not streams:
                raise PortalError("no_streams", "The portal gave no screen stream.")
        except BaseException:
            self.close_portal_session(handle)
            raise
        self.session = handle
        self.devices = int(results.get("devices", 0))
        self.streams = streams
        return {"devices": self.devices, "streams": self.streams}

    def pointer_motion(self, cmd):
        self.require_open()
        self.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)", (self.session, {}, self.first_node(cmd), float(cmd["x"]), float(cmd["y"])))
        return {}

    def pointer_button(self, cmd):
        self.require_open()
        self.notify("NotifyPointerButton", "(oa{sv}iu)", (self.session, {}, int(cmd["button"]), 1 if cmd["pressed"] else 0))
        return {}

    def keysym(self, cmd):
        self.require_open()
        self.notify("NotifyKeyboardKeysym", "(oa{sv}iu)", (self.session, {}, int(cmd["keysym"]), 1 if cmd["pressed"] else 0))
        return {}

    def screenshot(self, cmd):
        self.require_open()
        path = cmd["path"]
        fmt = "png" if cmd.get("format", "png") == "png" else "jpeg"
        if not os.path.isabs(path):
            raise PortalError("bad_path", "The screenshot path must be absolute.")
        if not os.path.isdir(os.path.dirname(path)):
            raise PortalError("bad_path", "The folder for the screenshot does not exist.")
        node = self.first_node(cmd)
        reply, fd_list = self.bus.call_with_unix_fd_list_sync(PORTAL, PORTAL_PATH, CAST, "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (self.session, {})), GLib.VariantType.new("(h)"), Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, None, None)
        pipewire_fd = os.dup(fd_list.get(reply.unpack()[0]))
        staging = os.path.join(tempfile.gettempdir(), "ah-portal-%s.%s" % (secrets.token_hex(6), "png" if fmt == "png" else "jpg"))
        try:
            capture_to(staging, pipewire_fd, node, fmt, cmd.get("quality", 85), DEFAULT_OPEN_TIMEOUT_MS // 12)
            shutil.move(staging, path)
        finally:
            os.close(pipewire_fd)
            if os.path.exists(staging):
                os.remove(staging)
        return {"path": path, "bytesWritten": os.path.getsize(path), "format": fmt}

    def close(self):
        if self.session is not None:
            self.close_portal_session(self.session)
        self.session = None
        self.streams = []
        return {"closed": True}

    def dispatch(self, cmd):
        name = cmd.get("cmd")
        if name == "probe":
            return self.probe()
        if name == "open":
            return self.open(bool(cmd.get("keyboard", True)), bool(cmd.get("pointer", True)), bool(cmd.get("screen", False)), int(cmd.get("timeoutMs", DEFAULT_OPEN_TIMEOUT_MS)))
        if name == "pointer_motion":
            return self.pointer_motion(cmd)
        if name == "pointer_button":
            return self.pointer_button(cmd)
        if name == "keysym":
            return self.keysym(cmd)
        if name == "screenshot":
            return self.screenshot(cmd)
        if name == "close":
            return self.close()
        raise PortalError("unknown_command", "Unknown command: %s" % name)


def main():
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as error:
        emit({"event": "fatal", "code": "no_session_bus", "message": error.message})
        return 1
    helper = Helper(bus)
    emit({"event": "ready"})
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except ValueError:
            emit({"ok": False, "code": "bad_request", "message": "The request is not JSON."})
            continue
        if not isinstance(cmd, dict):
            emit({"id": None, "ok": False, "code": "bad_request", "message": "The request must be a JSON object."})
            continue
        ident = cmd.get("id")
        try:
            result = helper.dispatch(cmd)
            emit(dict(result, id=ident, ok=True))
        except PortalError as error:
            emit({"id": ident, "ok": False, "code": error.code, "message": error.message})
        except (KeyError, TypeError, ValueError) as error:
            emit({"id": ident, "ok": False, "code": "bad_request", "message": "Missing or invalid field: %s" % error})
        except GLib.Error as error:
            emit({"id": ident, "ok": False, "code": classify(error), "message": error.message})
        if cmd.get("cmd") == "close":
            break
    helper.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
