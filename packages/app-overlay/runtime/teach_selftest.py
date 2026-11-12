#!/usr/bin/env python3
"""Selftest of the Teach-mode card on a NESTED display. Never touches the real display.

    python3 teach_selftest.py

Starts Xephyr on a free display number, shows a teach card, and checks the three
buttons, that the card sits beside its box, and that a synthetic Next press is
ignored. Real pointer presses cannot be made here. Exits 0 on success, 77
(skipped) when Xephyr or python3-gi is missing.
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
    box = {"x": 100, "y": 100, "width": 80, "height": 40}
    target = {"kind": "window_region", "windowId": "w", "bounds": box, "sensitivity": "public"}

    def card(components, events):
        return {"overlayId": "teach-1", "type": "widget", "payload": {
            "title": "Step 2 of 3", "placement": "top_right", "sensitivity": "public", "target": target,
            "interaction": {"interactive": True, "focus": "never", "dismissible": False, "allowedEvents": events},
            "components": components}}

    record = card([{"type": "text", "text": "Click Save"},
                   {"type": "button", "label": "Back", "event": "back"},
                   {"type": "button", "label": "Next", "event": "next"}], ["back", "next"])
    print(json.dumps({"show": renderer.show(record)}))
    for _ in range(20):
        renderer.pump(5)
        time.sleep(0.02)
    stored = renderer.records.get("teach-1")
    ui = renderer.cards.get("teach-1")
    check("teach card is shown", stored is not None and ui is not None)
    check("record is recognised as a teach card", renderer.is_teach_card(stored))
    check("next and back are control events, not trust events",
          {"next", "back"} <= module.CONTROL_EVENTS and not ({"next", "back"} & module.TRUST_EVENTS))
    footer = ui["footer"]
    labels = [child.get_label() for child in footer.get_children()]
    check("footer has Back and Next", labels == ["Back", "Next"], labels)
    check("buttons are enabled", all(child.get_sensitive() for child in footer.get_children()))
    x, y = ui["window"].get_position()
    w, h = ui["window"].get_size()
    beside = x >= box["x"] + box["width"] or x + w <= box["x"] or y >= box["y"] + box["height"] or y + h <= box["y"]
    check("card does not cover its box", beside, (x, y, w, h))

    before = len(renderer.events)
    for button in footer.get_children():
        button.emit("clicked")
    renderer.pump(5)
    check("synthetic Back and Next presses emit no event", len(renderer.events) == before, len(renderer.events) - before)

    plain = {"overlayId": "plain-1", "type": "widget", "payload": {"title": "x", "sensitivity": "public", "components": [{"type": "text", "text": "x"}],
             "interaction": {"interactive": True, "focus": "never", "dismissible": False, "allowedEvents": ["next"]}}}
    renderer.show(plain)
    check("a card without a box is not a teach card", not renderer.is_teach_card(renderer.records.get("plain-1")))
    print("RESULT " + ("FAIL" if failures else "PASS") + " on " + display)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(child() if "--child" in sys.argv else parent())
