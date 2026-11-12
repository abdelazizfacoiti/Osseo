#!/usr/bin/env python3
"""Selftest of the rail layout on a NESTED display. Never touches the real display.

    python3 rail_selftest.py

Starts Xephyr on a free display number, runs the renderer's Renderer class
inside it with layout "rail", and checks the strut, the collapsed and expanded
states, the status text, and that a synthetic Stop press is ignored. Exits 0 on
success, 77 (skipped) when Xephyr or python3-gi is missing.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
import warnings

warnings.simplefilter("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))


def free_display():
    for number in range(40, 90):
        if not os.path.exists("/tmp/.X11-unix/X%d" % number):
            lock = "/tmp/.X%d-lock" % number
            if os.path.exists(lock):
                try:
                    os.kill(int(open(lock).read().strip()), 0)
                    continue
                except (OSError, ValueError):
                    pass
            return number
    return None


def parent():
    if shutil.which("Xephyr") is None:
        print("SKIP: Xephyr is not installed")
        return 77
    try:
        import gi  # noqa: F401
    except Exception:
        print("SKIP: python3-gi is not installed")
        return 77
    number = free_display()
    if number is None:
        print("SKIP: no free display number")
        return 77
    display = ":%d" % number
    server = subprocess.Popen(["Xephyr", display, "-screen", "1000x600", "-ac", "-noreset"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            if os.path.exists("/tmp/.X11-unix/X%d" % number):
                break
            time.sleep(0.1)
        else:
            print("SKIP: Xephyr did not start")
            return 77
        env = {key: value for key, value in os.environ.items() if key not in {"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"}}
        env["DISPLAY"] = display
        env["GDK_BACKEND"] = "x11"
        return subprocess.run([sys.executable, os.path.abspath(__file__), "--child"], env=env, timeout=60).returncode
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


def child():
    sys.path.insert(0, HERE)
    spec = importlib.util.spec_from_file_location("gtk3_renderer", os.path.join(HERE, "gtk3-renderer.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    Gtk, Gdk = module.Gtk, module.Gdk
    display = os.environ["DISPLAY"]
    if os.environ.get("DISPLAY", "").split(".")[0] in {":0", ":1"}:
        print("FAIL: refusing to run on a real display")
        return 1
    failures = []

    def check(name, ok, detail=""):
        print(("PASS " if ok else "FAIL ") + name + (" " + str(detail) if detail != "" else ""))
        if not ok:
            failures.append(name)

    renderer = module.Renderer()
    renderer.capability = lambda: {"supported": True}  # Xephyr has no compositor
    renderer.apply_visual_config({"layout": "rail", "dockSide": "right", "dockWidthPercent": 20, "dockReserveSpace": True})
    stop_payload = {"interaction": {"interactive": True, "focus": "never", "dismissible": False, "allowedEvents": ["emergency_stop_requested"]}, "sensitivity": "public"}

    def timeline(badge, entries):
        return {"overlayId": module.TIMELINE_ID_PREFIX + "t", "type": "widget", "payload": {
            "title": "Agent activity", "placement": "top_right", "sensitivity": "public",
            "interaction": {"interactive": True, "focus": "never", "dismissible": True, "allowedEvents": ["dismissed"]},
            "components": [{"type": "status_badge", "status": "info", "text": badge}, {"type": "timeline", "entries": entries}]}}

    action = {"overlayId": "action-1", "type": "widget", "payload": {"title": "Action", "placement": "bottom_right", "components": [
        {"type": "text", "text": "Clicking"}, {"type": "button", "label": "Stop", "event": "emergency_stop_requested"}], **stop_payload}}
    entries = [{"label": "Click Save button now", "state": "running", "time": "12:00"}]
    print(json.dumps({"show_action": renderer.show(action), "show_timeline": renderer.show(timeline("Working", entries))}))
    for _ in range(20):
        renderer.pump(5)
        time.sleep(0.02)

    screen = Gdk.Screen.get_default()
    width, height = screen.get_width(), screen.get_height()
    rail = renderer.dock_window
    check("rail window exists", rail is not None and renderer.rail is not None)
    x, y = rail.get_position()
    w, h = rail.get_size()
    check("collapsed strip is 48 px on the right edge", (x, w) == (width - 48, 48), (x, y, w, h))
    check("status is running", renderer.rail["status"] == "running", renderer.rail["status"])
    check("action is three words", renderer.rail["action"].get_text() == "Click Save button", renderer.rail["action"].get_text())

    xid = rail.get_window().get_xid()
    strut = subprocess.run(["xprop", "-id", str(xid), "_NET_WM_STRUT"], capture_output=True, text=True).stdout.strip()
    check("strut reserves 48 px on the right", "= 0, 48, 0, 0," in strut, strut)

    def dock_cards_visible():
        return [bool(renderer.cards[key]["window"].get_visible()) for key in renderer.cards]

    check("collapsed: dock cards hidden", not any(dock_cards_visible()), dock_cards_visible())
    check("collapsed: Stop is enabled by the card that allows it", renderer.rail["stop"].get_sensitive())

    # Pointer enters: expands.
    renderer.rail_enter(rail, None)
    renderer.pump(10)
    check("hover expands", renderer.rail["expanded"] is True and all(dock_cards_visible()), dock_cards_visible())
    panel = renderer.dock_geometry()
    card_windows = [renderer.cards[key]["window"].get_position() for key in renderer.cards]
    check("expanded panel sits beside the strip", panel[0] + panel[2] == width - 48 and all(p[0] >= panel[0] for p in card_windows), (panel, card_windows))

    # Pointer leaves: stays for 800 ms, then collapses.
    renderer.rail["hover"] = False
    renderer.rail["left_at"] = time.monotonic()
    renderer.rail_refresh()
    check("stays expanded just after leaving", renderer.rail["expanded"] is True)
    renderer.rail["left_at"] = time.monotonic() - 0.9
    renderer.rail_refresh()
    renderer.pump(10)
    check("collapses 800 ms after leaving", renderer.rail["expanded"] is False and not any(dock_cards_visible()))

    # Approval keeps it expanded.
    renderer.show(timeline("Waiting for you", entries))
    renderer.pump(10)
    renderer.rail_refresh()
    check("waiting for approval: dot is waiting and rail stays expanded", renderer.rail["status"] == "waiting" and renderer.rail["expanded"] is True)
    renderer.show(timeline("Working", []))
    renderer.pump(10)
    renderer.rail_refresh()
    renderer.rail["left_at"] = time.monotonic() - 2
    renderer.rail_refresh()
    check("idle fallback text", renderer.rail["action"].get_text() == "Idle", renderer.rail["action"].get_text())
    renderer.show(timeline("Stopped", [{"label": "x", "state": "halted", "time": "12:01"}]))
    renderer.rail_refresh()
    check("stopped keeps it expanded", renderer.rail["status"] == "stopped" and renderer.rail["expanded"] is True)

    # A programmatic click has no real pointer event: Stop must be ignored.
    before = len(renderer.events)
    renderer.rail["stop"].emit("clicked")
    renderer.pump(5)
    check("synthetic Stop press emits no event", len(renderer.events) == before)

    renderer.destroy_dock()
    check("closing the rail frees the strut window", renderer.dock_window is None and renderer.rail is None)
    print("RESULT " + ("FAIL" if failures else "PASS") + " on " + display)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(child() if "--child" in sys.argv else parent())
