import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PortalError, PortalSession } from "../portal/portal-session.js";

/*
 * PortalSession talks JSON lines to portal_helper.py. These tests run a small Python stand-in for the helper
 * (no DBus, no portal): it answers the same reply shapes, so the session's own logic is what is tested.
 * Each test picks a FAKE_MODE: grant, deny (first open refused, later opens would be granted), never (no answer
 * to open), silent (no answer to pointer_motion), or exit (the helper exits on probe).
 */

const hasPython = spawnSync("python3", ["--version"]).status === 0;

const STAND_IN = `
import json, os, sys
mode = os.environ.get("FAKE_MODE", "grant")
opens = 0
granted = False

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

emit({"event": "ready"})
for raw in sys.stdin:
    cmd = json.loads(raw)
    ident = cmd.get("id")
    name = cmd.get("cmd")
    if name == "probe":
        if mode == "exit":
            sys.exit(3)
        emit({"id": ident, "ok": True, "availableDeviceTypes": 3, "remoteDesktopVersion": 2, "availableSourceTypes": 7, "screenCastVersion": 5, "sessionCreated": True})
    elif name == "open":
        opens += 1
        if mode == "never":
            continue
        if mode == "deny" and opens == 1:
            emit({"id": ident, "ok": False, "code": "consent_denied", "message": "The person did not allow remote control."})
        elif granted:
            emit({"id": ident, "ok": False, "code": "already_open", "message": "A session is already open."})
        else:
            granted = True
            emit({"id": ident, "ok": True, "devices": 3, "streams": [{"node": 42, "x": 0, "y": 0, "width": 1920, "height": 1080}]})
    elif name == "pointer_motion" and mode == "silent":
        continue
    elif name == "pointer_button" and cmd.get("button") not in (272, 273, 274):
        emit({"id": ident, "ok": False, "code": "bad_args", "message": "unknown button"})
    elif name == "pointer_motion" and cmd.get("node") != 42:
        emit({"id": ident, "ok": False, "code": "bad_args", "message": "unknown node"})
    elif name == "screenshot":
        emit({"id": ident, "ok": True, "path": cmd["path"], "bytesWritten": 12, "format": cmd["format"]})
    elif name == "close":
        emit({"id": ident, "ok": True, "closed": True})
        break
    else:
        emit({"id": ident, "ok": True})
`;

const dir = mkdtempSync(path.join(os.tmpdir(), "osseo-portal-standin-"));
const helperPath = path.join(dir, "stand_in_helper.py");
writeFileSync(helperPath, STAND_IN);

function session(mode: string, requestTimeoutMs = 4000): PortalSession {
  return new PortalSession({ python: "python3", helperPath, env: { ...process.env, FAKE_MODE: mode }, requestTimeoutMs });
}

describe.skipIf(!hasPython)("PortalSession against a stand-in helper", () => {
  it("reads the probe reply", async () => {
    const portal = session("grant");
    try {
      expect(await portal.probe()).toEqual({
        availableDeviceTypes: 3,
        remoteDesktopVersion: 2,
        availableSourceTypes: 7,
        screenCastVersion: 5,
        sessionCreated: true
      });
    } finally {
      await portal.close();
    }
  });

  it("asks once: later opens return the same grant without asking again", async () => {
    const portal = session("grant");
    try {
      const first = await portal.open({ screen: true });
      expect(first.streams).toEqual([{ node: 42, x: 0, y: 0, width: 1920, height: 1080 }]);
      expect(portal.isOpen).toBe(true);
      expect(portal.streams[0]?.node).toBe(42);
      const second = await portal.open({ screen: true });
      expect(second).toEqual(first);
    } finally {
      await portal.close();
    }
    expect(portal.isOpen).toBe(false);
  });

  it("sends input and capture requests the helper accepts, and turns a refusal into a PortalError", async () => {
    const portal = session("grant");
    try {
      await portal.open();
      await expect(portal.pointerMotion(42, 10.5, 20)).resolves.toBeUndefined();
      await expect(portal.pointerButton(272, true)).resolves.toBeUndefined();
      await expect(portal.keysym(0x61, false)).resolves.toBeUndefined();
      const saved = await portal.screenshot({ path: path.join(dir, "shot.png"), format: "png" });
      expect(saved).toEqual({ path: path.join(dir, "shot.png"), bytesWritten: 12, format: "png" });
      const refused = await portal.pointerButton(999, true).then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(PortalError);
      expect((refused as PortalError).code).toBe("bad_args");
    } finally {
      await portal.close();
    }
  });

  it("keeps a refusal for the rest of the session and does not ask again", async () => {
    const portal = session("deny");
    try {
      const first = await portal.open().then(() => undefined, (error: unknown) => error as PortalError);
      expect(first?.code).toBe("consent_denied");
      expect(portal.declined).toBe(true);
      const second = await portal.open().then(() => undefined, (error: unknown) => error as PortalError);
      expect(second?.code).toBe("consent_denied");
      expect(portal.isOpen).toBe(false);
    } finally {
      await portal.close();
    }
  });

  it("times out an open the person never answers", async () => {
    const portal = session("never", 1000);
    try {
      const error = await portal.open({ timeoutMs: 300 }).then(() => undefined, (failure: unknown) => failure as PortalError);
      expect(error?.code).toBe("portal_timeout");
      expect(portal.isOpen).toBe(false);
    } finally {
      await portal.close();
    }
  });

  it("replaces a helper that stops answering and drops the session with it", async () => {
    const portal = session("silent", 500);
    try {
      await portal.open();
      const error = await portal.pointerMotion(42, 1, 1).then(() => undefined, (failure: unknown) => failure as PortalError);
      expect(error?.code).toBe("portal_timeout");
      expect(portal.isOpen).toBe(false);
    } finally {
      await portal.close();
    }
  });

  it("reports a helper that exits instead of hanging", async () => {
    const portal = session("exit");
    try {
      const error = await portal.probe().then(() => undefined, (failure: unknown) => failure as PortalError);
      expect(error?.code).toBe("helper_exited");
      expect(error?.message).toContain("exited");
    } finally {
      await portal.close();
    }
  });
});
