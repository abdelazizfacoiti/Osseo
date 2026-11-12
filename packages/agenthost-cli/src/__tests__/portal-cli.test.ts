import { PortalError } from "@agenthost/os-linux";
import { describe, expect, it } from "vitest";
import { portalCommand, type PortalCheckSession } from "../portal.js";

const PROBE = { availableDeviceTypes: 3, remoteDesktopVersion: 2, availableSourceTypes: 7, screenCastVersion: 5, sessionCreated: true };

/** A session stand-in that records what the check does, in order. */
function fakeSession(overrides: Partial<PortalCheckSession> = {}) {
  const calls: string[] = [];
  const session: PortalCheckSession = {
    probe: async () => {
      calls.push("probe");
      return PROBE;
    },
    open: async (input) => {
      calls.push(`open:${input.keyboard === true}:${input.pointer === true}:${input.screen === true}`);
      return { devices: 3, streams: [{ node: 42, x: 0, y: 0, width: 1920, height: 1080 }] };
    },
    close: async () => {
      calls.push("close");
    },
    ...overrides
  };
  return { calls, session };
}

const wayland = { XDG_SESSION_TYPE: "wayland" };

describe("agenthost portal check", () => {
  it("probes without asking the person, then closes the session", async () => {
    const fake = fakeSession();
    const out = await portalCommand(["check"], { createSession: () => fake.session, env: wayland });
    expect(out).toMatchObject({ ok: true, command: "portal check", data: { mode: "probe", portal: PROBE } });
    expect(fake.calls).toEqual(["probe", "close"]);
  });

  it("with --start asks once, reports the granted screen, and closes", async () => {
    const fake = fakeSession();
    const out = await portalCommand(["check", "--start"], { createSession: () => fake.session, env: wayland });
    expect(out).toMatchObject({
      ok: true,
      command: "portal check --start",
      data: { mode: "start", consent: "granted", devices: 3, streams: [{ node: 42, width: 1920, height: 1080 }] }
    });
    expect(fake.calls).toEqual(["probe", "open:true:true:true", "close"]);
  });

  it("reports a refused consent as an error, and still closes the session", async () => {
    const fake = fakeSession({
      open: async () => {
        throw new PortalError("consent_denied", "The person did not allow remote control.");
      }
    });
    const out = await portalCommand(["check", "--start"], { createSession: () => fake.session, env: wayland });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("consent_denied: The person did not allow remote control.");
    expect(fake.calls.at(-1)).toBe("close");
  });

  it("warns on a session that is not Wayland, and prints usage for an unknown action", async () => {
    const fake = fakeSession();
    const out = await portalCommand(["check"], { createSession: () => fake.session, env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" } });
    expect(out.ok).toBe(true);
    expect(out.warnings?.[0]).toContain("not a Wayland session");
    const usage = await portalCommand(["open"], { createSession: () => fake.session, env: wayland });
    expect(usage).toMatchObject({ ok: false, error: "usage: agenthost portal check [--start]" });
  });
});
