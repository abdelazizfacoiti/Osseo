/*
 * A private D-Bus session bus, with its own runtime directory, for scripts that open nested displays.
 *
 * Why: the accessibility bus lives at $XDG_RUNTIME_DIR/at-spi/bus_<display>. A test run that shared the
 * person's session started its own at-spi launcher on that same path, and when it exited it deleted the
 * socket the real launcher was still advertising. Every later AT-SPI lookup then failed until the launcher
 * was restarted. Under this bus the test's accessibility services bind a temp directory and never touch the
 * real one.
 *
 * Usage: const bus = startPrivateBus(); ... children inherit process.env ...; bus.stop().
 * Without dbus-daemon it returns { shared: true } and changes nothing.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function hasCommand(name) {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Every process whose environment names this runtime directory (the daemon and what it started). */
function pidsUsing(runtimeDir) {
  const needle = Buffer.from(`XDG_RUNTIME_DIR=${runtimeDir}\0`);
  const pids = [];
  let entries = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return pids;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`).includes(needle)) pids.push(Number(entry));
    } catch {
      /* Gone, or not ours. */
    }
  }
  return pids;
}

export function startPrivateBus(env = process.env) {
  if (process.platform !== "linux" || !hasCommand("dbus-daemon")) return { shared: true, stop() {} };
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "osseo-bus-"));
  const childEnv = { ...env, XDG_RUNTIME_DIR: runtimeDir };
  delete childEnv.DBUS_SESSION_BUS_ADDRESS;
  let address;
  try {
    const out = execFileSync("dbus-daemon", ["--session", "--fork", "--print-address"], { env: childEnv, encoding: "utf8" });
    address = out.trim().split("\n")[0];
  } catch {
    rmSync(runtimeDir, { recursive: true, force: true });
    return { shared: true, stop() {} };
  }
  const previous = { XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS };
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.DBUS_SESSION_BUS_ADDRESS = address;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const pid of pidsUsing(runtimeDir)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      rmSync(runtimeDir, { recursive: true, force: true });
    } catch {
      /* A service may still be closing its socket; the directory is harmless. */
    }
  };
  process.once("exit", stop);
  return { shared: false, runtimeDir, address, stop };
}
