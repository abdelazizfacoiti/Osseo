#!/usr/bin/env python3
"""Drives portal_helper.py against fake_portal.py on a private session bus. Prints one JSON object.

Run it under `dbus-run-session`. It refuses to run on the caller's real session bus: the test passes that
bus address in OSSEO_REAL_BUS, and the private bus address must differ from it.
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FAKE = os.path.join(HERE, "fake_portal.py")
HELPER = os.path.normpath(os.path.join(HERE, "..", "..", "..", "runtime", "portal_helper.py"))


def start_fake(consent, log_path):
    env = dict(os.environ, FAKE_PORTAL_CONSENT=consent, FAKE_PORTAL_LOG=log_path)
    fake = subprocess.Popen([sys.executable, "-I", FAKE], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    if fake.stdout.readline().strip() != "ready":
        raise SystemExit("fake portal did not start: " + fake.stderr.read()[-400:])
    return fake


class Helper:
    def __init__(self):
        self.proc = subprocess.Popen([sys.executable, "-I", HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.first = json.loads(self.proc.stdout.readline())

    def send(self, raw):
        self.proc.stdin.write(raw + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise SystemExit("helper exited: " + self.proc.stderr.read()[-400:])
        return json.loads(line)

    def call(self, cmd):
        return self.send(json.dumps(cmd))

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        self.proc.wait(timeout=20)


def read_log(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def run(consent, workdir, steps):
    """Starts a fake portal with one consent answer, runs the steps, returns (replies, call log)."""
    log_path = os.path.join(workdir, "calls-%s.jsonl" % consent)
    fake = start_fake(consent, log_path)
    helper = Helper()
    try:
        # A string step is sent as-is (a malformed line); anything else is encoded as one JSON request.
        replies = [helper.send(step) if isinstance(step, str) else helper.call(step) for step in steps]
    finally:
        helper.close()
        fake.terminate()
        fake.wait(timeout=20)
    return replies, read_log(log_path)


def main():
    if os.environ.get("DBUS_SESSION_BUS_ADDRESS", "") == os.environ.get("OSSEO_REAL_BUS", "x"):
        print(json.dumps({"error": "refusing to use the real session bus"}))
        return 3
    workdir = tempfile.mkdtemp(prefix="ah-portal-driver-")
    shot = os.path.join(workdir, "shot.png")

    granted, granted_log = run("grant", workdir, [
        {"id": 1, "cmd": "probe"},
        {"id": 2, "cmd": "open", "keyboard": True, "pointer": True, "screen": True, "timeoutMs": 10000},
        {"id": 3, "cmd": "pointer_motion", "x": 100.5, "y": 200},
        {"id": 4, "cmd": "pointer_button", "button": 272, "pressed": True},
        {"id": 5, "cmd": "pointer_button", "button": 272, "pressed": False},
        {"id": 6, "cmd": "keysym", "keysym": 97, "pressed": True},
        {"id": 7, "cmd": "keysym", "keysym": 97, "pressed": False},
        {"id": 8, "cmd": "screenshot", "path": shot, "format": "png"},
        {"id": 9, "cmd": "close"},
    ])
    before_open = run("grant", workdir, [{"id": 10, "cmd": "pointer_motion", "x": 1, "y": 1}])[0]
    malformed = run("grant", workdir, ["this is not json", {"id": 11, "cmd": "launch_missiles"}])[0]
    denied, denied_log = run("deny", workdir, [
        {"id": 20, "cmd": "open", "keyboard": True, "pointer": True, "screen": True, "timeoutMs": 10000},
        {"id": 21, "cmd": "pointer_motion", "x": 1, "y": 1},
        {"id": 22, "cmd": "close"},
    ])
    never, never_log = run("never", workdir, [
        {"id": 30, "cmd": "open", "keyboard": True, "pointer": True, "screen": True, "timeoutMs": 1500},
        {"id": 31, "cmd": "close"},
    ])

    print(json.dumps({
        "granted": granted,
        "grantedLog": granted_log,
        "beforeOpen": before_open,
        "malformed": malformed,
        "denied": denied,
        "deniedLog": denied_log,
        "never": never,
        "neverLog": never_log,
        "shotExists": os.path.exists(shot),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
