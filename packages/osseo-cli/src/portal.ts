import { PortalError, PortalSession, isWaylandSession, type PortalOpenResult, type PortalProbeResult } from "@osseo/os-linux";

/*
 * `osseo portal check [--start]`: shows whether the desktop portal answers on this session.
 * Without --start it reads the portal's properties and creates and closes one session. It shows no dialog.
 * With --start it asks the person once, through the portal's own dialog, opens keyboard, pointer and screen,
 * reports the granted screen stream, and closes the session again. Run it on a Wayland login before setting
 * OSSEO_WAYLAND_PORTAL=1 for an MCP client.
 */

type Output = { ok: boolean; command: string; data?: unknown; error?: string; warnings?: string[] };

export interface PortalCheckSession {
  probe(): Promise<PortalProbeResult>;
  open(input: { keyboard?: boolean; pointer?: boolean; screen?: boolean; timeoutMs?: number }): Promise<PortalOpenResult>;
  close(): Promise<void>;
}

export interface PortalCheckDeps {
  createSession?: () => PortalCheckSession;
  env?: NodeJS.ProcessEnv;
}

export async function portalCommand(args: string[], deps: PortalCheckDeps = {}): Promise<Output> {
  const action = args.find((item) => !item.startsWith("--")) ?? "check";
  if (action !== "check") return { ok: false, command: "portal", error: "usage: osseo portal check [--start]" };
  const start = args.includes("--start");
  const command = start ? "portal check --start" : "portal check";
  const env = deps.env ?? process.env;
  const warnings: string[] = [];
  if (!isWaylandSession(env)) {
    warnings.push("This is not a Wayland session (XDG_SESSION_TYPE is not wayland), so the portal may not answer. The check reports what it says.");
  }
  const session: PortalCheckSession = deps.createSession ? deps.createSession() : new PortalSession();
  try {
    const portal = await session.probe();
    if (!start) {
      return { ok: true, command, data: { mode: "probe", portal, consent: "not asked; run with --start to ask" }, warnings };
    }
    const opened = await session.open({ keyboard: true, pointer: true, screen: true });
    return { ok: true, command, data: { mode: "start", portal, consent: "granted", devices: opened.devices, streams: opened.streams }, warnings };
  } catch (error) {
    const code = error instanceof PortalError ? error.code : "portal_error";
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, command, error: `${code}: ${message}`, ...(warnings.length === 0 ? {} : { warnings }) };
  } finally {
    await session.close().catch(() => undefined);
  }
}
