import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The tray talks D-Bus, so the bus part runs on a PRIVATE session bus
 * (`dbus-run-session`) with a fake org.kde.StatusNotifierWatcher. Nothing here
 * can reach the real session bus or any display: the driver refuses to run if its
 * bus address equals the caller's real one, and Gtk is never imported (the menu is
 * only built on Activate/ContextMenu, which the driver does not call).
 */

const trayPy = fileURLToPath(new URL("../../runtime/tray.py", import.meta.url));
const runtimeDir = path.dirname(trayPy);
const hasSession = spawnSync("dbus-run-session", ["--version"]).status === 0;
const hasGi = spawnSync("python3", ["-c", "import gi; gi.require_version('Gio','2.0')"]).status === 0;

describe.skipIf(!hasGi)("tray.py actions", () => {
  it("builds the exact fixed argument lists", () => {
    const script = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(runtimeDir)})`,
      "import tray",
      "calls = []",
      "def fake(args, **kw):",
      "    calls.append({'args': args, 'shell': kw.get('shell'), 'home': kw['env']['OSSEO_HOME']})",
      "for key in ['stop', 'pause', 'resume', 'viewer']:",
      "    assert tray.run_action(key, '/n/node', '/e/index.js', '/h', fake)",
      "try:",
      "    tray.build_command('rm', 'a', 'b'); bad = False",
      "except KeyError:",
      "    bad = True",
      "print(json.dumps({'calls': calls, 'unknownRefused': bad}))"
    ].join("\n");
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", script], { encoding: "utf8" })) as { calls: Array<{ args: string[]; shell: boolean; home: string }>; unknownRefused: boolean };
    expect(out.calls.map((call) => call.args)).toEqual([
      ["/n/node", "/e/index.js", "agent", "stop"],
      ["/n/node", "/e/index.js", "agent", "pause"],
      ["/n/node", "/e/index.js", "agent", "resume", "--pause"],
      ["/n/node", "/e/index.js", "viewer", "start"]
    ]);
    expect(out.calls.every((call) => call.shell === false && call.home === "/h")).toBe(true);
    expect(out.unknownRefused).toBe(true);
  });

  it("menu actions need a real pointer press; resume also needs physical hardware", () => {
    const script = [
      "import json, os, sys, tempfile, types",
      `sys.path.insert(0, ${JSON.stringify(runtimeDir)})`,
      "import tray",
      "home = tempfile.mkdtemp()",
      "def run_case(pointer, synthetic, physical):",
      "    fake = types.ModuleType('viewer')",
      "    fake.pointer_activated = lambda: pointer",
      "    fake.synthetic_source = lambda: synthetic",
      "    fake.physical_source = lambda: physical",
      "    sys.modules['viewer'] = fake",
      "    calls = []",
      "    item = tray.Tray(home, '/n/node', '/e/index.js', pid_file=os.path.join(home, 'tray.pid'), popen=lambda args, **kw: calls.append(args[2:]))",
      "    for key in ['stop', 'pause', 'resume', 'viewer']:",
      "        item.on_item(None, key)",
      "    return calls",
      "print(json.dumps({",
      "    'synthetic': run_case(True, True, True),",
      "    'notPhysical': run_case(True, False, False),",
      "    'noPointer': run_case(False, False, True),",
      "    'physical': run_case(True, False, True)",
      "}))"
    ].join("\n");
    const out = JSON.parse(execFileSync("python3", ["-I", "-c", script], { encoding: "utf8" })) as Record<string, string[][]>;
    // Injected (XTEST) clicks and clicks without a pointer run nothing but Open viewer.
    expect(out.synthetic).toEqual([["viewer", "start"]]);
    expect(out.noPointer).toEqual([["viewer", "start"]]);
    // Resume also needs hardware proven by sysfs (physical_source); Stop and Pause do not.
    expect(out.notPhysical).toEqual([["agent", "stop"], ["agent", "pause"], ["viewer", "start"]]);
    expect(out.physical).toEqual([["agent", "stop"], ["agent", "pause"], ["agent", "resume", "--pause"], ["viewer", "start"]]);
  });

  it("derives the state from the run files", () => {
    const agentHome = mkdtempSync(path.join(os.tmpdir(), "osseo-tray-state-"));
    const script = [
      "import json, os, sys",
      `sys.path.insert(0, ${JSON.stringify(runtimeDir)})`,
      "import tray",
      "home = sys.argv[1]; run = os.path.join(home, 'run'); os.makedirs(run)",
      "seen = [tray.read_state(home)]",
      "open(os.path.join(run, 'activity.json'), 'w').write(json.dumps({'phase': 'finished', 'outcome': 'approval_required'}))",
      "seen.append(tray.read_state(home))",
      "open(os.path.join(run, 'pause.requested'), 'w').write('x')",
      "seen.append(tray.read_state(home))",
      "open(os.path.join(run, 'stop.requested'), 'w').write('x')",
      "seen.append(tray.read_state(home))",
      "print(json.dumps(seen))"
    ].join("\n");
    expect(JSON.parse(execFileSync("python3", ["-I", "-c", script, agentHome], { encoding: "utf8" }))).toEqual(["running", "approval", "paused", "stopped"]);
  });
});

const DRIVER = String.raw`
import json, os, signal, subprocess, sys, time
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

real_address, agent_home, tray_py = sys.argv[1], sys.argv[2], sys.argv[3]
address = os.environ["DBUS_SESSION_BUS_ADDRESS"]
if not address or address == real_address:
    print(json.dumps({"error": "not a private bus"})); sys.exit(3)

items = []
XML = """<node><interface name="org.kde.StatusNotifierWatcher">
<method name="RegisterStatusNotifierItem"><arg type="s" name="service" direction="in"/></method>
<property name="RegisteredStatusNotifierItems" type="as" access="read"/>
<property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
<property name="ProtocolVersion" type="i" access="read"/>
</interface></node>"""
conn = {"c": None}

def props(_c, _s, _p, _i, name):
    if name == "RegisteredStatusNotifierItems": return GLib.Variant("as", list(items))
    if name == "IsStatusNotifierHostRegistered": return GLib.Variant("b", True)
    if name == "ProtocolVersion": return GLib.Variant("i", 0)

def method(_c, sender, _p, _i, name, params, inv):
    if name == "RegisterStatusNotifierItem":
        items.append(params.unpack()[0])
    inv.return_value(None)

def acquired(c, _n):
    conn["c"] = c
    c.register_object("/StatusNotifierWatcher", Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], method, props, None)

Gio.bus_own_name(Gio.BusType.SESSION, "org.kde.StatusNotifierWatcher", Gio.BusNameOwnerFlags.NONE, acquired, None, None)
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

def on_gone(_c, _s, _p, _i, _sig, params):
    name, old, new = params.unpack()
    if new == "" and name in items: items.remove(name)
bus.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged", None, None, Gio.DBusSignalFlags.NONE, on_gone)

def pump(seconds=0.05):
    end = time.time() + seconds
    while time.time() < end:
        while GLib.MainContext.default().iteration(False): pass
        time.sleep(0.01)

def wait(cond, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        pump(0.05)
        try:
            if cond(): return True
        except GLib.Error: pass
    return False

def get(name, prop):
    proxy = Gio.DBusProxy.new_sync(bus, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES, None, name, "/StatusNotifierItem", "org.freedesktop.DBus.Properties", None)
    return proxy.call_sync("Get", GLib.Variant("(ss)", ("org.kde.StatusNotifierItem", prop)), Gio.DBusCallFlags.NONE, 2000, None).unpack()[0]

env = dict(os.environ)
env["DISPLAY"] = ""
env.pop("WAYLAND_DISPLAY", None)
run = os.path.join(agent_home, "run"); os.makedirs(run, exist_ok=True)
child = subprocess.Popen([sys.executable, tray_py, "--agent-home", agent_home, "--node", "node", "--entry", "x.js"], env=env)
with open(os.path.join(run, "tray.pid"), "w") as f: json.dump({"pid": child.pid}, f)

out = {}
out["registered"] = wait(lambda: len(items) == 1)
name = items[0] if items else None
out["registeredName"] = name
out["props"] = {k: get(name, k) for k in ("Id", "Category", "Title", "Status", "IconName")} if name else {}
out["tooltipRunning"] = get(name, "ToolTip")[3] if name else None

def flag(file, text="x"):
    with open(os.path.join(run, file), "w") as f: f.write(text)

def tip(): return get(name, "ToolTip")[3]
flag("pause.requested")
out["pausedSeen"] = wait(lambda: tip() == "Osseo: paused", 8)
out["pausedIcon"] = get(name, "IconName")
os.remove(os.path.join(run, "pause.requested"))
flag("activity.json", json.dumps({"phase": "finished", "outcome": "approval_required"}))
out["approvalSeen"] = wait(lambda: get(name, "Status") == "NeedsAttention", 8)
out["approvalTip"] = tip()
flag("stop.requested")
out["stoppedSeen"] = wait(lambda: tip() == "Osseo: stopped", 8)
out["stoppedStatus"] = get(name, "Status")

child.send_signal(signal.SIGTERM)
try: out["exit"] = child.wait(timeout=10)
except subprocess.TimeoutExpired:
    child.kill(); out["exit"] = "timeout"
out["unregistered"] = wait(lambda: items == [], 5)
out["pidFileRemoved"] = not os.path.exists(os.path.join(run, "tray.pid"))
print("RESULT " + json.dumps(out))
`;

describe.skipIf(!hasSession || !hasGi)("tray.py on a private session bus", () => {
  it("registers with a fake watcher, follows the run state and unregisters on SIGTERM", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "osseo-tray-bus-"));
    const driver = path.join(dir, "driver.py");
    writeFileSync(driver, DRIVER);
    const agentHome = path.join(dir, "home");
    const env = { ...process.env, DISPLAY: "", WAYLAND_DISPLAY: "" };
    const real = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
    const run = spawnSync("dbus-run-session", ["--", "python3", "-I", driver, real, agentHome, trayPy], { encoding: "utf8", env, timeout: 90_000 });
    const line = run.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
    expect(line, `stdout=${run.stdout} stderr=${run.stderr}`).toBeDefined();
    const out = JSON.parse(line!.slice(7)) as Record<string, unknown> & { props: Record<string, string> };
    expect(out.registered).toBe(true);
    expect(String(out.registeredName)).toMatch(/^org\.kde\.StatusNotifierItem-\d+-1$/);
    expect(out.props).toMatchObject({ Id: "osseo", Category: "ApplicationStatus", Title: "Osseo", Status: "Active", IconName: "dialog-information" });
    expect(out.tooltipRunning).toBe("Osseo: running");
    expect(out.pausedSeen).toBe(true);
    expect(out.pausedIcon).toBe("media-playback-pause");
    expect(out.approvalSeen).toBe(true);
    expect(out.approvalTip).toBe("Osseo: waiting for approval");
    expect(out.stoppedSeen).toBe(true);
    expect(out.stoppedStatus).toBe("Active");
    expect(out.exit).toBe(0);
    expect(out.unregistered).toBe(true);
    expect(out.pidFileRemoved).toBe(true);
    expect(existsSync(path.join(agentHome, "run", "tray.pid"))).toBe(false);
  }, 100_000);
});
