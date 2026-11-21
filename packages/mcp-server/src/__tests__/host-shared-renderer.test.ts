import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { startHost } from "../host/host.js";
import { HOST_PROTOCOL } from "../host/protocol.js";
import { HeadlessOverlayRenderer, OverlayManager } from "@osseo/app-overlay";
import type { OverlayWidgetEvent } from "@osseo/core";
import { SessionRendererProxy, SharedRendererHub } from "../host/shared-renderer.js";

class CloseCounting extends HeadlessOverlayRenderer {
  closes = 0;
  close(): void { this.closes += 1; }
}

function event(overlayId: string, owner = "x"): OverlayWidgetEvent {
  return { eventId: `e_${Math.random()}`, overlayId, event: "accepted", createdAt: new Date().toISOString(), ownerSessionId: owner };
}
const rec = (overlayId: string) => ({ overlayId, type: "widget", payload: { label: overlayId } });

describe("shared history panel", () => {
  it("draws every session's timeline into one widget, routes its events to the last writer, and keeps it up when another session leaves", async () => {
    const renderer = new HeadlessOverlayRenderer();
    const hub = new SharedRendererHub(renderer, { drainMs: 10_000 });
    const a = hub.proxyFor("h_a");
    const b = hub.proxyFor("h_b");
    const calls: string[] = [];
    vi.spyOn(renderer, "update").mockImplementation((r) => { calls.push(`update ${r.overlayId}`); return calls.length === 1 ? { ok: false, reason: "overlay_not_found" } : { ok: true, reason: "ok" }; });
    vi.spyOn(renderer, "show").mockImplementation((r) => { calls.push(`show ${r.overlayId}`); return { ok: true, reason: "ok", acknowledged: true }; });
    const dismissed: string[] = [];
    vi.spyOn(renderer, "dismiss").mockImplementation((id) => { dismissed.push(id); return { ok: true, reason: "ok" }; });

    await a.show(rec("osseo-timeline-h_a"));
    await b.update(rec("osseo-timeline-h_b"));
    expect(calls).toEqual(["update osseo-timeline-host", "show osseo-timeline-host", "update osseo-timeline-host"]);

    renderer.pushEvent(event("osseo-timeline-host"));
    await hub.drainNow();
    expect(b.drainEvents().map((e) => e.overlayId)).toEqual(["osseo-timeline-h_b"]);
    expect(a.drainEvents()).toEqual([]);

    // The session that is not showing its panel cannot take it down; the one that is, can.
    await a.dismiss("osseo-timeline-h_a");
    expect(dismissed).toEqual([]);
    await hub.release("h_b");
    expect(dismissed).toEqual(["osseo-timeline-host"]);
  });
});

describe("shared renderer hub", () => {
  it("namespaces ids and keeps each session's events and clear() separate", async () => {
    const renderer = new HeadlessOverlayRenderer();
    const hub = new SharedRendererHub(renderer, { drainMs: 10_000 });
    const a = hub.proxyFor("h_a");
    const b = hub.proxyFor("h_b");
    const shown: string[] = [];
    const showSpy = vi.spyOn(renderer, "show").mockImplementation((r) => { shown.push(r.overlayId); return { ok: true, reason: "ok", acknowledged: true }; });
    const dismissed: string[] = [];
    vi.spyOn(renderer, "dismiss").mockImplementation((id) => { dismissed.push(id); return { ok: true, reason: "ok" }; });

    await a.show(rec("card"));
    await b.show(rec("card"));
    expect(shown).toEqual(["h_a::card", "h_b::card"]);
    showSpy.mockRestore();

    renderer.pushEvent(event("h_a::card"));
    renderer.pushEvent(event("h_b::card"));
    renderer.pushEvent(event("h_b::other"));
    await hub.drainNow();
    const aEvents = a.drainEvents();
    const bEvents = b.drainEvents();
    expect(aEvents.map((e) => e.overlayId)).toEqual(["card"]);
    expect(aEvents[0]?.ownerSessionId).toBe("h_a");
    expect(bEvents.map((e) => e.overlayId)).toEqual(["card", "other"]);
    expect(a.drainEvents()).toEqual([]);

    await a.clear();
    expect(dismissed).toEqual(["h_a::card"]);
    await b.dismiss("card");
    expect(dismissed).toEqual(["h_a::card", "h_b::card"]);
    await hub.close();
  });

  it("drops and counts an event for an unknown session", async () => {
    const renderer = new HeadlessOverlayRenderer();
    const hub = new SharedRendererHub(renderer, { drainMs: 10_000 });
    const a = hub.proxyFor("h_a");
    renderer.pushEvent(event("h_gone::card"));
    renderer.pushEvent(event("noprefix"));
    renderer.pushEvent(event("h_a::card"));
    await hub.drainNow();
    expect(hub.droppedEventCount).toBe(2);
    expect(a.drainEvents()).toHaveLength(1);
    await hub.close();
  });

  it("drains the renderer on its own timer", async () => {
    const renderer = new HeadlessOverlayRenderer();
    const hub = new SharedRendererHub(renderer, { drainMs: 20 });
    const a = hub.proxyFor("h_a");
    renderer.pushEvent(event("h_a::card"));
    await vi.waitFor(() => expect(a.events()).toHaveLength(1), { timeout: 2000 });
    await hub.close();
  });

  it("a session close does not close the renderer; release removes only that session's cards", async () => {
    const renderer = new CloseCounting();
    const hub = new SharedRendererHub(renderer, { drainMs: 10_000 });
    const a = hub.proxyFor("h_a");
    const b = hub.proxyFor("h_b");
    const dismissed: string[] = [];
    vi.spyOn(renderer, "dismiss").mockImplementation((id) => { dismissed.push(id); return { ok: true, reason: "ok" }; });
    await a.show(rec("c1"));
    await b.show(rec("c2"));
    await a.close();
    await hub.release("h_a");
    expect(dismissed).toEqual(["h_a::c1"]);
    expect(hub.sessionCount).toBe(1);
    expect(hub.closed).toBe(false);
    expect(renderer.closes).toBe(0);
    await hub.close();
    expect(hub.closed).toBe(true);
    expect(renderer.closes).toBe(1);
  });

  it("emergencyHide and restart are global", async () => {
    const renderer = new HeadlessOverlayRenderer();
    const hide = vi.spyOn(renderer, "emergencyHide");
    const hub = new SharedRendererHub(renderer, { drainMs: 10_000 });
    const a = hub.proxyFor("h_a");
    const b = hub.proxyFor("h_b");
    await b.show(rec("c2"));
    await a.emergencyHide();
    expect(hide).toHaveBeenCalledTimes(1);
    const dismissed: string[] = [];
    vi.spyOn(renderer, "dismiss").mockImplementation((id) => { dismissed.push(id); return { ok: true, reason: "ok" }; });
    await b.clear();
    expect(dismissed).toEqual([]);
    expect((await a.restart()).ok).toBe(false);
    expect(await a.capabilities()).toBe(renderer.capabilities());
    await hub.close();
  });

  it("works under an OverlayManager per session", async () => {
    const renderer = new HeadlessOverlayRenderer();
    const hub = new SharedRendererHub(renderer, { drainMs: 10_000 });
    const mA = new OverlayManager(hub.proxyFor("h_a"), { sessionId: "h_a" });
    const mB = new OverlayManager(hub.proxyFor("h_b"), { sessionId: "h_b" });
    await mA.close();
    await mB.close();
    expect(hub.closed).toBe(false);
    await hub.close();
  });

  it("rejects a session id that would break the prefix", () => {
    const hub = new SharedRendererHub(new HeadlessOverlayRenderer());
    expect(() => hub.proxyFor("a::b")).toThrow("invalid_session_id");
  });
});

describe("host wiring", () => {
  async function connect(home: string): Promise<{ welcome: Promise<unknown>; close: () => void }> {
    const { hostPaths } = await import("../host/socket.js");
    const socket = net.connect(hostPaths(home).socket);
    const welcome = new Promise<unknown>((resolve) => {
      let buf = "";
      socket.on("data", (c) => { buf += c.toString(); if (buf.includes("\n")) resolve(JSON.parse(buf.split("\n")[0] ?? "{}")); });
    });
    socket.write(`${JSON.stringify({ hello: { protocol: HOST_PROTOCOL, client: "t" } })}\n`);
    return { welcome, close: () => socket.destroy() };
  }

  it("passes each session a proxy and closes the renderer only when the host exits", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ah-shr-"));
    const renderer = new CloseCounting();
    const seen: unknown[] = [];
    const host = await startHost({
      agentHome: home, idleExitMs: 60_000, createRenderer: () => renderer,
      createSession: async (_t, info) => { seen.push(info.overlayRenderer); return { close: async () => undefined, isStateChanging: () => false }; }
    });
    try {
      const one = await connect(home); const two = await connect(home);
      await Promise.all([one.welcome, two.welcome]);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBeInstanceOf(SessionRendererProxy);
      expect(seen[0]).not.toBe(seen[1]);
      one.close();
      await vi.waitFor(() => expect(host.sessionCount()).toBe(1));
      expect(renderer.closes).toBe(0);
      two.close();
    } finally {
      await host.close();
      rmSync(home, { recursive: true, force: true });
    }
    expect(renderer.closes).toBe(1);
  });

  it("without a renderer factory (custom sessions) no shared renderer is passed, so server.ts builds its own", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "ah-shr-"));
    const seen: unknown[] = ["unset"];
    const host = await startHost({
      agentHome: home, idleExitMs: 60_000,
      createSession: async (_t, info) => { seen[0] = info.overlayRenderer; return { close: async () => undefined, isStateChanging: () => false }; }
    });
    try {
      const c = await connect(home);
      await c.welcome;
      expect(seen[0]).toBeUndefined();
      c.close();
    } finally {
      await host.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
