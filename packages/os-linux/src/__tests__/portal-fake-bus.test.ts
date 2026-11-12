import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The real portal_helper.py against fake_portal.py (RemoteDesktop and ScreenCast with the installed portal's
 * method signatures). Both run on a PRIVATE bus from `dbus-run-session`. driver.py refuses to run when its bus
 * address equals the caller's real one (AGENTHOST_REAL_BUS), so nothing here reaches the person's session.
 */

const driver = fileURLToPath(new URL("./portal/driver.py", import.meta.url));
const hasDbus = spawnSync("dbus-run-session", ["--", "true"]).status === 0;
const hasGi = spawnSync("python3", ["-c", "import gi; gi.require_version('Gio', '2.0'); gi.require_version('Gst', '1.0')"]).status === 0;

type Reply = Record<string, unknown>;
type Call = { method: string; args: unknown[] };

describe.skipIf(!hasDbus || !hasGi)("portal helper against a fake portal on a private bus", () => {
  it("asks once, sends input with the right arguments, and reports refusals, timeouts and bad requests", () => {
    const run = spawnSync("dbus-run-session", ["--", "python3", "-I", driver], {
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env, AGENTHOST_REAL_BUS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "" }
    });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;

    // Granted scenario: probe, open (one consent), input, a screenshot the fake cannot serve, close.
    const granted = result.granted as Reply[];
    expect(granted[0]).toMatchObject({ ok: true, availableDeviceTypes: 3, remoteDesktopVersion: 2, screenCastVersion: 5 });
    expect(granted[1]).toMatchObject({ ok: true, devices: 3, streams: [{ node: 42, width: 1920, height: 1080 }] });
    expect(granted.slice(2, 7).every((reply) => reply.ok === true)).toBe(true);
    expect(granted[7]).toMatchObject({ ok: false, code: "portal_error" });
    expect(granted[8]).toMatchObject({ ok: true, closed: true });
    expect(result.shotExists).toBe(false);

    // The calls the fake portal received, in order: the probe's session first, then open's sequence.
    const calls = result.grantedLog as Call[];
    expect(calls.map((call) => call.method)).toEqual([
      "CreateSession", "Close",
      "CreateSession", "SelectDevices", "SelectSources", "Start",
      "NotifyPointerMotionAbsolute", "NotifyPointerButton", "NotifyPointerButton",
      "NotifyKeyboardKeysym", "NotifyKeyboardKeysym",
      "OpenPipeWireRemote", "Close"
    ]);
    const createOptions = calls[0]?.args[0] as Record<string, unknown>;
    expect(createOptions).toHaveProperty("session_handle_token");
    expect(calls.find((call) => call.method === "NotifyPointerMotionAbsolute")?.args.slice(2)).toEqual([42, 100.5, 200]);
    expect(calls.filter((call) => call.method === "NotifyPointerButton").map((call) => call.args.slice(2))).toEqual([[272, 1], [272, 0]]);
    expect(calls.filter((call) => call.method === "NotifyKeyboardKeysym").map((call) => call.args.slice(2))).toEqual([[97, 1], [97, 0]]);

    // Before any open: input is refused. A malformed line and an unknown command do not stop the helper.
    expect((result.beforeOpen as Reply[])[0]).toMatchObject({ ok: false, code: "not_open" });
    const malformed = result.malformed as Reply[];
    expect(malformed[0]).toMatchObject({ ok: false, code: "bad_request" });
    expect(malformed[1]).toMatchObject({ id: 11, ok: false, code: "unknown_command" });

    // Denied scenario: the person says no; the helper closes the session and refuses further input.
    const denied = result.denied as Reply[];
    expect(denied[0]).toMatchObject({ ok: false, code: "consent_denied" });
    expect(denied[1]).toMatchObject({ ok: false, code: "not_open" });
    expect(denied[2]).toMatchObject({ ok: true, closed: true });
    expect((result.deniedLog as Call[]).map((call) => call.method)).toEqual(["CreateSession", "SelectDevices", "SelectSources", "Start", "Close"]);

    // Silent scenario: no answer to Start, so the caller's time limit ends the wait and the session is closed.
    const never = result.never as Reply[];
    expect(never[0]).toMatchObject({ ok: false, code: "portal_timeout" });
    expect(never[1]).toMatchObject({ ok: true, closed: true });
    expect((result.neverLog as Call[]).map((call) => call.method)).toEqual(["CreateSession", "SelectDevices", "SelectSources", "Start", "Close"]);
  }, 240_000);
});
